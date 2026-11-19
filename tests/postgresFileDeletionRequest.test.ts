import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudexoDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema/index';
import { createPostgresFileDeletionRequestRepository } from '../src/server/modules/lifecycle/postgresFileDeletionRequestRepository';
import {
  createPostgresFilePurgeWorkerRepository,
  STORED_FILE_LIFECYCLE_COLUMNS,
} from '../src/server/modules/lifecycle/postgresFilePurgeRepository';
import {
  processPendingStoredFileDeletion,
  requestDraftStoredFileDeletion,
  type StoredFileLifecycleRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';

const STEP_6_GRANTED_STORED_FILES_UPDATE_COLUMNS = new Set([
  'original_filename',
  'mime_type',
  'byte_size',
  'sha256_checksum',
  'upload_status',
  'uploaded_at',
  'updated_at',
]);

interface CapturedQuery {
  op: 'select' | 'execute';
  sql: string;
  params: unknown[];
}

function createMockFileRow(
  overrides: Partial<StoredFileLifecycleRecord> = {},
): StoredFileLifecycleRecord {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    ownerUserId: overrides.ownerUserId ?? '22222222-2222-4222-8222-222222222222',
    storageBucket: overrides.storageBucket ?? 'student-documents',
    objectKey: overrides.objectKey ?? 'users/22222222-2222-4222-8222-222222222222/cv.pdf',
    uploadStatus: overrides.uploadStatus ?? 'verified',
    purgeState: overrides.purgeState ?? 'none',
    deletedAt: overrides.deletedAt ?? null,
    deletedByUserId: overrides.deletedByUserId ?? null,
    purgedAt: overrides.purgedAt ?? null,
    purgeAttempts: overrides.purgeAttempts ?? 0,
    purgeLeaseUntil: overrides.purgeLeaseUntil ?? null,
    lastPurgeError: overrides.lastPurgeError ?? null,
  };
}

function createOfflineDeletionRequestHarness(options: {
  initialFile?: StoredFileLifecycleRecord | null;
  executeResult?: StoredFileLifecycleRecord | null;
  executeError?: unknown;
}) {
  const dialect = new PgDialect();
  let currentFile = options.initialFile ? { ...options.initialFile } : null;
  const queries: CapturedQuery[] = [];
  const isolations: string[] = [];

  const mockDb = {
    select: (projection: Record<string, unknown>) => ({
      from: (_table: unknown) => ({
        where: (whereExpr: SQL) => ({
          limit: async (_n: number) => {
            const compiled = dialect.sqlToQuery(whereExpr);
            const selectedColumns = Object.values(projection).map((col) => {
              const colObj = col as { name?: string };
              return colObj.name ?? String(col);
            });
            queries.push({
              op: 'select',
              sql: `SELECT ${selectedColumns.join(', ')} FROM studexo.stored_files WHERE ${compiled.sql} LIMIT 1`,
              params: compiled.params,
            });

            if (
              !currentFile ||
              !compiled.params.includes(currentFile.id) ||
              !compiled.params.includes(currentFile.ownerUserId)
            ) {
              return [];
            }

            return [{ ...currentFile }];
          },
        }),
      }),
    }),
    transaction: async <T>(
      fn: (tx: { execute: (query: SQL) => Promise<unknown[]> }) => Promise<T>,
      config?: { isolationLevel?: string },
    ): Promise<T> => {
      isolations.push(config?.isolationLevel ?? 'default');
      const tx = {
        execute: async (query: SQL) => {
          const compiled = dialect.sqlToQuery(query);
          queries.push({
            op: 'execute',
            sql: compiled.sql,
            params: compiled.params,
          });
          if (options.executeError !== undefined) {
            throw options.executeError;
          }
          if (options.executeResult !== undefined) {
            currentFile = options.executeResult ? { ...options.executeResult } : null;
            return options.executeResult ? [{ ...options.executeResult }] : [];
          }
          if (!currentFile) {
            return [];
          }
          const updated: StoredFileLifecycleRecord = {
            ...currentFile,
            purgeState: 'pending_purge',
            deletedByUserId: String(compiled.params[1] ?? currentFile.ownerUserId),
          };
          currentFile = updated;
          return [updated];
        },
      };
      return fn(tx);
    },
  };

  return {
    db: mockDb as unknown as StudexoDatabase,
    queries,
    isolations,
    getCurrentFile: () => currentFile,
  };
}

describe('Phase 8B.4B — Concrete PostgreSQL FileDeletionRequestRepository (Offline Unit Suite)', () => {
  it('projects the explicit 12 STORED_FILE_LIFECYCLE_COLUMNS and never issues direct UPDATE on protected stored_files columns', async () => {
    const projectedDbColumns = Object.values(STORED_FILE_LIFECYCLE_COLUMNS).map(
      (col) => col.name,
    );
    expect(projectedDbColumns).toEqual([
      'id',
      'owner_user_id',
      'storage_bucket',
      'object_key',
      'upload_status',
      'purge_state',
      'deleted_at',
      'deleted_by_user_id',
      'purged_at',
      'purge_attempts',
      'purge_lease_until',
      'last_purge_error',
    ]);

    // Step 6 grants studexo_app no direct UPDATE on purge_state, deleted_by_user_id, or purge_requested_at
    expect(STEP_6_GRANTED_STORED_FILES_UPDATE_COLUMNS.has('purge_state')).toBe(false);
    expect(STEP_6_GRANTED_STORED_FILES_UPDATE_COLUMNS.has('deleted_by_user_id')).toBe(false);
    expect(STEP_6_GRANTED_STORED_FILES_UPDATE_COLUMNS.has('purge_requested_at')).toBe(false);
    expect(STEP_6_GRANTED_STORED_FILES_UPDATE_COLUMNS.has('deleted_at')).toBe(false);

    const file = createMockFileRow();
    const harness = createOfflineDeletionRequestHarness({ initialFile: file });
    const repo = createPostgresFileDeletionRequestRepository(harness.db);

    const fetched = await repo.getOwnedFile(file.id, file.ownerUserId);
    expect(fetched).toEqual(file);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]?.op).toBe('select');
    expect(harness.queries[0]?.params).toEqual([file.id, file.ownerUserId]);

    const otherOwnerView = await repo.getOwnedFile(
      file.id,
      '99999999-9999-4999-8999-999999999999',
    );
    expect(otherOwnerView).toBeNull();
  });

  it('invokes studexo.request_stored_file_deletion(fileId, actorUserId) inside a READ COMMITTED transaction and normalizes returned timestamps', async () => {
    const file = createMockFileRow();
    const harness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeResult: {
        ...file,
        purgeState: 'pending_purge',
        deletedByUserId: file.ownerUserId,
        deletedAt: '2026-11-17T08:00:00.000Z' as unknown as Date,
        purgedAt: null,
        purgeLeaseUntil: null,
        purgeAttempts: '0' as unknown as number,
      },
    });
    const repo = createPostgresFileDeletionRequestRepository(harness.db);

    const updated = await repo.requestFileDeletion(file.id, file.ownerUserId);
    expect(harness.isolations).toEqual(['read committed']);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]?.op).toBe('execute');
    expect(harness.queries[0]?.sql).toContain(
      'FROM studexo.request_stored_file_deletion($1::uuid, $2::uuid) AS sf',
    );
    expect(harness.queries[0]?.params).toEqual([file.id, file.ownerUserId]);

    expect(updated).not.toBeNull();
    expect(updated?.purgeState).toBe('pending_purge');
    expect(updated?.deletedByUserId).toBe(file.ownerUserId);
    expect(updated?.deletedAt).toBeInstanceOf(Date);
    expect(updated?.purgeAttempts).toBe(0);
  });

  it('returns null on Option 1A concurrent state change (23514 already pending/purged/deleted) or missing target file (22023), and rethrows reference/actor/auth errors', async () => {
    const file = createMockFileRow();

    // 1. Concurrent transition away from none -> returns null
    const alreadyPendingHarness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeError: Object.assign(
        new Error(
          `stored_files ${file.id} is already deleted, purged, or pending purge (upload_status=verified, purge_state=pending_purge).`,
        ),
        { code: '23514' },
      ),
    });
    const alreadyPendingRepo = createPostgresFileDeletionRequestRepository(
      alreadyPendingHarness.db,
    );
    await expect(
      alreadyPendingRepo.requestFileDeletion(file.id, file.ownerUserId),
    ).resolves.toBeNull();

    // 2. Wrapped DrizzleQueryError with cause.code = '22023' missing target file -> returns null
    const missingFileHarness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeError: Object.assign(new Error('Failed query'), {
        cause: Object.assign(
          new Error(`Target stored_files row ${file.id} does not exist.`),
          { code: '22023' },
        ),
      }),
    });
    const missingFileRepo = createPostgresFileDeletionRequestRepository(
      missingFileHarness.db,
    );
    await expect(
      missingFileRepo.requestFileDeletion(file.id, file.ownerUserId),
    ).resolves.toBeNull();

    // 3. Active document_versions reference (23514) -> rethrown
    const referencedHarness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeError: Object.assign(
        new Error(
          `Cannot request deletion for stored_files ${file.id} while document_versions reference it.`,
        ),
        { code: '23514' },
      ),
    });
    const referencedRepo = createPostgresFileDeletionRequestRepository(
      referencedHarness.db,
    );
    await expect(
      referencedRepo.requestFileDeletion(file.id, file.ownerUserId),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('while document_versions reference it'),
    });

    // 4. Unauthorized actor (42501) -> rethrown
    const unauthorizedHarness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeError: Object.assign(
        new Error(
          `Actor user 99999999-9999-4999-8999-999999999999 (role=student) is not authorised to delete stored_files ${file.id} owned by ${file.ownerUserId}.`,
        ),
        { code: '42501' },
      ),
    });
    const unauthorizedRepo = createPostgresFileDeletionRequestRepository(
      unauthorizedHarness.db,
    );
    await expect(
      unauthorizedRepo.requestFileDeletion(
        file.id,
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 5. Inactive / pending_deletion actor (23514) -> rethrown
    const inactiveActorHarness = createOfflineDeletionRequestHarness({
      initialFile: file,
      executeError: Object.assign(
        new Error(
          `Deletion actor user ${file.ownerUserId} must be active with purge_state = none (got status=pending_deletion, purge_state=pending_purge).`,
        ),
        { code: '23514' },
      ),
    });
    const inactiveActorRepo = createPostgresFileDeletionRequestRepository(
      inactiveActorHarness.db,
    );
    await expect(
      inactiveActorRepo.requestFileDeletion(file.id, file.ownerUserId),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('must be active with purge_state = none'),
    });
  });

  it('integrates cleanly with requestDraftStoredFileDeletion across none, pending_purge, purging, purge_failed, purged+deleted, and concurrent state change', async () => {
    const baseFile = createMockFileRow();

    // 1. Fresh none file -> transitions to pending_purge and returns 202
    const freshHarness = createOfflineDeletionRequestHarness({ initialFile: baseFile });
    const freshRepo = createPostgresFileDeletionRequestRepository(freshHarness.db);
    const firstRes = await requestDraftStoredFileDeletion({
      fileId: baseFile.id,
      authenticatedUserId: baseFile.ownerUserId,
      repo: freshRepo,
    });
    expect(firstRes).toEqual({
      fileId: baseFile.id,
      outcome: 'pending_purge',
      httpStatus: 202,
    });
    expect(freshHarness.queries).toHaveLength(2); // 1 select + 1 execute

    // 2. Duplicate call when already pending_purge -> idempotent 202 without calling requestFileDeletion
    const secondRes = await requestDraftStoredFileDeletion({
      fileId: baseFile.id,
      authenticatedUserId: baseFile.ownerUserId,
      repo: freshRepo,
    });
    expect(secondRes).toEqual({
      fileId: baseFile.id,
      outcome: 'pending_purge',
      httpStatus: 202,
    });
    expect(freshHarness.queries).toHaveLength(3); // only 1 additional select, no execute

    // 3. Already purged + deleted -> returns 200 already_purged without calling requestFileDeletion
    const purgedHarness = createOfflineDeletionRequestHarness({
      initialFile: createMockFileRow({
        purgeState: 'purged',
        uploadStatus: 'deleted',
        deletedByUserId: baseFile.ownerUserId,
        deletedAt: new Date('2026-11-17T08:00:00.000Z'),
        purgedAt: new Date('2026-11-17T08:01:00.000Z'),
      }),
    });
    const purgedRepo = createPostgresFileDeletionRequestRepository(purgedHarness.db);
    const purgedRes = await requestDraftStoredFileDeletion({
      fileId: baseFile.id,
      authenticatedUserId: baseFile.ownerUserId,
      repo: purgedRepo,
    });
    expect(purgedRes).toEqual({
      fileId: baseFile.id,
      outcome: 'already_purged',
      httpStatus: 200,
    });
    expect(purgedHarness.queries).toHaveLength(1);

    // 4. Concurrent state change between getOwnedFile(none) and requestFileDeletion(null) -> throws expected concurrent state change message
    const concurrentHarness = createOfflineDeletionRequestHarness({
      initialFile: baseFile,
      executeError: Object.assign(
        new Error(
          `stored_files ${baseFile.id} is already deleted, purged, or pending purge (upload_status=verified, purge_state=pending_purge).`,
        ),
        { code: '23514' },
      ),
    });
    const concurrentRepo = createPostgresFileDeletionRequestRepository(
      concurrentHarness.db,
    );
    await expect(
      requestDraftStoredFileDeletion({
        fileId: baseFile.id,
        authenticatedUserId: baseFile.ownerUserId,
        repo: concurrentRepo,
      }),
    ).rejects.toThrow(
      `Unable to mark stored_file ${baseFile.id} pending_purge (concurrent state change).`,
    );
  });
});

interface DeferredBarrier {
  wait: () => Promise<void>;
  release: () => void;
}

function createDeferredBarrier(label: string, timeoutMs = 5_000): DeferredBarrier {
  let resolveFn!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      settled = true;
      resolve();
    };
  });

  return {
    wait: async () => {
      if (settled) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Timed out after ${timeoutMs}ms waiting on barrier: ${label}`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    release: () => {
      resolveFn();
    },
  };
}

/**
 * Wraps `StudexoDatabase` so that when `createPostgresFileDeletionRequestRepository(db).requestFileDeletion()`
 * executes `SELECT ... FROM studexo.request_stored_file_deletion(...)` inside its `READ COMMITTED`
 * transaction, `onAfterExecute` runs while the transaction still holds its `FOR UPDATE` / row-exclusive lock
 * on `studexo.stored_files` prior to `COMMIT`.
 */
function createExecuteBarrierDatabase(
  baseDb: StudexoDatabase,
  onAfterExecute: (context: { tx: StudexoDatabase }) => Promise<void>,
): StudexoDatabase {
  const wrapTx = (tx: StudexoDatabase): StudexoDatabase =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'execute') {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return async (...executeArgs: Parameters<StudexoDatabase['execute']>) => {
          const rows = await target.execute(...executeArgs);
          await onAfterExecute({ tx: target });
          return rows;
        };
      },
    });

  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async <T>(
        fn: (tx: StudexoDatabase) => Promise<T>,
        config?: Parameters<StudexoDatabase['transaction']>[1],
      ): Promise<T> => {
        return target.transaction(async (realTx) => fn(wrapTx(realTx)), config);
      };
    },
  });
}

interface ObservedLockWait {
  blockedPid: number;
  waitEventType: string | null;
  waitEvent: string | null;
  state: string | null;
  query: string;
  blockingPids: number[];
}

async function waitForPostgresLockWait(
  observerSql: Sql,
  options: {
    blockedQueryPattern: string;
    blockerPid?: number;
    timeoutMs?: number;
  },
): Promise<ObservedLockWait> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await observerSql<
      {
        blockedPid: number;
        waitEventType: string | null;
        waitEvent: string | null;
        state: string | null;
        query: string;
        blockingPids: number[];
      }[]
    >`
      SELECT
        a.pid::int AS "blockedPid",
        a.wait_event_type AS "waitEventType",
        a.wait_event AS "waitEvent",
        a.state AS "state",
        a.query AS "query",
        ARRAY(SELECT unnest(pg_catalog.pg_blocking_pids(a.pid))::int) AS "blockingPids"
      FROM pg_catalog.pg_stat_activity a
      WHERE a.datname = pg_catalog.current_database()
        AND a.pid <> pg_catalog.pg_backend_pid()
        AND a.wait_event_type = 'Lock'
        AND pg_catalog.cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0
        AND a.query ILIKE ${`%${options.blockedQueryPattern}%`}
    `;

    for (const row of rows) {
      if (
        options.blockerPid === undefined ||
        row.blockingPids.includes(options.blockerPid)
      ) {
        return row;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for PostgreSQL lock wait matching "${options.blockedQueryPattern}"` +
      (options.blockerPid !== undefined ? ` blocked by PID ${options.blockerPid}` : ''),
  );
}

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

describe.skipIf(!TEST_POSTGRES_URL)(
  'Phase 8B.4B — Live PostgreSQL 17 FileDeletionRequestRepository & Step 6 Role Acceptance',
  () => {
    let adminSql: Sql;
    let appSql: Sql;
    let appDb: StudexoDatabase;
    let workerSql: Sql;
    let workerDb: StudexoDatabase;
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
        SELECT to_regclass('studexo.stored_files') IS NOT NULL AS "alreadyMigrated"
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

      // Apply exact Step 5, Step 6 (studexo_app), and Step 7 (studexo_purge_worker) grants from docs/DATABASE_ROLES.md
      await adminSql.unsafe(`
        REVOKE CREATE ON SCHEMA studexo FROM PUBLIC, studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;

        REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) FROM PUBLIC, studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) TO studexo_purge_worker;
        GRANT USAGE, CREATE ON SCHEMA studexo TO studexo_purge_owner;
        ALTER FUNCTION studexo.execute_account_purge(uuid, varchar, integer) OWNER TO studexo_purge_owner;
        REVOKE CREATE ON SCHEMA studexo FROM studexo_purge_owner;
        GRANT USAGE ON SCHEMA studexo TO studexo_purge_owner;
        GRANT SELECT, UPDATE, DELETE ON studexo.users TO studexo_purge_owner;
        GRANT SELECT, UPDATE (deleted_by_user_id), DELETE ON studexo.stored_files TO studexo_purge_owner;
        GRANT SELECT, DELETE ON studexo.documents, studexo.application_documents TO studexo_purge_owner;
        GRANT SELECT, UPDATE, DELETE ON
          studexo.auth_identities,
          studexo.account_settings,
          studexo.user_consents,
          studexo.student_profiles,
          studexo.student_qualifications,
          studexo.student_test_scores,
          studexo.student_experiences,
          studexo.student_publications_and_projects,
          studexo.document_versions,
          studexo.saved_opportunities,
          studexo.university_applications,
          studexo.scholarship_applications,
          studexo.application_checklists,
          studexo.application_notes,
          studexo.application_status_history,
          studexo.planner_tasks,
          studexo.planner_events,
          studexo.notification_preferences,
          studexo.notification_deliveries,
          studexo.ai_permissions,
          studexo.ai_conversations,
          studexo.ai_messages,
          studexo.ai_runs,
          studexo.ai_usage_records,
          studexo.ai_run_context_links
        TO studexo_purge_owner;
        GRANT SELECT, UPDATE (verified_by_user_id) ON studexo.verification_claims TO studexo_purge_owner;
        GRANT INSERT, SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_owner;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_owner;

        -- Step 6: exact studexo_app privileges
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

        REVOKE ALL ON studexo.stored_files FROM PUBLIC, studexo_app;
        GRANT SELECT, INSERT ON studexo.stored_files TO studexo_app;
        GRANT UPDATE (
          original_filename,
          mime_type,
          byte_size,
          sha256_checksum,
          upload_status,
          uploaded_at,
          updated_at
        ) ON studexo.stored_files TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;
        REVOKE ALL ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) FROM PUBLIC, studexo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          studexo.auth_identities,
          studexo.account_settings,
          studexo.student_profiles,
          studexo.student_qualifications,
          studexo.student_test_scores,
          studexo.student_experiences,
          studexo.student_publications_and_projects,
          studexo.documents,
          studexo.document_versions,
          studexo.saved_opportunities,
          studexo.university_applications,
          studexo.scholarship_applications,
          studexo.application_documents,
          studexo.application_checklists,
          studexo.application_notes,
          studexo.planner_tasks,
          studexo.planner_events,
          studexo.notification_preferences,
          studexo.notification_deliveries,
          studexo.ai_conversations,
          studexo.ai_messages,
          studexo.ai_runs,
          studexo.ai_usage_records,
          studexo.ai_run_context_links
        TO studexo_app;
        REVOKE ALL ON studexo.external_identity_purge_outbox FROM PUBLIC, studexo_app;

        -- Step 7: exact studexo_purge_worker privileges
        GRANT USAGE ON SCHEMA studexo TO studexo_purge_worker;
        GRANT SELECT (id, supabase_auth_user_id, status, deletion_requested_at, deletion_scheduled_for, purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.users TO studexo_purge_worker;
        GRANT UPDATE (purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.users TO studexo_purge_worker;
        GRANT SELECT (id, owner_user_id, storage_bucket, object_key, upload_status, deleted_at, deleted_by_user_id, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.stored_files TO studexo_purge_worker;
        GRANT UPDATE (upload_status, deleted_at, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.stored_files TO studexo_purge_worker;
        GRANT SELECT (id, stored_file_id, user_id) ON studexo.document_versions TO studexo_purge_worker;
        GRANT SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
        GRANT UPDATE (status, attempt_count, next_attempt_at, lease_owner, locked_until, last_error_code, last_error_message, completed_at, updated_at) ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
        GRANT EXECUTE ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) TO studexo_purge_worker;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_worker;
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
      appSql = postgres(appUrl.toString(), { prepare: false, max: 5 });
      appDb = drizzle(appSql, { schema });

      const workerUrl = new URL(TEST_POSTGRES_URL!);
      workerUrl.username = 'studexo_purge_worker';
      workerUrl.password = testRolePassword;
      workerSql = postgres(workerUrl.toString(), { prepare: false, max: 5 });
      workerDb = drizzle(workerSql, { schema });
    });

    afterAll(async () => {
      await workerSql?.end({ timeout: 5 });
      await appSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    });

    async function seedUserDocAndFile(options?: {
      role?: 'student' | 'admin';
      userStatus?: 'active' | 'suspended' | 'pending_deletion';
      userPurgeState?: 'none' | 'pending_purge';
      fileUploadStatus?: 'pending' | 'uploaded';
    }) {
      const userId = crypto.randomUUID();
      const docId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const role = options?.role ?? 'student';
      const userStatus = options?.userStatus ?? 'active';
      const userPurgeState = options?.userPurgeState ?? 'none';
      const fileUploadStatus = options?.fileUploadStatus ?? 'uploaded';

      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx`
          INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name)
          VALUES (
            ${userId}::uuid,
            ${crypto.randomUUID()}::uuid,
            ${`user-${userId}@example.com`},
            'Test User'
          )
        `;

        if (role !== 'student') {
          await tx`
            UPDATE studexo.users
            SET role = ${role}::studexo.user_role
            WHERE id = ${userId}::uuid
          `;
        }

        if (userStatus === 'pending_deletion') {
          await tx`
            UPDATE studexo.users
            SET status = 'pending_deletion',
                deletion_requested_at = pg_catalog.now(),
                deletion_scheduled_for = pg_catalog.now() + interval '14 days',
                purge_state = ${userPurgeState}::studexo.purge_state
            WHERE id = ${userId}::uuid
          `;
        } else if (userStatus !== 'active') {
          await tx`
            UPDATE studexo.users
            SET status = ${userStatus}::studexo.account_status
            WHERE id = ${userId}::uuid
          `;
        }

        await tx`
          INSERT INTO studexo.stored_files (
            id, owner_user_id, storage_bucket, object_key, original_filename,
            mime_type, byte_size, sha256_checksum, upload_status
          ) VALUES (
            ${fileId}::uuid,
            ${userId}::uuid,
            'student-documents',
            ${`users/${userId}/${fileId}.pdf`},
            'transcript.pdf',
            'application/pdf',
            2048,
            ${'b'.repeat(64)},
            ${fileUploadStatus}::studexo.file_upload_status
          )
        `;

        await tx`
          INSERT INTO studexo.documents (id, user_id, document_type, title)
          VALUES (${docId}::uuid, ${userId}::uuid, 'transcript', 'Academic Transcript')
        `;
      });

      return { userId, docId, fileId };
    }

    it('1. enforces Step 6 least-privilege boundaries for studexo_app on stored_files and worker-only RPCs', async () => {
      const { userId, fileId } = await seedUserDocAndFile();

      // Direct UPDATE on purge_state is denied (42501)
      await expect(
        appSql`
          UPDATE studexo.stored_files
          SET purge_state = 'pending_purge'
          WHERE id = ${fileId}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      // Direct UPDATE on deleted_by_user_id is denied (42501)
      await expect(
        appSql`
          UPDATE studexo.stored_files
          SET deleted_by_user_id = ${userId}::uuid
          WHERE id = ${fileId}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      // Direct UPDATE on purge_requested_at is denied (42501)
      await expect(
        appSql`
          UPDATE studexo.stored_files
          SET purge_requested_at = pg_catalog.now()
          WHERE id = ${fileId}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      // Direct DELETE on stored_files is denied (42501)
      await expect(
        appSql`
          DELETE FROM studexo.stored_files
          WHERE id = ${fileId}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      // Worker-only RPCs are denied to studexo_app (42501)
      await expect(
        appSql`SELECT studexo.revert_stored_file_deletion_request(${fileId}::uuid, ${userId}::uuid)`,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        appSql`SELECT studexo.execute_account_purge(${userId}::uuid, 'app-unauthorized'::varchar, 1::integer)`,
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('2. transitions an unreferenced owned file none -> pending_purge via studexo_app and supports idempotent 202 / 200 outcomes in requestDraftStoredFileDeletion', async () => {
      const { userId, fileId } = await seedUserDocAndFile();
      const appRepo = createPostgresFileDeletionRequestRepository(appDb);
      const workerRepo = createPostgresFilePurgeWorkerRepository(workerDb);

      const initial = await appRepo.getOwnedFile(fileId, userId);
      expect(initial).not.toBeNull();
      expect(initial?.purgeState).toBe('none');
      expect(initial?.deletedByUserId).toBeNull();

      // First call transitions none -> pending_purge and returns 202
      const firstResult = await requestDraftStoredFileDeletion({
        fileId,
        authenticatedUserId: userId,
        repo: appRepo,
      });
      expect(firstResult).toEqual({
        fileId,
        outcome: 'pending_purge',
        httpStatus: 202,
      });

      const [dbRow] = await adminSql<
        {
          purgeState: string;
          deletedByUserId: string | null;
          purgeRequestedAt: Date | null;
          uploadStatus: string;
        }[]
      >`
        SELECT
          purge_state AS "purgeState",
          deleted_by_user_id AS "deletedByUserId",
          purge_requested_at AS "purgeRequestedAt",
          upload_status AS "uploadStatus"
        FROM studexo.stored_files
        WHERE id = ${fileId}::uuid
      `;
      expect(dbRow?.purgeState).toBe('pending_purge');
      expect(dbRow?.deletedByUserId).toBe(userId);
      expect(dbRow?.purgeRequestedAt).toBeInstanceOf(Date);
      expect(dbRow?.uploadStatus).toBe('uploaded');

      // Duplicate call while pending_purge is idempotent (202)
      const duplicatePendingResult = await requestDraftStoredFileDeletion({
        fileId,
        authenticatedUserId: userId,
        repo: appRepo,
      });
      expect(duplicatePendingResult).toEqual({
        fileId,
        outcome: 'pending_purge',
        httpStatus: 202,
      });

      // Stage 2 worker completes purge -> subsequent Stage 1 call returns 200 already_purged
      const lease = await workerRepo.acquireFilePurgeLeaseIfUnreferenced(fileId, userId, 60);
      expect(lease.status).toBe('acquired');
      await workerRepo.markFilePurged(fileId, userId);

      const afterPurgedResult = await requestDraftStoredFileDeletion({
        fileId,
        authenticatedUserId: userId,
        repo: appRepo,
      });
      expect(afterPurgedResult).toEqual({
        fileId,
        outcome: 'already_purged',
        httpStatus: 200,
      });
    });

    it('3. enforces actor existence (23503), active actor state (23514), cross-user non-admin denial (42501), and admin override', async () => {
      const { userId: ownerId, fileId } = await seedUserDocAndFile();
      const { userId: otherStudentId } = await seedUserDocAndFile();
      const { userId: pendingDeletionUserId, fileId: pendingUserFileId } =
        await seedUserDocAndFile({
          userStatus: 'pending_deletion',
          userPurgeState: 'pending_purge',
        });
      const { userId: adminUserId } = await seedUserDocAndFile({ role: 'admin' });

      const appRepo = createPostgresFileDeletionRequestRepository(appDb);

      // Missing actor user -> 23503
      await expect(
        appRepo.requestFileDeletion(fileId, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: '23503' });

      // Cross-user non-admin student -> 42501
      await expect(
        appRepo.requestFileDeletion(fileId, otherStudentId),
      ).rejects.toMatchObject({ code: '42501' });

      // Actor in pending_deletion / pending_purge -> 23514
      await expect(
        appRepo.requestFileDeletion(pendingUserFileId, pendingDeletionUserId),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('must be active with purge_state = none'),
      });

      // Active admin actor can request deletion on a student-owned file and attributes deleted_by_user_id = adminUserId
      const adminRequested = await appRepo.requestFileDeletion(fileId, adminUserId);
      expect(adminRequested).not.toBeNull();
      expect(adminRequested?.ownerUserId).toBe(ownerId);
      expect(adminRequested?.deletedByUserId).toBe(adminUserId);
      expect(adminRequested?.purgeState).toBe('pending_purge');
    });

    it('4. serializes two concurrent requestFileDeletion calls on the same none file so exactly one transitions and the second returns null (Option 1A)', async () => {
      const { userId, fileId } = await seedUserDocAndFile();
      const appRepo = createPostgresFileDeletionRequestRepository(appDb);

      const [r1, r2] = await Promise.all([
        appRepo.requestFileDeletion(fileId, userId),
        appRepo.requestFileDeletion(fileId, userId),
      ]);

      const nonNullResults = [r1, r2].filter(
        (r): r is StoredFileLifecycleRecord => r !== null,
      );
      const nullResults = [r1, r2].filter((r) => r === null);

      expect(nonNullResults).toHaveLength(1);
      expect(nullResults).toHaveLength(1);
      expect(nonNullResults[0]?.purgeState).toBe('pending_purge');
      expect(nonNullResults[0]?.deletedByUserId).toBe(userId);
    });

    it('5. Interleaving A (Request-first): requestFileDeletion holds FOR UPDATE on stored_files while concurrent document_versions INSERT blocks on FOR SHARE then fails with SQLSTATE 23514', async () => {
      const { userId, docId, fileId } = await seedUserDocAndFile();

      const txALockAcquired = createDeferredBarrier(
        'Interleaving A: requestFileDeletion executed inside uncommitted tx',
      );
      const releaseTxACommit = createDeferredBarrier(
        'Interleaving A: release requestFileDeletion tx to commit',
      );
      let txAPid = 0;

      const barrierAppDb = createExecuteBarrierDatabase(appDb, async ({ tx }) => {
        const pidRows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_catalog.pg_backend_pid()::int AS pid`,
        );
        txAPid = Number(pidRows[0]?.pid ?? 0);
        txALockAcquired.release();
        await releaseTxACommit.wait();
      });
      const barrierAppRepo = createPostgresFileDeletionRequestRepository(barrierAppDb);

      let txASettled = false;
      const txAPromise = barrierAppRepo
        .requestFileDeletion(fileId, userId)
        .finally(() => {
          txASettled = true;
        });

      const secondAppUrl = new URL(TEST_POSTGRES_URL!);
      secondAppUrl.username = 'studexo_app';
      secondAppUrl.password = testRolePassword;
      const secondAppSql = postgres(secondAppUrl.toString(), { prepare: false, max: 2 });

      let txBSettled = false;
      let txBPromise: Promise<unknown> | undefined;

      try {
        await txALockAcquired.wait();
        expect(txASettled).toBe(false);
        expect(txAPid).toBeGreaterThan(0);

        // Independent READ COMMITTED observer still sees purge_state = 'none' before Transaction A commits
        const [uncommittedRow] = await adminSql<{ purgeState: string }[]>`
          SELECT purge_state AS "purgeState"
          FROM studexo.stored_files
          WHERE id = ${fileId}::uuid
        `;
        expect(uncommittedRow?.purgeState).toBe('none');

        txBPromise = secondAppSql
          .begin(async (bTx) => {
            await bTx`
              INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
              VALUES (${docId}::uuid, ${userId}::uuid, ${fileId}::uuid, 1)
            `;
          })
          .finally(() => {
            txBSettled = true;
          });

        const observedWait = await waitForPostgresLockWait(adminSql, {
          blockedQueryPattern: 'INSERT INTO studexo.document_versions',
          blockerPid: txAPid,
        });
        expect(observedWait.waitEventType).toBe('Lock');
        expect(observedWait.blockingPids).toContain(txAPid);
        expect(txBSettled).toBe(false);
        expect(txASettled).toBe(false);
      } finally {
        releaseTxACommit.release();
      }

      try {
        const txAResult = await txAPromise;
        expect(txAResult).not.toBeNull();
        expect(txAResult?.purgeState).toBe('pending_purge');
        expect(txAResult?.deletedByUserId).toBe(userId);

        await expect(txBPromise).rejects.toMatchObject({ code: '23514' });

        const [finalFile] = await adminSql<{ purgeState: string; refCount: number }[]>`
          SELECT
            sf.purge_state AS "purgeState",
            (SELECT count(*)::int FROM studexo.document_versions dv WHERE dv.stored_file_id = sf.id) AS "refCount"
          FROM studexo.stored_files sf
          WHERE sf.id = ${fileId}::uuid
        `;
        expect(finalFile?.purgeState).toBe('pending_purge');
        expect(finalFile?.refCount).toBe(0);
      } finally {
        await secondAppSql.end({ timeout: 5 });
      }
    });

    it('6. Interleaving B (Reference-first): document_versions INSERT holds FOR SHARE on stored_files while concurrent requestFileDeletion blocks on FOR UPDATE then fails with SQLSTATE 23514', async () => {
      const { userId, docId, fileId } = await seedUserDocAndFile();
      const appRepo = createPostgresFileDeletionRequestRepository(appDb);

      const txBLockAcquired = createDeferredBarrier(
        'Interleaving B: document_versions INSERT acquired FOR SHARE',
      );
      const releaseTxBCommit = createDeferredBarrier(
        'Interleaving B: release document_versions INSERT to commit',
      );
      let txBPid = 0;

      const secondAppUrl = new URL(TEST_POSTGRES_URL!);
      secondAppUrl.username = 'studexo_app';
      secondAppUrl.password = testRolePassword;
      const secondAppSql = postgres(secondAppUrl.toString(), { prepare: false, max: 2 });

      const txBPromise = secondAppSql.begin(async (bTx) => {
        const [pidRow] = await bTx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid()::int AS pid
        `;
        txBPid = Number(pidRow?.pid ?? 0);

        await bTx`
          INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
          VALUES (${docId}::uuid, ${userId}::uuid, ${fileId}::uuid, 1)
        `;

        txBLockAcquired.release();
        await releaseTxBCommit.wait();
      });

      let txASettled = false;
      let txAPromise: Promise<StoredFileLifecycleRecord | null> | undefined;

      try {
        await txBLockAcquired.wait();
        expect(txBPid).toBeGreaterThan(0);

        txAPromise = appRepo.requestFileDeletion(fileId, userId).finally(() => {
          txASettled = true;
        });

        const observedWait = await waitForPostgresLockWait(adminSql, {
          blockedQueryPattern: 'request_stored_file_deletion',
          blockerPid: txBPid,
        });
        expect(observedWait.waitEventType).toBe('Lock');
        expect(observedWait.blockingPids).toContain(txBPid);
        expect(txASettled).toBe(false);
      } finally {
        releaseTxBCommit.release();
      }

      try {
        await txBPromise;
        await expect(txAPromise).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('while document_versions reference it'),
        });

        const [finalState] = await adminSql<
          {
            purgeState: string;
            deletedByUserId: string | null;
            purgeRequestedAt: Date | null;
            refCount: number;
          }[]
        >`
          SELECT
            sf.purge_state AS "purgeState",
            sf.deleted_by_user_id AS "deletedByUserId",
            sf.purge_requested_at AS "purgeRequestedAt",
            (SELECT count(*)::int FROM studexo.document_versions dv WHERE dv.stored_file_id = sf.id) AS "refCount"
          FROM studexo.stored_files sf
          WHERE sf.id = ${fileId}::uuid
        `;
        expect(finalState?.purgeState).toBe('none');
        expect(finalState?.deletedByUserId).toBeNull();
        expect(finalState?.purgeRequestedAt).toBeNull();
        expect(finalState?.refCount).toBe(1);
      } finally {
        await secondAppSql.end({ timeout: 5 });
      }
    });

    it('7. completes end-to-end Stage 1 request (studexo_app) -> Stage 2 reference-blocked rollback -> reference removal -> Stage 1 re-request -> Stage 2 purge (studexo_purge_worker)', async () => {
      const { userId, docId, fileId } = await seedUserDocAndFile();
      const appRepo = createPostgresFileDeletionRequestRepository(appDb);
      const workerRepo = createPostgresFilePurgeWorkerRepository(workerDb);

      // Step 1: Stage 1 request transitions none -> pending_purge
      const stage1First = await requestDraftStoredFileDeletion({
        fileId,
        authenticatedUserId: userId,
        repo: appRepo,
      });
      expect(stage1First.httpStatus).toBe(202);

      // Simulate a legacy/migrator-seeded reference existing while pending_purge so Stage 2 worker must roll back via revertPendingPurgeToNone
      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx.unsafe(`ALTER TABLE studexo.document_versions DISABLE TRIGGER trg_document_versions_integrity`);
        await tx`
          INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
          VALUES (${docId}::uuid, ${userId}::uuid, ${fileId}::uuid, 1)
        `;
        await tx.unsafe(`ALTER TABLE studexo.document_versions ENABLE TRIGGER trg_document_versions_integrity`);
      });

      // Step 2: Stage 2 worker detects reference and reverts untouched pending_purge -> none
      const rollbackOutcome = await processPendingStoredFileDeletion({
        fileId,
        ownerUserId: userId,
        repo: workerRepo,
        storage: {
          removeObject: async () => {
            throw new Error('Storage removeObject must not be called when referenced');
          },
          verifyObjectAbsent: async () => false,
        },
      });
      expect(rollbackOutcome.outcome).toBe('reverted_blocked_by_refs');

      const afterRollback = await appRepo.getOwnedFile(fileId, userId);
      expect(afterRollback?.purgeState).toBe('none');
      expect(afterRollback?.deletedByUserId).toBeNull();

      // Step 3: Remove the document_versions reference as studexo_app
      await appSql`
        DELETE FROM studexo.document_versions
        WHERE stored_file_id = ${fileId}::uuid
      `;

      // Step 4: Stage 1 re-requests deletion as studexo_app
      const stage1Second = await requestDraftStoredFileDeletion({
        fileId,
        authenticatedUserId: userId,
        repo: appRepo,
      });
      expect(stage1Second).toEqual({
        fileId,
        outcome: 'pending_purge',
        httpStatus: 202,
      });

      // Step 5: Stage 2 worker acquires lease and marks file purged + deleted
      const finalLease = await workerRepo.acquireFilePurgeLeaseIfUnreferenced(fileId, userId, 60);
      expect(finalLease.status).toBe('acquired');
      if (finalLease.status === 'acquired') {
        expect(finalLease.file.storageBucket).toBe('student-documents');
        expect(finalLease.file.objectKey).toContain(fileId);
      }
      await workerRepo.markFilePurged(fileId, userId);

      const finalView = await appRepo.getOwnedFile(fileId, userId);
      expect(finalView?.purgeState).toBe('purged');
      expect(finalView?.uploadStatus).toBe('deleted');
      expect(finalView?.deletedByUserId).toBe(userId);
      expect(finalView?.deletedAt).toBeInstanceOf(Date);
      expect(finalView?.purgedAt).toBeInstanceOf(Date);
    });
  },
);
