/**
 * Phase 8B.5A Milestone 2 — Live Disposable PostgreSQL 17 AuthRepository & Concurrency Integration Tests
 *
 * Exercises real PostgreSQL 17 runtime behavior:
 * 1. Strict least-privilege 4-column INSERT on `studexo.users` by `studexo_app` role.
 * 2. Atomic multi-table insertion across `users`, `auth_identities`, and `account_settings`.
 * 3. Concurrent dual-first-login serialization: simultaneous provisioning of different UUIDs
 *    claiming the same normalized email address serializes via canonical advisory locking,
 *    guaranteeing exactly 1 successful provision and 1 collision rejection (HTTP 409).
 * 4. Pre-insert purge protection: rejects provisioning when identity is pending purge.
 * 5. Display-name truncation: safely bounds display_name to <= 160 characters.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import type { StudexoDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema/index';
import {
  createPostgresAuthRepository,
  type AuthRepository,
  type ProvisionUserParams,
} from '../src/server/modules/auth/auth.repository';
import { createAuthService } from '../src/server/modules/auth/auth.service';
import { MockTokenVerifier } from '../src/server/modules/auth/tokenVerifier';
import { AuthError } from '../src/shared/types/auth';

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

describe.skipIf(!TEST_POSTGRES_URL)(
  'Phase 8B.5A Milestone 2 — Live Disposable PostgreSQL 17 AuthRepository Integration Suite',
  () => {
    let adminSql: Sql;
    let appSql: Sql;
    let appDb: StudexoDatabase;
    let appRepo: AuthRepository;

    let secondAppSql: Sql;
    let secondAppDb: StudexoDatabase;
    let secondAppRepo: AuthRepository;

    let testRolePassword: string;

    function assertDisposableTestDatabaseUrl(rawUrl: string): void {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        rawUrl.includes('yxhqqdbywxjhcejdmtkq') ||
        host.endsWith('.supabase.co') ||
        host.endsWith('.pooler.supabase.com')
      ) {
        throw new Error(
          'Refusing to run destructive concurrency tests against a Supabase staging or production host.',
        );
      }
    }

    async function setupSchemaAndRoles() {
      const sqlFiles = [
        '0000_init_studexo_mvp.sql',
        '0001_studexo_integrity_triggers_and_extensions.sql',
        '0002_studexo_user_insert_and_file_rollback_guards.sql',
        '0003_studexo_schema_lockout_and_outbox_guard.sql',
        '0004_fenced_account_purge.sql',
        '0005_fenced_account_purge_equality.sql',
      ];

      await adminSql.unsafe(`
        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_migrator') THEN
            CREATE ROLE studexo_migrator LOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_purge_owner') THEN
            CREATE ROLE studexo_purge_owner NOLOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_app') THEN
            CREATE ROLE studexo_app LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          ELSE
            ALTER ROLE studexo_app WITH LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_purge_worker') THEN
            CREATE ROLE studexo_purge_worker LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          ELSE
            ALTER ROLE studexo_purge_worker WITH LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_catalog_admin') THEN
            CREATE ROLE studexo_catalog_admin NOLOGIN NOINHERIT;
          END IF;
        END $$;
        CREATE SCHEMA IF NOT EXISTS studexo AUTHORIZATION studexo_migrator;
        CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION studexo_migrator;
        GRANT USAGE ON SCHEMA extensions TO studexo_migrator, studexo_app, studexo_purge_worker, studexo_catalog_admin;
      `);

      const migratedRows = await adminSql<{ alreadyMigrated: boolean }[]>`
        SELECT to_regclass('studexo.users') IS NOT NULL AS "alreadyMigrated"
      `;
      const alreadyMigrated = Boolean(migratedRows[0]?.alreadyMigrated);

      if (!alreadyMigrated) {
        await adminSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
          for (const fileName of sqlFiles) {
            const raw = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', fileName), 'utf8');
            const statements = raw.split('--> statement-breakpoint');
            for (const stmt of statements) {
              const trimmed = stmt.trim();
              if (trimmed) {
                await tx.unsafe(trimmed);
              }
            }
          }
        });
      }

      // Step 4: Lock down purge function ACLs, grant worker execution, transfer ownership
      await adminSql.unsafe(`
        REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) FROM PUBLIC, studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) TO studexo_purge_worker;
        GRANT USAGE, CREATE ON SCHEMA studexo TO studexo_purge_owner;
        ALTER FUNCTION studexo.execute_account_purge(uuid, varchar, integer) OWNER TO studexo_purge_owner;
        REVOKE CREATE ON SCHEMA studexo FROM studexo_purge_owner;
        GRANT USAGE ON SCHEMA studexo TO studexo_purge_owner;

        -- Step 5: purge owner grants
        GRANT SELECT, UPDATE, DELETE ON studexo.users TO studexo_purge_owner;
        GRANT SELECT, UPDATE, DELETE ON studexo.auth_identities, studexo.account_settings TO studexo_purge_owner;
        GRANT INSERT, SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_owner;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_owner;

        -- Step 6: exact studexo_app privileges from docs/DATABASE_ROLES.md
        REVOKE CREATE ON SCHEMA studexo FROM PUBLIC, studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;
        GRANT USAGE ON SCHEMA studexo TO studexo_app;
        REVOKE ALL ON studexo.users FROM PUBLIC, studexo_app;
        GRANT SELECT ON studexo.users TO studexo_app;
        GRANT INSERT (
          id,
          supabase_auth_user_id,
          primary_email,
          display_name
        ) ON studexo.users TO studexo_app;
        GRANT UPDATE (
          primary_email,
          display_name,
          status,
          deletion_requested_at,
          deletion_scheduled_for,
          updated_at
        ) ON studexo.users TO studexo_app;

        REVOKE ALL ON FUNCTION studexo.is_auth_user_pending_purge(uuid) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          studexo.auth_identities,
          studexo.account_settings
        TO studexo_app;
        REVOKE ALL ON studexo.external_identity_purge_outbox FROM studexo_app;
      `);
    }

    beforeAll(async () => {
      assertDisposableTestDatabaseUrl(TEST_POSTGRES_URL!);
      testRolePassword = crypto.randomBytes(16).toString('hex');
      adminSql = postgres(TEST_POSTGRES_URL!, { prepare: false, max: 5 });
      await setupSchemaAndRoles();

      const appUrl = new URL(TEST_POSTGRES_URL!);
      appUrl.username = 'studexo_app';
      appUrl.password = testRolePassword;

      appSql = postgres(appUrl.toString(), { prepare: false, max: 3 });
      appDb = drizzle(appSql, { schema });
      appRepo = createPostgresAuthRepository(appDb);

      secondAppSql = postgres(appUrl.toString(), { prepare: false, max: 3 });
      secondAppDb = drizzle(secondAppSql, { schema });
      secondAppRepo = createPostgresAuthRepository(secondAppDb);
    });

    afterAll(async () => {
      await secondAppSql?.end({ timeout: 5 });
      await appSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    });

    it('provisions a normal student user via studexo_app role honoring schema defaults', async () => {
      const sub = crypto.randomUUID();
      const email = `student_${Date.now()}@studexo.example.com`;

      const params: ProvisionUserParams = {
        supabaseAuthUserId: sub,
        primaryEmail: email,
        displayName: 'Postgres Student',
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: sub,
            emailAtProvider: email,
            emailVerified: true,
          },
        ],
        preferredLocale: 'en',
        preferredCurrency: 'USD',
        timezone: 'Asia/Dhaka',
      };

      const result = await appRepo.provisionUserAtomic(params);

      expect(result.user.supabaseAuthUserId).toBe(sub);
      expect(result.user.primaryEmail).toBe(email);
      expect(result.user.displayName).toBe('Postgres Student');
      expect(result.user.role).toBe('student'); // PostgreSQL schema default applied
      expect(result.user.status).toBe('active'); // PostgreSQL schema default applied
      expect(result.user.purgeState).toBe('none'); // PostgreSQL schema default applied
      expect(result.identities).toHaveLength(1);
      expect(result.settings?.timezone).toBe('Asia/Dhaka');

      // Verify row in database via studexo_app SELECT
      const found = await appRepo.findUserBySupabaseAuthId(sub);
      expect(found).not.toBeNull();
      expect(found?.user.id).toBe(result.user.id);

      // Verify nullable display_name works cleanly on the 4-column INSERT
      const nullNameSub = crypto.randomUUID();
      const nullNameEmail = `nullname_${Date.now()}@studexo.example.com`;
      const nullNameResult = await appRepo.provisionUserAtomic({
        supabaseAuthUserId: nullNameSub,
        primaryEmail: nullNameEmail,
        displayName: null,
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: nullNameSub,
            emailAtProvider: nullNameEmail,
            emailVerified: true,
          },
        ],
      });
      expect(nullNameResult.user.displayName).toBeNull();
      expect(nullNameResult.user.role).toBe('student');
    });

    it('enforces least-privilege boundary: studexo_app INSERT naming restricted columns fails with SQLSTATE 42501', async () => {
      let capturedCode: string | undefined;
      try {
        await appSql`
          INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name, role)
          VALUES (${crypto.randomUUID()}::uuid, ${crypto.randomUUID()}::uuid, ${`blocked_${Date.now()}@studexo.example.com`}, 'Blocked', 'student')
        `;
      } catch (err) {
        capturedCode = (err as { code?: string }).code;
      }
      expect(capturedCode).toBe('42501');
    });

    it('guarantees email concurrency safety: simultaneous first-logins from different UUIDs for the same email serialize and reject collision', async () => {
      const subA = crypto.randomUUID();
      const subB = crypto.randomUUID();
      const sharedEmail = `race_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@studexo.example.com`;

      const paramsA: ProvisionUserParams = {
        supabaseAuthUserId: subA,
        primaryEmail: sharedEmail,
        displayName: 'Competitor A',
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: subA,
            emailAtProvider: sharedEmail,
            emailVerified: true,
          },
        ],
      };

      const paramsB: ProvisionUserParams = {
        supabaseAuthUserId: subB,
        primaryEmail: sharedEmail,
        displayName: 'Competitor B',
        identities: [
          {
            provider: 'google',
            providerSubject: `google-sub-${subB}`,
            emailAtProvider: sharedEmail,
            emailVerified: true,
          },
        ],
      };

      // Fire parallel requests across two separate PostgreSQL connections as studexo_app
      const [resA, resB] = await Promise.allSettled([
        appRepo.provisionUserAtomic(paramsA),
        secondAppRepo.provisionUserAtomic(paramsB),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason as AuthError;
      expect(rejectedError).toBeInstanceOf(AuthError);
      expect(rejectedError.code).toBe('AUTH_IDENTITY_COLLISION');
      expect(rejectedError.statusCode).toBe(409);

      // Verify that exactly 1 user row exists with this email in PostgreSQL
      const userRows = await appSql<{ id: string; supabase_auth_user_id: string }[]>`
        SELECT id, supabase_auth_user_id
        FROM studexo.users
        WHERE primary_email = ${sharedEmail.toLowerCase()}
      `;
      expect(userRows).toHaveLength(1);
    });

    it('blocks provisioning when external identity has an active account purge', async () => {
      const purgingSub = crypto.randomUUID();
      const email = `purging_${Date.now()}@studexo.example.com`;

      // Seed an unpurged outbox item as admin (studexo_purge_owner)
      await adminSql`
        INSERT INTO studexo.external_identity_purge_outbox (
          id, former_user_id, supabase_auth_user_id, status, attempt_count, max_attempts, next_attempt_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${crypto.randomUUID()}::uuid,
          ${purgingSub}::uuid,
          'pending_purge',
          0,
          10,
          pg_catalog.now()
        )
      `;

      // Confirm is_auth_user_pending_purge returns true for studexo_app
      const isPending = await appRepo.checkIsAuthUserPendingPurge(purgingSub);
      expect(isPending).toBe(true);

      const params: ProvisionUserParams = {
        supabaseAuthUserId: purgingSub,
        primaryEmail: email,
        displayName: 'Purge Student',
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: purgingSub,
            emailAtProvider: email,
            emailVerified: true,
          },
        ],
      };

      await expect(appRepo.provisionUserAtomic(params)).rejects.toThrowError(AuthError);
      try {
        await appRepo.provisionUserAtomic(params);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_PURGE_IN_PROGRESS');
        expect(authErr.statusCode).toBe(403);
      }
    });

    it('defensively truncates display name exceeding the database 160-character limit without SQLSTATE 22001 (Unicode-safe)', async () => {
      const sub = crypto.randomUUID();
      const email = `longname_${Date.now()}@studexo.example.com`;
      // 159 ASCII chars + 1 surrogate pair emoji (🎉) + extra characters
      const overlyLongName = 'A'.repeat(159) + '🎉' + 'Extra'.repeat(20);

      const params: ProvisionUserParams = {
        supabaseAuthUserId: sub,
        primaryEmail: email,
        displayName: overlyLongName,
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: sub,
            emailAtProvider: email,
            emailVerified: true,
          },
        ],
      };

      const result = await appRepo.provisionUserAtomic(params);
      expect(result.user.displayName).not.toBeNull();
      // Exactly 160 Unicode code points (PostgreSQL varchar(160) limit)
      expect(Array.from(result.user.displayName!)).toHaveLength(160);
      expect(result.user.displayName!.endsWith('🎉')).toBe(true);
    });

    describe('Milestone 4 — Live PostgreSQL 17 HTTP End-to-End (/api/auth/sync & /api/auth/me)', () => {
      it('executes full HTTP onboarding, returning sync, concurrent same-email collision, purge block, and status guards against PostgreSQL 17 as studexo_app', async () => {
        const mockVerifier = new MockTokenVerifier();
        const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
        const { app } = createApp({
          env,
          checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
          authDependencies: {
            tokenVerifier: mockVerifier,
            authService: createAuthService(appRepo),
          },
        });

        const sub = crypto.randomUUID();
        const email = `e2e_pg_${Date.now()}@studexo.example.com`;
        const token = mockVerifier.mintToken({ sub, email });

        // 1. Unprovisioned GET /api/auth/me -> 404
        const beforeMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(beforeMe.status).toBe(404);
        expect(beforeMe.body.error.code).toBe('AUTH_IDENTITY_NOT_FOUND');

        // 2. First-time POST /api/auth/sync -> 200 (real DB defaults role='student', status='active')
        const firstSync = await request(app)
          .post('/api/auth/sync')
          .set('Authorization', `Bearer ${token}`)
          .send({
            displayName: 'PG E2E Student',
            preferredLocale: 'en',
            preferredCurrency: 'USD',
            timezone: 'Asia/Dhaka',
          });
        expect(firstSync.status).toBe(200);
        expect(firstSync.body.user.role).toBe('student');
        expect(firstSync.body.user.status).toBe('active');
        expect(firstSync.body.user.supabaseAuthUserId).toBeUndefined();

        // 3. Authenticated GET /api/auth/me -> 200
        const afterMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(afterMe.status).toBe(200);
        expect(afterMe.body.user.id).toBe(firstSync.body.user.id);

        // 4. Concurrent HTTP POST /api/auth/sync from two different UUIDs claiming the same email
        const raceSubA = crypto.randomUUID();
        const raceSubB = crypto.randomUUID();
        const sharedEmail = `e2e_race_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@studexo.example.com`;
        const raceTokenA = mockVerifier.mintToken({ sub: raceSubA, email: sharedEmail });
        const raceTokenB = mockVerifier.mintToken({ sub: raceSubB, email: sharedEmail });

        const [raceResA, raceResB] = await Promise.all([
          request(app).post('/api/auth/sync').set('Authorization', `Bearer ${raceTokenA}`),
          request(app).post('/api/auth/sync').set('Authorization', `Bearer ${raceTokenB}`),
        ]);
        expect([raceResA.status, raceResB.status].sort()).toEqual([200, 409]);

        const raceRows = await appSql<{ id: string }[]>`
          SELECT id FROM studexo.users WHERE primary_email = ${sharedEmail.toLowerCase()}
        `;
        expect(raceRows).toHaveLength(1);

        // 5. Outbox purge entry blocks HTTP POST /api/auth/sync with 403 AUTH_PURGE_IN_PROGRESS
        const purgedSub = crypto.randomUUID();
        await adminSql`
          INSERT INTO studexo.external_identity_purge_outbox (
            id, former_user_id, supabase_auth_user_id, status, attempt_count, max_attempts, next_attempt_at
          ) VALUES (
            ${crypto.randomUUID()}::uuid,
            ${crypto.randomUUID()}::uuid,
            ${purgedSub}::uuid,
            'pending_purge',
            0,
            10,
            pg_catalog.now()
          )
        `;
        const purgedToken = mockVerifier.mintToken({
          sub: purgedSub,
          email: `purged_e2e_${Date.now()}@studexo.example.com`,
        });
        const purgedSync = await request(app)
          .post('/api/auth/sync')
          .set('Authorization', `Bearer ${purgedToken}`);
        expect(purgedSync.status).toBe(403);
        expect(purgedSync.body.error.code).toBe('AUTH_PURGE_IN_PROGRESS');

        // 6. Account suspension in DB blocks GET /api/auth/me with 403 AUTH_USER_SUSPENDED
        await adminSql`
          UPDATE studexo.users SET status = 'suspended' WHERE id = ${firstSync.body.user.id}::uuid
        `;
        const suspendedMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(suspendedMe.status).toBe(403);
        expect(suspendedMe.body.error.code).toBe('AUTH_USER_SUSPENDED');
      });
    });
  },
);
