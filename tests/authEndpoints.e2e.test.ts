import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { AuthApiError, type SupabaseClient, type User } from '@supabase/supabase-js';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import { closeAllDbs, hasActiveDbClient } from '../src/server/db/index';
import { createLogger } from '../src/server/lib/logger';
import {
  deriveEmailProvisionLockId,
  deriveUserProvisionLockId,
  normalizeAuthSub,
  normalizeEmail,
  truncateToUnicodeChars,
  type AuthRepository,
  type ProvisionUserParams,
  type UserRecordWithIdentities,
} from '../src/server/modules/auth/auth.repository';
import { AuthService } from '../src/server/modules/auth/auth.service';
import {
  MockTokenVerifier,
  SupabaseTokenVerifier,
  type TokenVerifier,
} from '../src/server/modules/auth/tokenVerifier';
import { authMeResponseSchema, authSyncResponseSchema } from '../src/shared/schemas/auth.schema';
import { AuthError, type SupportedAuthProvider } from '../src/shared/types/auth';

/**
 * Concurrency-safe in-memory AuthRepository mirroring PostgresAuthRepository
 * advisory lock ordering and anti-collision semantics for offline E2E HTTP tests.
 */
class ConcurrencySafeInMemoryAuthRepository implements AuthRepository {
  public readonly usersBySub = new Map<string, UserRecordWithIdentities>();
  public readonly usersByEmail = new Map<string, { id: string; supabaseAuthUserId: string; primaryEmail: string }>();
  public readonly identitiesByProviderKey = new Map<string, string>();
  public readonly pendingPurgeSubs = new Set<string>();
  public readonly capturedInserts: ProvisionUserParams[] = [];
  public readonly lastSignInUpdates: Array<{ userId: string; provider: SupportedAuthProvider; providerSubject: string }> = [];
  public throwTransientDbError = false;

  private activeLocks = new Set<string>();
  private waitQueue: Array<() => void> = [];

  private async acquireCanonicalLocks(keys: string[]): Promise<() => void> {
    const canAcquire = () => keys.every((k) => !this.activeLocks.has(k));
    while (!canAcquire()) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    for (const k of keys) {
      this.activeLocks.add(k);
    }
    return () => {
      for (const k of keys) {
        this.activeLocks.delete(k);
      }
      const waiters = this.waitQueue.splice(0);
      for (const wake of waiters) {
        wake();
      }
    };
  }

  private assertDbAvailable(): void {
    if (this.throwTransientDbError) {
      const err = new Error('connect ECONNREFUSED postgresql://user:secret@127.0.0.1:6543/studexo') as Error & {
        code?: string;
      };
      err.code = 'ECONNREFUSED';
      throw err;
    }
  }

  public seedUser(record: UserRecordWithIdentities): void {
    const sub = normalizeAuthSub(record.user.supabaseAuthUserId);
    const email = normalizeEmail(record.user.primaryEmail);
    this.usersBySub.set(sub, record);
    this.usersByEmail.set(email, {
      id: record.user.id,
      supabaseAuthUserId: sub,
      primaryEmail: email,
    });
    for (const ident of record.identities) {
      this.identitiesByProviderKey.set(`${ident.provider}:${ident.providerSubject}`, record.user.id);
    }
  }

  public async findUserBySupabaseAuthId(supabaseAuthUserId: string): Promise<UserRecordWithIdentities | null> {
    this.assertDbAvailable();
    return this.usersBySub.get(normalizeAuthSub(supabaseAuthUserId)) ?? null;
  }

  public async findUserByProviderIdentity(
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<UserRecordWithIdentities | null> {
    this.assertDbAvailable();
    const userId = this.identitiesByProviderKey.get(`${provider}:${providerSubject.trim()}`);
    if (!userId) return null;
    for (const record of this.usersBySub.values()) {
      if (record.user.id === userId) return record;
    }
    return null;
  }

  public async findUserByEmail(email: string) {
    this.assertDbAvailable();
    return this.usersByEmail.get(normalizeEmail(email)) ?? null;
  }

  public async checkIsAuthUserPendingPurge(supabaseAuthUserId: string): Promise<boolean> {
    this.assertDbAvailable();
    return this.pendingPurgeSubs.has(normalizeAuthSub(supabaseAuthUserId));
  }

  public async provisionUserAtomic(params: ProvisionUserParams): Promise<UserRecordWithIdentities> {
    this.assertDbAvailable();
    const normalizedSub = normalizeAuthSub(params.supabaseAuthUserId);
    const normalizedEmail = normalizeEmail(params.primaryEmail);
    const { lockId: subLockId } = deriveUserProvisionLockId(normalizedSub);
    const { lockId: emailLockId } = deriveEmailProvisionLockId(normalizedEmail);

    const lockKeys =
      subLockId === emailLockId
        ? [`sub:${normalizedSub}`]
        : subLockId < emailLockId
          ? [`sub:${normalizedSub}`, `email:${normalizedEmail}`]
          : [`email:${normalizedEmail}`, `sub:${normalizedSub}`];

    const releaseLocks = await this.acquireCanonicalLocks(lockKeys);
    // Yield microtask to verify async race serialization across concurrent requests
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    try {
      const existing = this.usersBySub.get(normalizedSub);
      if (existing) {
        return existing;
      }

      if (this.pendingPurgeSubs.has(normalizedSub)) {
        throw new AuthError(
          'AUTH_PURGE_IN_PROGRESS',
          'External auth identity has an active deletion in progress; registration is blocked until purge completes.',
          { statusCode: 403 },
        );
      }

      const emailMatch = this.usersByEmail.get(normalizedEmail);
      if (emailMatch && emailMatch.supabaseAuthUserId !== normalizedSub) {
        throw new AuthError(
          'AUTH_IDENTITY_COLLISION',
          'An account with this email address already exists under a different identity provider.',
          { statusCode: 409 },
        );
      }

      for (const ident of params.identities) {
        const key = `${ident.provider}:${ident.providerSubject}`;
        if (this.identitiesByProviderKey.has(key)) {
          throw new AuthError(
            'AUTH_IDENTITY_COLLISION',
            `Identity provider account (${ident.provider}:${ident.providerSubject}) is already linked to another user.`,
            { statusCode: 409 },
          );
        }
      }

      this.capturedInserts.push(params);

      const trimmedDisplayName =
        params.displayName && params.displayName.trim().length > 0
          ? truncateToUnicodeChars(params.displayName.trim(), 160)
          : null;

      const newUserId = crypto.randomUUID();
      const record: UserRecordWithIdentities = {
        user: {
          id: newUserId,
          supabaseAuthUserId: normalizedSub,
          primaryEmail: normalizedEmail,
          displayName: trimmedDisplayName,
          role: 'student',
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: params.identities.map((i) => ({
          provider: i.provider,
          providerSubject: i.providerSubject,
          emailAtProvider: i.emailAtProvider ? normalizeEmail(i.emailAtProvider) : normalizedEmail,
          emailVerified: i.emailVerified,
        })),
        settings: {
          preferredLocale: params.preferredLocale ?? 'en',
          preferredCurrency: params.preferredCurrency ?? 'USD',
          timezone: params.timezone ?? 'Asia/Dhaka',
          marketingOptIn: false,
        },
      };

      this.seedUser(record);
      return record;
    } finally {
      releaseLocks();
    }
  }

  public async updateIdentityLastSignIn(
    userId: string,
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<void> {
    this.assertDbAvailable();
    this.lastSignInUpdates.push({ userId, provider, providerSubject });
  }
}

function createSpyLogger(level: string = 'info') {
  const lines: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    lines.push(chunk.toString('utf8'));
  });
  const logger = createLogger(level, stream);
  return {
    logger,
    getRawOutput: () => lines.join(''),
  };
}

describe('Phase 8B.5A Milestone 4 — Offline E2E Auth Endpoints (/api/auth/sync & /api/auth/me)', () => {
  const SUB_1 = '00000000-0000-4000-8000-000000000101';
  const SUB_2 = '00000000-0000-4000-8000-000000000202';
  const COUNSELOR_SUB = '00000000-0000-4000-8000-000000000303';
  const ADMIN_SUB = '00000000-0000-4000-8000-000000000404';

  afterEach(async () => {
    await closeAllDbs();
  });

  function buildE2EHarness(options: {
    isProduction?: boolean;
    rateLimitMax?: number;
    tokenVerifierOverride?: TokenVerifier;
  } = {}) {
    const spy = createSpyLogger('info');
    const mockVerifier = new MockTokenVerifier();
    const repo = new ConcurrencySafeInMemoryAuthRepository();
    const authService = new AuthService(repo);

    const env = parseEnv(
      options.isProduction
        ? { NODE_ENV: 'production', APP_URL: 'https://studexo.example.com' }
        : { NODE_ENV: 'test' },
    );

    const ctx = createApp({
      env,
      logger: spy.logger,
      rateLimitMax: options.rateLimitMax,
      checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
      authDependencies: {
        tokenVerifier: options.tokenVerifierOverride ?? mockVerifier,
        authService,
      },
    });

    return { ...ctx, mockVerifier, repo, authService, spy };
  }

  describe('1. First-Time Provisioning & Returning-User Synchronization', () => {
    it('returns 404 before sync, provisions student with sanitized DTO on POST /api/auth/sync, and resolves on GET /api/auth/me', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();
      const token = mockVerifier.mintToken({
        sub: SUB_1,
        email: 'Alice.New@studexo.example.com',
        role: 'admin', // Supabase claim or metadata must never elevate DB role
        app_metadata: { provider: 'email', role: 'admin' },
        user_metadata: { full_name: 'Alice GoTrue', role: 'admin' },
      });

      // Step 1: Unprovisioned user hits GET /api/auth/me -> 404 AUTH_IDENTITY_NOT_FOUND
      const preMe = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(preMe.status).toBe(404);
      expect(preMe.body.error.code).toBe('AUTH_IDENTITY_NOT_FOUND');

      // Step 2: First-time POST /api/auth/sync provisions internal studexo.users & settings
      const syncRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({
          displayName: '  Alice Preferred  ',
          preferredLocale: 'en-GB',
          preferredCurrency: 'eur',
          timezone: 'Europe/London',
        });

      expect(syncRes.status).toBe(200);
      expect(syncRes.headers['cache-control']).toBe('no-store');
      const parsedSync = authSyncResponseSchema.parse(syncRes.body);
      expect(parsedSync.user).toEqual({
        id: expect.any(String),
        primaryEmail: 'alice.new@studexo.example.com',
        displayName: 'Alice Preferred',
        role: 'student',
        status: 'active',
      });
      expect(parsedSync.identities).toEqual([
        { provider: 'supabase_email', emailVerified: true },
      ]);
      expect(parsedSync.settings).toEqual({
        preferredLocale: 'en-GB',
        preferredCurrency: 'EUR',
        timezone: 'Europe/London',
        marketingOptIn: false,
      });
      // Sensitive internal fields must not be exposed
      expect(syncRes.body.user.supabaseAuthUserId).toBeUndefined();
      expect(syncRes.body.user.purgeState).toBeUndefined();
      expect(syncRes.body.identities[0].providerSubject).toBeUndefined();

      // Step 3: Subsequent GET /api/auth/me returns active DB user
      const postMe = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(postMe.status).toBe(200);
      expect(postMe.headers['cache-control']).toBe('no-store');
      const parsedMe = authMeResponseSchema.parse(postMe.body);
      expect(parsedMe.user).toEqual(parsedSync.user);
      expect(postMe.body.user.supabaseAuthUserId).toBeUndefined();
      expect(postMe.body.user.purgeState).toBeUndefined();
      expect(repo.capturedInserts).toHaveLength(1);
    });

    it('accepts POST /api/auth/sync without a request body and syncs returning users without overwriting DB role, displayName, or settings', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();

      repo.seedUser({
        user: {
          id: 'user-counselor-uuid',
          supabaseAuthUserId: COUNSELOR_SUB,
          primaryEmail: 'counselor@studexo.example.com',
          displayName: 'Existing Counselor',
          role: 'counselor',
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: COUNSELOR_SUB,
            emailAtProvider: 'counselor@studexo.example.com',
            emailVerified: true,
          },
        ],
        settings: {
          preferredLocale: 'bn',
          preferredCurrency: 'BDT',
          timezone: 'Asia/Dhaka',
          marketingOptIn: false,
        },
      });

      const token = mockVerifier.mintToken({
        sub: COUNSELOR_SUB,
        email: 'counselor@studexo.example.com',
      });

      // Returning sync with empty body preserves DB role/displayName/settings & updates lastSignInAt
      const emptySync = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${token}`);
      expect(emptySync.status).toBe(200);
      expect(emptySync.body.user.role).toBe('counselor');
      expect(emptySync.body.user.displayName).toBe('Existing Counselor');
      expect(emptySync.body.settings.preferredCurrency).toBe('BDT');
      expect(repo.lastSignInUpdates).toHaveLength(1);
      expect(repo.capturedInserts).toHaveLength(0);

      // Returning sync sending new preferences does NOT overwrite existing displayName/settings or role
      const secondSync = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({
          displayName: 'Attempted Overwrite Name',
          preferredCurrency: 'USD',
          timezone: 'UTC',
        });
      expect(secondSync.status).toBe(200);
      expect(secondSync.body.user.role).toBe('counselor');
      expect(secondSync.body.user.displayName).toBe('Existing Counselor');
      expect(secondSync.body.settings.preferredCurrency).toBe('BDT');
      expect(secondSync.body.settings.timezone).toBe('Asia/Dhaka');
      expect(repo.lastSignInUpdates).toHaveLength(2);
    });

    it('persists genuine OAuth external providerSubject via SupabaseTokenVerifier without leaking providerSubject in HTTP responses', async () => {
      const secret = 'e2e-oauth-jwt-secret-32-bytes-minimum';
      const localVerifier = new MockTokenVerifier(secret);
      const mockSupaClient = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: SUB_1,
                email: 'oauth.student@studexo.example.com',
                email_confirmed_at: new Date().toISOString(),
                app_metadata: { provider: 'google', providers: ['google'] },
                user_metadata: { full_name: 'Google Student' },
                identities: [
                  {
                    id: 'internal-identity-row-id',
                    user_id: SUB_1,
                    identity_id: 'internal-identity-row-id',
                    provider: 'google',
                    identity_data: {
                      provider_id: '10928374655647382910',
                      sub: '10928374655647382910',
                      email: 'oauth.student@studexo.example.com',
                      email_verified: true,
                    },
                  },
                ],
                aud: 'authenticated',
                created_at: new Date().toISOString(),
              } as unknown as User,
            },
            error: null,
          }),
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://mock.studexo.test',
        supabaseAnonKey: 'anon-key',
        jwtSecret: secret,
        client: mockSupaClient as unknown as SupabaseClient,
      });

      const { app, repo } = buildE2EHarness({ tokenVerifierOverride: verifier });
      const token = localVerifier.mintToken({
        sub: SUB_1,
        email: 'oauth.student@studexo.example.com',
        app_metadata: { provider: 'google', provider_id: '10928374655647382910' },
      });

      const syncRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${token}`);
      expect(syncRes.status).toBe(200);
      expect(syncRes.body.identities).toEqual([{ provider: 'google', emailVerified: true }]);
      expect(JSON.stringify(syncRes.body)).not.toContain('10928374655647382910');

      const stored = await repo.findUserBySupabaseAuthId(SUB_1);
      expect(stored?.identities[0]?.providerSubject).toBe('10928374655647382910');

      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.role).toBe('student');
    });
  });

  describe('2. Concurrent First-Login Races & Anti-Collision Guards', () => {
    it('serializes simultaneous first-login POST /api/auth/sync requests for the same UUID into 1 provision', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();
      const token = mockVerifier.mintToken({
        sub: SUB_1,
        email: 'same-sub-race@studexo.example.com',
      });

      const responses = await Promise.all([
        request(app).post('/api/auth/sync').set('Authorization', `Bearer ${token}`).send({ displayName: 'Race 1' }),
        request(app).post('/api/auth/sync').set('Authorization', `Bearer ${token}`).send({ displayName: 'Race 2' }),
        request(app).post('/api/auth/sync').set('Authorization', `Bearer ${token}`).send({ displayName: 'Race 3' }),
      ]);

      expect(responses.every((r) => r.status === 200)).toBe(true);
      const uniqueIds = new Set(responses.map((r) => r.body.user.id));
      expect(uniqueIds.size).toBe(1);
      expect(repo.capturedInserts).toHaveLength(1);
    });

    it('serializes simultaneous first-login requests from two different UUIDs claiming the same normalized email (one 200, one 409)', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();

      const tokenA = mockVerifier.mintToken({
        sub: SUB_1,
        email: 'Shared.Email@studexo.example.com',
      });
      const tokenB = mockVerifier.mintToken({
        sub: SUB_2,
        email: 'shared.email@studexo.example.com',
        app_metadata: { provider: 'google', provider_id: 'google-sub-b' },
      });

      const [resA, resB] = await Promise.all([
        request(app).post('/api/auth/sync').set('Authorization', `Bearer ${tokenA}`),
        request(app).post('/api/auth/sync').set('Authorization', `Bearer ${tokenB}`),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      expect(conflictRes.body.error.code).toBe('AUTH_IDENTITY_COLLISION');
      expect(repo.capturedInserts).toHaveLength(1);
      expect(repo.usersBySub.size).toBe(1);
    });

    it('rejects provider identity collision (409) and never falls back to email-only linking', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();

      repo.seedUser({
        user: {
          id: 'user-victim',
          supabaseAuthUserId: SUB_1,
          primaryEmail: 'victim@studexo.example.com',
          displayName: 'Victim',
          role: 'student',
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [
          {
            provider: 'google',
            providerSubject: 'google-shared-subject',
            emailAtProvider: 'victim@studexo.example.com',
            emailVerified: true,
          },
        ],
      });

      // Different UUID claiming same email must not link
      const emailAttackerToken = mockVerifier.mintToken({
        sub: SUB_2,
        email: 'victim@studexo.example.com',
      });
      const emailCollision = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${emailAttackerToken}`);
      expect(emailCollision.status).toBe(409);
      expect(emailCollision.body.error.code).toBe('AUTH_IDENTITY_COLLISION');

      // Different UUID & email claiming same Google provider subject must not link
      const providerAttackerToken = mockVerifier.mintToken({
        sub: SUB_2,
        email: 'attacker@studexo.example.com',
        app_metadata: { provider: 'google', provider_id: 'google-shared-subject' },
      });
      mockVerifier.registerAuthoritativeUser({
        sub: SUB_2,
        email: 'attacker@studexo.example.com',
        emailConfirmedAt: new Date(),
        identities: [
          {
            provider: 'google',
            providerSubject: 'google-shared-subject',
            emailAtProvider: 'attacker@studexo.example.com',
            emailVerified: true,
          },
        ],
      });
      const providerCollision = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${providerAttackerToken}`);
      expect(providerCollision.status).toBe(409);
      expect(providerCollision.body.error.code).toBe('AUTH_IDENTITY_COLLISION');

      // Calling /api/auth/me with emailAttackerToken (without providerSubject) stays 404 (no email auto-link)
      const meAttempt = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${emailAttackerToken}`);
      expect(meAttempt.status).toBe(404);
      expect(meAttempt.body.error.code).toBe('AUTH_IDENTITY_NOT_FOUND');
    });
  });

  describe('3. Invalid, Expired & Revoked Sessions and Verification Boundaries', () => {
    it('enforces 401 + WWW-Authenticate on missing, expired, malformed, and revoked sessions across sync and me', async () => {
      const secret = 'revocation-boundary-secret-32-bytes-long';
      const localVerifier = new MockTokenVerifier(secret);
      const mockSupaClient = {
        auth: {
          getUser: async () => ({
            data: { user: null },
            error: new AuthApiError('Session from session_id claim in JWT does not exist', 401, 'session_not_found'),
          }),
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://mock.studexo.test',
        supabaseAnonKey: 'anon-key',
        jwtSecret: secret,
        client: mockSupaClient as unknown as SupabaseClient,
      });

      const { app, repo } = buildE2EHarness({ tokenVerifierOverride: verifier });
      repo.seedUser({
        user: {
          id: 'user-1',
          supabaseAuthUserId: SUB_1,
          primaryEmail: 'student@studexo.example.com',
          displayName: 'Student',
          role: 'student',
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      });

      // Missing header on /sync and /me
      const missingSync = await request(app).post('/api/auth/sync');
      expect(missingSync.status).toBe(401);
      expect(missingSync.headers['www-authenticate']).toBe('Bearer');

      const missingMe = await request(app).get('/api/auth/me');
      expect(missingMe.status).toBe(401);
      expect(missingMe.headers['www-authenticate']).toBe('Bearer');

      // Expired token on /me
      const expiredToken = localVerifier.mintToken(
        { sub: SUB_1, email: 'student@studexo.example.com' },
        { issuedAtOffsetSeconds: -7200, expiresInSeconds: 60 },
      );
      const expiredMe = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(expiredMe.status).toBe(401);
      expect(expiredMe.body.error.code).toBe('AUTH_TOKEN_EXPIRED');

      // Valid cryptographic JWT whose session was revoked in GoTrue:
      // Tier 1A (/me) verifies cryptographically locally (200), while Tier 1B (/sync) calls GoTrue and rejects 401!
      const revokedToken = localVerifier.mintToken({
        sub: SUB_1,
        email: 'student@studexo.example.com',
      });
      const localMeRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${revokedToken}`);
      expect(localMeRes.status).toBe(200);

      const syncRevokedRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${revokedToken}`);
      expect(syncRevokedRes.status).toBe(401);
      expect(syncRevokedRes.headers['www-authenticate']).toBe('Bearer');
      expect(syncRevokedRes.body.error.code).toBe('AUTH_INVALID_TOKEN');
    });

    it('rejects unverified emails (403), banned accounts (403), and invalid/internal OAuth identities (403)', async () => {
      let mode: 'unverified' | 'banned' | 'internal_id_oauth' | 'empty_identities_oauth' = 'unverified';
      const mockSupaClient = {
        auth: {
          getUser: async () => {
            if (mode === 'unverified') {
              return {
                data: {
                  user: {
                    id: SUB_1,
                    email: 'unverified@studexo.example.com',
                    email_confirmed_at: null,
                    confirmed_at: null,
                    app_metadata: { provider: 'email' },
                    identities: [
                      {
                        id: 'id-1',
                        user_id: SUB_1,
                        identity_id: 'ident-1',
                        provider: 'email',
                        identity_data: { email: 'unverified@studexo.example.com', email_verified: false },
                      },
                    ],
                  } as unknown as User,
                },
                error: null,
              };
            }
            if (mode === 'banned') {
              return {
                data: {
                  user: {
                    id: SUB_1,
                    email: 'banned@studexo.example.com',
                    email_confirmed_at: new Date().toISOString(),
                    banned_until: new Date(Date.now() + 3600_000).toISOString(),
                    app_metadata: { provider: 'email' },
                    identities: [],
                  } as unknown as User,
                },
                error: null,
              };
            }
            if (mode === 'internal_id_oauth') {
              return {
                data: {
                  user: {
                    id: SUB_1,
                    email: 'oauth@studexo.example.com',
                    email_confirmed_at: new Date().toISOString(),
                    app_metadata: { provider: 'google' },
                    identities: [
                      {
                        id: '00000000-0000-4000-8000-999999999999',
                        user_id: SUB_1,
                        identity_id: '00000000-0000-4000-8000-999999999999',
                        provider: 'google',
                        identity_data: {
                          provider_id: '00000000-0000-4000-8000-999999999999',
                          email: 'oauth@studexo.example.com',
                          email_verified: true,
                        },
                      },
                    ],
                  } as unknown as User,
                },
                error: null,
              };
            }
            return {
              data: {
                user: {
                  id: SUB_1,
                  email: 'oauth@studexo.example.com',
                  email_confirmed_at: new Date().toISOString(),
                  app_metadata: { provider: 'github' },
                  identities: [],
                } as unknown as User,
              },
              error: null,
            };
          },
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://mock.studexo.test',
        supabaseAnonKey: 'anon-key',
        client: mockSupaClient as unknown as SupabaseClient,
      });

      const { app, repo } = buildE2EHarness({ tokenVerifierOverride: verifier });

      mode = 'unverified';
      const unverifiedRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(unverifiedRes.status).toBe(403);
      expect(unverifiedRes.body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');

      mode = 'banned';
      const bannedRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(bannedRes.status).toBe(403);
      expect(bannedRes.body.error.code).toBe('AUTH_USER_BANNED');

      mode = 'internal_id_oauth';
      const internalIdRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(internalIdRes.status).toBe(403);
      expect(internalIdRes.body.error.code).toBe('AUTH_PROVIDER_ERROR');

      mode = 'empty_identities_oauth';
      const emptyIdentRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(emptyIdentRes.status).toBe(403);
      expect(emptyIdentRes.body.error.code).toBe('AUTH_PROVIDER_ERROR');

      expect(repo.capturedInserts).toHaveLength(0);
    });
  });

  describe('4. Lifecycle Guards, Purge Blocks, Outages & Configuration Errors', () => {
    it('enforces suspended (403), pending_deletion (403), purgeState!==none (403), and pending-purge outbox (403) across sync and me', async () => {
      const { app, mockVerifier, repo } = buildE2EHarness();

      repo.seedUser({
        user: {
          id: 'user-suspended',
          supabaseAuthUserId: SUB_1,
          primaryEmail: 'susp@studexo.example.com',
          displayName: 'Suspended',
          role: 'student',
          status: 'suspended',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      });

      const suspToken = mockVerifier.mintToken({ sub: SUB_1, email: 'susp@studexo.example.com' });
      expect((await request(app).post('/api/auth/sync').set('Authorization', `Bearer ${suspToken}`)).body.error.code).toBe('AUTH_USER_SUSPENDED');
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${suspToken}`)).body.error.code).toBe('AUTH_USER_SUSPENDED');

      repo.seedUser({
        user: {
          id: 'user-deleting',
          supabaseAuthUserId: SUB_2,
          primaryEmail: 'del@studexo.example.com',
          displayName: 'Deleting',
          role: 'student',
          status: 'pending_deletion',
          purgeState: 'pending_purge',
          deletionRequestedAt: new Date(),
          deletionScheduledFor: new Date(Date.now() + 86400_000),
        },
        identities: [{ provider: 'supabase_email', providerSubject: SUB_2, emailVerified: true }],
      });

      const delToken = mockVerifier.mintToken({ sub: SUB_2, email: 'del@studexo.example.com' });
      expect((await request(app).post('/api/auth/sync').set('Authorization', `Bearer ${delToken}`)).body.error.code).toBe('AUTH_USER_PENDING_DELETION');
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${delToken}`)).body.error.code).toBe('AUTH_USER_PENDING_DELETION');

      // Active outbox purge blocks re-registration via POST /api/auth/sync
      const purgedSub = '00000000-0000-4000-8000-000000000999';
      repo.pendingPurgeSubs.add(purgedSub);
      const purgedToken = mockVerifier.mintToken({ sub: purgedSub, email: 'purged@studexo.example.com' });
      const purgeSync = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${purgedToken}`);
      expect(purgeSync.status).toBe(403);
      expect(purgeSync.body.error.code).toBe('AUTH_PURGE_IN_PROGRESS');
    });

    it('maps GoTrue outages (503) and PostgreSQL outages (503) cleanly without leaking internals in production', async () => {
      let providerOutage = false;
      const mockSupaClient = {
        auth: {
          getUser: async () => {
            if (providerOutage) {
              throw new TypeError('connect ETIMEDOUT https://supabase.internal/auth/v1/user');
            }
            return {
              data: {
                user: {
                  id: SUB_1,
                  email: 'student@studexo.example.com',
                  email_confirmed_at: new Date().toISOString(),
                  app_metadata: { provider: 'email' },
                  identities: [
                    {
                      id: 'id-1',
                      user_id: SUB_1,
                      identity_id: 'ident-1',
                      provider: 'email',
                      identity_data: { email: 'student@studexo.example.com', email_verified: true },
                    },
                  ],
                } as unknown as User,
              },
              error: null,
            };
          },
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://mock.studexo.test',
        supabaseAnonKey: 'anon-key',
        client: mockSupaClient as unknown as SupabaseClient,
      });

      const { app, repo } = buildE2EHarness({ isProduction: true, tokenVerifierOverride: verifier });

      // GoTrue outage on /sync -> 503 AUTH_PROVIDER_UNAVAILABLE
      providerOutage = true;
      const goTrueDown = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(goTrueDown.status).toBe(503);
      expect(goTrueDown.body.error.code).toBe('AUTH_PROVIDER_UNAVAILABLE');
      expect(goTrueDown.body.error.message).toBe('Authentication service is temporarily unavailable');

      // PostgreSQL outage on /sync -> 503 DATABASE_UNAVAILABLE (masked in production, no connection string)
      providerOutage = false;
      repo.throwTransientDbError = true;
      const dbDownSync = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', 'Bearer opaque-token');
      expect(dbDownSync.status).toBe(503);
      expect(dbDownSync.body.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(dbDownSync.body.error.message).toBe('Internal server error');
      expect(JSON.stringify(dbDownSync.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(dbDownSync.body)).not.toContain('postgresql://');

      // PostgreSQL outage on /me -> 503 DATABASE_UNAVAILABLE
      const dbDownMe = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer opaque-token');
      expect(dbDownMe.status).toBe(503);
      expect(dbDownMe.body.error.code).toBe('DATABASE_UNAVAILABLE');
    });

    it('returns 500 AUTH_CONFIGURATION_ERROR when DATABASE_URL is missing while keeping /api/health public and DB lazy', async () => {
      const prodEnv = parseEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://studexo.example.com',
        SUPABASE_URL: 'https://mock.studexo.test',
        SUPABASE_ANON_KEY: 'anon-key',
      });
      const mockVerifier = new MockTokenVerifier();

      const spy = createSpyLogger('info');
      const { app } = createApp({
        env: prodEnv,
        logger: spy.logger,
        checkDatabaseReadiness: async () => ({ configured: false, connected: false }),
        authDependencies: {
          tokenVerifier: mockVerifier,
        },
      });

      const healthRes = await request(app).get('/api/health');
      expect(healthRes.status).toBe(200);
      expect(hasActiveDbClient()).toBe(false);

      const token = mockVerifier.mintToken({ sub: SUB_1, email: 'cfg@studexo.example.com' });

      const syncRes = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${token}`);
      expect(syncRes.status).toBe(500);
      expect(syncRes.body.error.code).toBe('AUTH_CONFIGURATION_ERROR');
      expect(syncRes.body.error.message).toBe('Internal server error');

      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(meRes.status).toBe(500);
      expect(meRes.body.error.code).toBe('AUTH_CONFIGURATION_ERROR');
      expect(hasActiveDbClient()).toBe(false);
    });
  });

  describe('5. Validation, RBAC, CORS, Rate Limiting & Sensitive-Data Guarantees', () => {
    it('rejects spoofed privilege/lifecycle fields (400), enforces RBAC after sync, and leaks zero raw tokens', async () => {
      const { app, apiRouter, authMiddleware, mockVerifier, repo, spy } = buildE2EHarness({
        isProduction: true,
      });

      apiRouter.get('/test/admin-only', ...authMiddleware.requireAdmin, (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const studentToken = mockVerifier.mintToken({
        sub: SUB_1,
        email: 'student@studexo.example.com',
        role: 'admin',
        user_metadata: { role: 'admin' },
      });

      // Privilege / unknown fields in POST /api/auth/sync body must be rejected with 400 VALIDATION_ERROR
      for (const badBody of [
        { role: 'admin' },
        { status: 'active' },
        { supabaseAuthUserId: ADMIN_SUB },
        { primaryEmail: 'hijack@studexo.example.com' },
        { purgeState: 'none' },
        { preferredCurrency: 'TOO_LONG' },
        { displayName: 'A'.repeat(161) },
      ]) {
        const res = await request(app)
          .post('/api/auth/sync')
          .set('Authorization', `Bearer ${studentToken}`)
          .send(badBody);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }

      // Valid sync creates student -> admin-only RBAC route rejects with 403 AUTH_FORBIDDEN
      const syncOk = await request(app)
        .post('/api/auth/sync')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({});
      expect(syncOk.status).toBe(200);
      expect(syncOk.body.user.role).toBe('student');

      const adminDenied = await request(app)
        .get('/api/test/admin-only')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(adminDenied.status).toBe(403);
      expect(adminDenied.body.error.code).toBe('AUTH_FORBIDDEN');

      // Seeded DB admin is granted access
      repo.seedUser({
        user: {
          id: 'user-admin',
          supabaseAuthUserId: ADMIN_SUB,
          primaryEmail: 'admin@studexo.example.com',
          displayName: 'Admin',
          role: 'admin',
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [{ provider: 'supabase_email', providerSubject: ADMIN_SUB, emailVerified: true }],
      });
      const adminToken = mockVerifier.mintToken({ sub: ADMIN_SUB, email: 'admin@studexo.example.com' });
      const adminOk = await request(app)
        .get('/api/test/admin-only')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminOk.status).toBe(200);

      // Verify CORS preflight and zero raw-token leakage in logs/bodies
      const preflightSync = await request(app)
        .options('/api/auth/sync')
        .set('Origin', 'https://studexo.example.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Authorization,Content-Type');
      expect(preflightSync.status).toBe(204);

      expect(JSON.stringify(syncOk.body)).not.toContain(studentToken);
      const logs = spy.getRawOutput();
      expect(logs).not.toContain(studentToken);
      expect(logs).not.toContain(adminToken);
    });

    it('applies API rate limiting to /api/auth/* while leaving /api/health exempt and returns 404 on unknown /api/auth/* routes', async () => {
      const { app, mockVerifier } = buildE2EHarness({ rateLimitMax: 2 });
      const token = mockVerifier.mintToken({ sub: SUB_1, email: 'rate@studexo.example.com' });

      const r1 = await request(app).post('/api/auth/sync').set('Authorization', `Bearer ${token}`);
      const r2 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      const r3 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      const healthRes = await request(app).get('/api/health');
      expect(healthRes.status).toBe(200);

      const { app: unthrottledApp } = buildE2EHarness();
      const unknownAuthRoute = await request(unthrottledApp).get('/api/auth/sync');
      expect(unknownAuthRoute.status).toBe(404);
      expect(unknownAuthRoute.body.error.code).toBe('NOT_FOUND');
    });
  });
});
