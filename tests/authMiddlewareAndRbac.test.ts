import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { AuthApiError } from '@supabase/supabase-js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import { hasActiveDbClient } from '../src/server/db/index';
import { createLogger } from '../src/server/lib/logger';
import type { AuthRepository, ProvisionUserParams, UserRecordWithIdentities } from '../src/server/modules/auth/auth.repository';
import { AuthService } from '../src/server/modules/auth/auth.service';
import {
  LocalJwtVerifier,
  MockTokenVerifier,
  SupabaseTokenVerifier,
  type TokenVerifier,
} from '../src/server/modules/auth/tokenVerifier';
import type { SupportedAuthProvider } from '../src/shared/types/auth';

class InMemoryAuthRepository implements AuthRepository {
  public readonly recordsBySub = new Map<string, UserRecordWithIdentities>();
  public readonly recordsByProvider = new Map<string, UserRecordWithIdentities>();
  public throwTransientDbError = false;

  public seedUser(record: UserRecordWithIdentities): void {
    this.recordsBySub.set(record.user.supabaseAuthUserId.toLowerCase(), record);
    for (const ident of record.identities) {
      this.recordsByProvider.set(`${ident.provider}:${ident.providerSubject}`, record);
    }
  }

  public async findUserBySupabaseAuthId(sub: string): Promise<UserRecordWithIdentities | null> {
    if (this.throwTransientDbError) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6543') as Error & { code?: string };
      err.code = 'ECONNREFUSED';
      throw err;
    }
    return this.recordsBySub.get(sub.trim().toLowerCase()) ?? null;
  }

  public async findUserByProviderIdentity(
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<UserRecordWithIdentities | null> {
    return this.recordsByProvider.get(`${provider}:${providerSubject}`) ?? null;
  }

  public async findUserByEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    for (const r of this.recordsBySub.values()) {
      if (r.user.primaryEmail === normalized) {
        return {
          id: r.user.id,
          supabaseAuthUserId: r.user.supabaseAuthUserId,
          primaryEmail: r.user.primaryEmail,
        };
      }
    }
    return null;
  }

  public async checkIsAuthUserPendingPurge(): Promise<boolean> {
    return false;
  }

  public async provisionUserAtomic(_params: ProvisionUserParams): Promise<UserRecordWithIdentities> {
    throw new Error('Not used in Milestone 3 middleware tests');
  }

  public async updateIdentityLastSignIn(): Promise<void> {}
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

describe('Phase 8B.5A Milestone 3 — Two-Tier Express Middleware Pipeline & RBAC Guards', () => {
  const STUDENT_SUB = '00000000-0000-4000-8000-000000000011';
  const COUNSELOR_SUB = '00000000-0000-4000-8000-000000000022';
  const ADMIN_SUB = '00000000-0000-4000-8000-000000000033';
  const SUSPENDED_SUB = '00000000-0000-4000-8000-000000000044';
  const PENDING_DELETION_SUB = '00000000-0000-4000-8000-000000000055';
  const PURGING_STATE_SUB = '00000000-0000-4000-8000-000000000066';
  const UNPROVISIONED_SUB = '00000000-0000-4000-8000-000000000077';

  function buildTestHarness(options: { isProduction?: boolean; tokenVerifierOverride?: TokenVerifier } = {}) {
    const spy = createSpyLogger('info');
    const mockVerifier = new MockTokenVerifier();
    const repo = new InMemoryAuthRepository();
    const authService = new AuthService(repo);

    repo.seedUser({
      user: {
        id: 'user-student-1',
        supabaseAuthUserId: STUDENT_SUB,
        primaryEmail: 'student@studexo.example.com',
        displayName: 'Student One',
        role: 'student',
        status: 'active',
        purgeState: 'none',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: [{ provider: 'supabase_email', providerSubject: STUDENT_SUB, emailVerified: true }],
    });

    repo.seedUser({
      user: {
        id: 'user-counselor-1',
        supabaseAuthUserId: COUNSELOR_SUB,
        primaryEmail: 'counselor@studexo.example.com',
        displayName: 'Counselor One',
        role: 'counselor',
        status: 'active',
        purgeState: 'none',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: [{ provider: 'supabase_email', providerSubject: COUNSELOR_SUB, emailVerified: true }],
    });

    repo.seedUser({
      user: {
        id: 'user-admin-1',
        supabaseAuthUserId: ADMIN_SUB,
        primaryEmail: 'admin@studexo.example.com',
        displayName: 'Admin One',
        role: 'admin',
        status: 'active',
        purgeState: 'none',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: [{ provider: 'supabase_email', providerSubject: ADMIN_SUB, emailVerified: true }],
    });

    repo.seedUser({
      user: {
        id: 'user-suspended-1',
        supabaseAuthUserId: SUSPENDED_SUB,
        primaryEmail: 'suspended@studexo.example.com',
        displayName: 'Suspended User',
        role: 'student',
        status: 'suspended',
        purgeState: 'none',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: [{ provider: 'supabase_email', providerSubject: SUSPENDED_SUB, emailVerified: true }],
    });

    repo.seedUser({
      user: {
        id: 'user-pending-del-1',
        supabaseAuthUserId: PENDING_DELETION_SUB,
        primaryEmail: 'deleting@studexo.example.com',
        displayName: 'Deleting User',
        role: 'student',
        status: 'pending_deletion',
        purgeState: 'pending_purge',
        deletionRequestedAt: new Date(),
        deletionScheduledFor: new Date(Date.now() + 14 * 86400_000),
      },
      identities: [{ provider: 'supabase_email', providerSubject: PENDING_DELETION_SUB, emailVerified: true }],
    });

    repo.seedUser({
      user: {
        id: 'user-purging-state-1',
        supabaseAuthUserId: PURGING_STATE_SUB,
        primaryEmail: 'purging@studexo.example.com',
        displayName: 'Purging State User',
        role: 'student',
        status: 'active',
        purgeState: 'purging',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: [{ provider: 'supabase_email', providerSubject: PURGING_STATE_SUB, emailVerified: true }],
    });

    const env = parseEnv(
      options.isProduction
        ? { NODE_ENV: 'production', APP_URL: 'https://studexo.example.com' }
        : { NODE_ENV: 'test' },
    );

    const ctx = createApp({
      env,
      logger: spy.logger,
      checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
      authDependencies: {
        tokenVerifier: options.tokenVerifierOverride ?? mockVerifier,
        authService,
      },
    });

    const { apiRouter, authMiddleware } = ctx;

    // Tier 1A only (claims without DB lookup)
    apiRouter.get('/test/claims-only', authMiddleware.authenticateBearerClaims, (req, res) => {
      res.status(200).json({ claims: req.authClaims, user: req.user ?? null });
    });

    // Tier 1B (authoritative GoTrue verification)
    apiRouter.post('/test/authoritative', authMiddleware.requireAuthoritativeSession, (req, res) => {
      res.status(200).json({ authoritativeUser: req.authoritativeUser });
    });

    // Tier 1A + Tier 2 (any active authenticated DB user)
    apiRouter.get('/test/me', ...authMiddleware.requireAuth, (req, res) => {
      res.status(200).json({
        user: req.user,
        userFrozen: Object.isFrozen(req.user),
        claimsFrozen: Object.isFrozen(req.authClaims),
      });
    });

    // Tier 3 RBAC routes
    apiRouter.get('/test/student-only', ...authMiddleware.requireStudent, (req, res) => {
      res.status(200).json({ role: req.user?.role });
    });

    apiRouter.get('/test/counselor-only', ...authMiddleware.requireCounselor, (req, res) => {
      res.status(200).json({ role: req.user?.role });
    });

    apiRouter.get('/test/admin-only', ...authMiddleware.requireAdmin, (req, res) => {
      res.status(200).json({ role: req.user?.role });
    });

    apiRouter.get(
      '/test/staff',
      ...authMiddleware.requireAuthRole('counselor', 'admin'),
      (req, res) => {
        res.status(200).json({ role: req.user?.role });
      },
    );

    // Deliberately misconfigured / bypass-attempt routes
    apiRouter.get('/test/bypass-tier1', authMiddleware.resolveDatabaseUser, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    apiRouter.get('/test/bypass-tier2', authMiddleware.requireRole('admin'), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    // Upstream middleware attempts to inject a fake req.user and req.authClaims before requireAuth
    apiRouter.get(
      '/test/spoofed-preseeded-req',
      (req: Request, _res: Response, next: NextFunction) => {
        req.user = {
          id: 'spoofed-id',
          supabaseAuthUserId: ADMIN_SUB,
          primaryEmail: 'spoofed@evil.test',
          displayName: 'Spoofed Admin',
          role: 'admin',
          status: 'active',
        };
        req.authClaims = {
          sub: ADMIN_SUB,
          email: 'spoofed@evil.test',
          aud: 'authenticated',
          role: 'authenticated',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        };
        next();
      },
      ...authMiddleware.requireAdmin,
      (req: Request, res: Response) => {
        res.status(200).json({ user: req.user });
      },
    );

    // Downstream mutation attempt to verify frozen req.user protection
    apiRouter.get('/test/mutate-user', ...authMiddleware.requireAuth, (req, res) => {
      expect(() => {
        (req.user as { role: string }).role = 'admin';
      }).toThrow();
      res.status(200).json({ role: req.user?.role });
    });

    return { ...ctx, mockVerifier, repo, authService, spy };
  }

  describe('Tier 1A: Strict Bearer Extraction & Cryptographic JWT Verification', () => {
    it('rejects missing, non-Bearer, empty, malformed, duplicate, oversized, query-string, and body tokens with 401 + WWW-Authenticate', async () => {
      const { app, mockVerifier } = buildTestHarness();
      const validToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
      });

      const missing = await request(app).get('/api/test/me');
      expect(missing.status).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      expect(missing.body.error.code).toBe('AUTH_TOKEN_MISSING');
      expect(missing.body.error.requestId).toBe(missing.headers['x-request-id']);

      const basicScheme = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Basic ${Buffer.from('a:b').toString('base64')}`);
      expect(basicScheme.status).toBe(401);
      expect(basicScheme.body.error.code).toBe('AUTH_INVALID_TOKEN');

      const emptyBearer = await request(app)
        .get('/api/test/me')
        .set('Authorization', 'Bearer   ');
      expect(emptyBearer.status).toBe(401);
      expect(emptyBearer.body.error.code).toBe('AUTH_TOKEN_MISSING');

      const duplicateTokens = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Bearer ${validToken} extra-token`);
      expect(duplicateTokens.status).toBe(401);
      expect(duplicateTokens.body.error.code).toBe('AUTH_INVALID_TOKEN');

      const commaJoinedDuplicate = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Bearer ${validToken}, Bearer ${validToken}`);
      expect(commaJoinedDuplicate.status).toBe(401);
      expect(commaJoinedDuplicate.body.error.code).toBe('AUTH_INVALID_TOKEN');

      const oversized = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Bearer ${'a'.repeat(10_000)}`);
      expect(oversized.status).toBe(401);
      expect(oversized.body.error.code).toBe('AUTH_INVALID_TOKEN');

      // Tokens passed via query string or JSON body must NEVER be accepted
      const queryOnly = await request(app).get(`/api/test/me?token=${validToken}&access_token=${validToken}`);
      expect(queryOnly.status).toBe(401);
      expect(queryOnly.body.error.code).toBe('AUTH_TOKEN_MISSING');

      const bodyOnly = await request(app).post('/api/test/authoritative').send({ token: validToken });
      expect(bodyOnly.status).toBe(401);
      expect(bodyOnly.body.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('rejects alg=none, tampered signature, expired JWT, and mismatched audience with 401', async () => {
      const { app, mockVerifier } = buildTestHarness();

      const noneToken = mockVerifier.mintToken(
        { sub: STUDENT_SUB, email: 'student@studexo.example.com' },
        { alg: 'none' },
      );
      const noneRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${noneToken}`);
      expect(noneRes.status).toBe(401);
      expect(noneRes.body.error.code).toBe('AUTH_INVALID_ALGORITHM');

      const badSigToken = mockVerifier.mintToken(
        { sub: STUDENT_SUB, email: 'student@studexo.example.com' },
        { mutateSignature: true },
      );
      const badSigRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${badSigToken}`);
      expect(badSigRes.status).toBe(401);
      expect(badSigRes.body.error.code).toBe('AUTH_INVALID_SIGNATURE');

      const expiredToken = mockVerifier.mintToken(
        { sub: STUDENT_SUB, email: 'student@studexo.example.com' },
        { issuedAtOffsetSeconds: -7200, expiresInSeconds: 60 },
      );
      const expRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${expiredToken}`);
      expect(expRes.status).toBe(401);
      expect(expRes.body.error.code).toBe('AUTH_TOKEN_EXPIRED');

      const wrongAudToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
        aud: 'anon',
      });
      const audRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${wrongAudToken}`);
      expect(audRes.status).toBe(401);
      expect(audRes.body.error.code).toBe('AUTH_INVALID_AUDIENCE');
    });

    it('supports real ES256 and RS256 local cryptographic verification through the Express pipeline', async () => {
      const { publicKey: ecPub, privateKey: ecPriv } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const localEsVerifier = new LocalJwtVerifier({
        publicKey: ecPub,
        expectedAudience: 'authenticated',
      });
      const esTokenVerifier: TokenVerifier = {
        verifyToken: async (t) => localEsVerifier.verify(t),
        verifyAuthoritativeUser: async () => {
          throw new Error('Not needed');
        },
      };

      const { app } = buildTestHarness({ tokenVerifierOverride: esTokenVerifier });

      const nowSec = Math.floor(Date.now() / 1000);
      const rawHeader = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
      const rawPayload = Buffer.from(
        JSON.stringify({
          sub: ADMIN_SUB,
          email: 'admin@studexo.example.com',
          aud: 'authenticated',
          role: 'authenticated',
          iat: nowSec,
          exp: nowSec + 3600,
        }),
      ).toString('base64url');
      const signer = crypto.createSign('SHA256');
      signer.update(`${rawHeader}.${rawPayload}`);
      const sig = signer.sign({ key: ecPriv, dsaEncoding: 'ieee-p1363' }, 'base64url');
      const esToken = `${rawHeader}.${rawPayload}.${sig}`;

      const res = await request(app).get('/api/test/admin-only').set('Authorization', `Bearer ${esToken}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('admin');

      // Also verify RS256 through Tier 1A claims-only route (req.authClaims populated, req.user unset)
      const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const localRsVerifier = new LocalJwtVerifier({
        publicKey: rsaPub,
        expectedAudience: 'authenticated',
      });
      const rsTokenVerifier: TokenVerifier = {
        verifyToken: async (t) => localRsVerifier.verify(t),
        verifyAuthoritativeUser: async () => {
          throw new Error('Not needed');
        },
      };
      const { app: rsApp } = buildTestHarness({ tokenVerifierOverride: rsTokenVerifier });

      const rsHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const rsSigner = crypto.createSign('RSA-SHA256');
      rsSigner.update(`${rsHeader}.${rawPayload}`);
      const rsSig = rsSigner.sign(rsaPriv, 'base64url');
      const rsToken = `${rsHeader}.${rawPayload}.${rsSig}`;

      const claimsOnlyRes = await request(rsApp)
        .get('/api/test/claims-only')
        .set('Authorization', `Bearer ${rsToken}`);
      expect(claimsOnlyRes.status).toBe(200);
      expect(claimsOnlyRes.body.claims.sub).toBe(ADMIN_SUB);
      expect(claimsOnlyRes.body.user).toBeNull();
    });
  });

  describe('Tier 1B: Authoritative Verification, Revocation & Outage Handling', () => {
    it('attaches authoritativeUser on valid GoTrue verification and maps revoked (401), banned (403), and outage (503) accurately', async () => {
      let mode: 'valid' | 'revoked' | 'banned' | 'outage' = 'valid';
      const mockSupaClient = {
        auth: {
          getUser: async () => {
            if (mode === 'revoked') {
              return {
                data: { user: null },
                error: new AuthApiError('Session revoked', 401, 'session_not_found'),
              };
            }
            if (mode === 'outage') {
              throw new TypeError('fetch failed');
            }
            return {
              data: {
                user: {
                  id: STUDENT_SUB,
                  email: 'student@studexo.example.com',
                  email_confirmed_at: new Date().toISOString(),
                  banned_until: mode === 'banned' ? new Date(Date.now() + 3600_000).toISOString() : null,
                  app_metadata: { provider: 'email' },
                  user_metadata: { full_name: 'Student Authoritative' },
                  identities: [
                    {
                      id: 'id-1',
                      user_id: STUDENT_SUB,
                      identity_id: 'ident-1',
                      provider: 'email',
                      identity_data: { email: 'student@studexo.example.com', email_verified: true },
                    },
                  ],
                  aud: 'authenticated',
                  created_at: new Date().toISOString(),
                },
              },
              error: null,
            };
          },
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key',
        client: mockSupaClient as unknown as import('@supabase/supabase-js').SupabaseClient,
      });

      const { app } = buildTestHarness({ tokenVerifierOverride: verifier });

      const validRes = await request(app)
        .post('/api/test/authoritative')
        .set('Authorization', 'Bearer opaque-valid-token');
      expect(validRes.status).toBe(200);
      expect(validRes.body.authoritativeUser.sub).toBe(STUDENT_SUB);

      mode = 'revoked';
      const revokedRes = await request(app)
        .post('/api/test/authoritative')
        .set('Authorization', 'Bearer revoked-token');
      expect(revokedRes.status).toBe(401);
      expect(revokedRes.body.error.code).toBe('AUTH_INVALID_TOKEN');
      expect(revokedRes.headers['www-authenticate']).toBe('Bearer');

      mode = 'banned';
      const bannedRes = await request(app)
        .post('/api/test/authoritative')
        .set('Authorization', 'Bearer banned-token');
      expect(bannedRes.status).toBe(403);
      expect(bannedRes.body.error.code).toBe('AUTH_USER_BANNED');

      mode = 'outage';
      const outageRes = await request(app)
        .post('/api/test/authoritative')
        .set('Authorization', 'Bearer any-token');
      expect(outageRes.status).toBe(503);
      expect(outageRes.body.error.code).toBe('AUTH_PROVIDER_UNAVAILABLE');
    });
  });

  describe('Tier 2: Database Identity Resolution & Lifecycle Status Guards', () => {
    it('populates frozen req.user for active DB user and handles unprovisioned (404), suspended (403), pending_deletion (403), purgeState!==none (403), and DB outage (503)', async () => {
      const { app, mockVerifier, repo } = buildTestHarness();

      const activeToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
      });
      const meRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${activeToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user).toEqual({
        id: 'user-student-1',
        supabaseAuthUserId: STUDENT_SUB,
        primaryEmail: 'student@studexo.example.com',
        displayName: 'Student One',
        role: 'student',
        status: 'active',
      });
      expect(meRes.body.userFrozen).toBe(true);
      expect(meRes.body.claimsFrozen).toBe(true);

      const mutateRes = await request(app).get('/api/test/mutate-user').set('Authorization', `Bearer ${activeToken}`);
      expect(mutateRes.status).toBe(200);
      expect(mutateRes.body.role).toBe('student');

      const unprovisionedToken = mockVerifier.mintToken({
        sub: UNPROVISIONED_SUB,
        email: 'newcomer@studexo.example.com',
      });
      const unprovRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${unprovisionedToken}`);
      expect(unprovRes.status).toBe(404);
      expect(unprovRes.body.error.code).toBe('AUTH_IDENTITY_NOT_FOUND');

      const suspendedToken = mockVerifier.mintToken({
        sub: SUSPENDED_SUB,
        email: 'suspended@studexo.example.com',
      });
      const suspRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${suspendedToken}`);
      expect(suspRes.status).toBe(403);
      expect(suspRes.body.error.code).toBe('AUTH_USER_SUSPENDED');

      const pendingDelToken = mockVerifier.mintToken({
        sub: PENDING_DELETION_SUB,
        email: 'deleting@studexo.example.com',
      });
      const delRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${pendingDelToken}`);
      expect(delRes.status).toBe(403);
      expect(delRes.body.error.code).toBe('AUTH_USER_PENDING_DELETION');

      const purgingStateToken = mockVerifier.mintToken({
        sub: PURGING_STATE_SUB,
        email: 'purging@studexo.example.com',
      });
      const purgeRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${purgingStateToken}`);
      expect(purgeRes.status).toBe(403);
      expect(purgeRes.body.error.code).toBe('AUTH_USER_PENDING_DELETION');

      repo.throwTransientDbError = true;
      const dbDownRes = await request(app).get('/api/test/me').set('Authorization', `Bearer ${activeToken}`);
      expect(dbDownRes.status).toBe(503);
      expect(dbDownRes.body.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(JSON.stringify(dbDownRes.body)).not.toContain('ECONNREFUSED');
    });
  });

  describe('Tier 3: DB-Backed RBAC, Spoofing Defense & Middleware Bypass Protection', () => {
    it('enforces explicit DB-role allowlists across student, counselor, and admin routes', async () => {
      const { app, mockVerifier } = buildTestHarness();

      const studentToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
      });
      const counselorToken = mockVerifier.mintToken({
        sub: COUNSELOR_SUB,
        email: 'counselor@studexo.example.com',
      });
      const adminToken = mockVerifier.mintToken({
        sub: ADMIN_SUB,
        email: 'admin@studexo.example.com',
      });

      // Student permissions
      expect((await request(app).get('/api/test/student-only').set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
      expect((await request(app).get('/api/test/counselor-only').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
      const studentAdminRes = await request(app).get('/api/test/admin-only').set('Authorization', `Bearer ${studentToken}`);
      expect(studentAdminRes.status).toBe(403);
      expect(studentAdminRes.body.error.code).toBe('AUTH_FORBIDDEN');
      expect((await request(app).get('/api/test/staff').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);

      // Counselor permissions
      expect((await request(app).get('/api/test/counselor-only').set('Authorization', `Bearer ${counselorToken}`)).status).toBe(200);
      expect((await request(app).get('/api/test/staff').set('Authorization', `Bearer ${counselorToken}`)).status).toBe(200);
      expect((await request(app).get('/api/test/admin-only').set('Authorization', `Bearer ${counselorToken}`)).status).toBe(403);
      expect((await request(app).get('/api/test/student-only').set('Authorization', `Bearer ${counselorToken}`)).status).toBe(403);

      // Admin permissions (explicit allowlist: allowed on admin & staff, denied on student-only)
      expect((await request(app).get('/api/test/admin-only').set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
      expect((await request(app).get('/api/test/staff').set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
      expect((await request(app).get('/api/test/student-only').set('Authorization', `Bearer ${adminToken}`)).status).toBe(403);
    });

    it('blocks privilege escalation from JWT role, metadata claims, custom headers, and pre-seeded req.user', async () => {
      const { app, mockVerifier } = buildTestHarness();

      // Student attempts to elevate via JWT `role`, `app_metadata.role`, `user_metadata.role`, and HTTP header
      const spoofedStudentToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
        role: 'admin',
        app_metadata: { provider: 'email', role: 'admin' },
        user_metadata: { role: 'admin', is_admin: true },
      });

      const adminAttempt = await request(app)
        .get('/api/test/admin-only')
        .set('Authorization', `Bearer ${spoofedStudentToken}`)
        .set('X-User-Role', 'admin')
        .set('X-Role', 'admin');
      expect(adminAttempt.status).toBe(403);
      expect(adminAttempt.body.error.code).toBe('AUTH_FORBIDDEN');

      // Upstream pre-populated req.user / req.authClaims without Bearer token must fail closed with 401
      const noTokenSpoofedReq = await request(app).get('/api/test/spoofed-preseeded-req');
      expect(noTokenSpoofedReq.status).toBe(401);
      expect(noTokenSpoofedReq.body.error.code).toBe('AUTH_TOKEN_MISSING');

      // Upstream pre-populated req.user with student's valid token must resolve student (not spoofed admin) -> 403
      const validStudentSpoofedReq = await request(app)
        .get('/api/test/spoofed-preseeded-req')
        .set('Authorization', `Bearer ${spoofedStudentToken}`);
      expect(validStudentSpoofedReq.status).toBe(403);
      expect(validStudentSpoofedReq.body.error.code).toBe('AUTH_FORBIDDEN');

      // Direct Tier 2 / Tier 3 middleware mounting without Tier 1 fails closed with 401 AUTH_UNAUTHENTICATED
      const bypassTier1 = await request(app).get('/api/test/bypass-tier1');
      expect(bypassTier1.status).toBe(401);
      expect(bypassTier1.body.error.code).toBe('AUTH_UNAUTHENTICATED');

      const bypassTier2 = await request(app).get('/api/test/bypass-tier2');
      expect(bypassTier2.status).toBe(401);
      expect(bypassTier2.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    });

    it('fails fast if requireRole is invoked with zero roles', () => {
      const { authMiddleware } = buildTestHarness();
      expect(() => authMiddleware.requireRole()).toThrow(/at least one allowed role/i);
    });
  });

  describe('Configuration Errors, Public Routes, CORS Compatibility & Zero Token Leakage', () => {
    it('returns 500 AUTH_CONFIGURATION_ERROR (masked in production) when auth env is missing while keeping /api/health public and DB lazy', async () => {
      const prodEnv = parseEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://studexo.example.com',
      });
      const spy = createSpyLogger('info');
      const { app, apiRouter, authMiddleware } = createApp({
        env: prodEnv,
        logger: spy.logger,
        checkDatabaseReadiness: async () => ({ configured: false, connected: false }),
      });

      apiRouter.get('/test/protected-unconfigured', ...authMiddleware.requireAuth, (_req, res) => {
        res.status(200).json({ ok: true });
      });

      // Health stays 200 public and never touches DB pool
      const healthRes = await request(app).get('/api/health');
      expect(healthRes.status).toBe(200);
      expect(hasActiveDbClient()).toBe(false);

      // Protected route with valid-looking Bearer header fails closed with 500 AUTH_CONFIGURATION_ERROR (never 401/403)
      const protectedRes = await request(app)
        .get('/api/test/protected-unconfigured')
        .set('Authorization', 'Bearer header.payload.signature');
      expect(protectedRes.status).toBe(500);
      expect(protectedRes.body.error.code).toBe('AUTH_CONFIGURATION_ERROR');
      expect(protectedRes.body.error.message).toBe('Internal server error');
      expect(JSON.stringify(protectedRes.body)).not.toContain('Supabase');
    });

    it('keeps CORS OPTIONS preflight working on protected routes and never leaks raw Bearer tokens in logs or error payloads', async () => {
      const { app, mockVerifier, spy } = buildTestHarness({ isProduction: true });
      const rawToken = mockVerifier.mintToken({
        sub: STUDENT_SUB,
        email: 'student@studexo.example.com',
      });

      const preflight = await request(app)
        .options('/api/test/admin-only')
        .set('Origin', 'https://studexo.example.com')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'Authorization');
      expect(preflight.status).toBe(204);

      const okRes = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Bearer ${rawToken}`);
      expect(okRes.status).toBe(200);

      const deniedRes = await request(app)
        .get('/api/test/admin-only')
        .set('Authorization', `Bearer ${rawToken}`);
      expect(deniedRes.status).toBe(403);

      const rawBadToken = 'secret-raw-token-string-must-never-leak-12345';
      const invalidRes = await request(app)
        .get('/api/test/me')
        .set('Authorization', `Bearer ${rawBadToken}`);
      expect(invalidRes.status).toBe(401);

      expect(JSON.stringify(okRes.body)).not.toContain(rawToken);
      expect(JSON.stringify(deniedRes.body)).not.toContain(rawToken);
      expect(JSON.stringify(invalidRes.body)).not.toContain(rawBadToken);

      const allLogs = spy.getRawOutput();
      expect(allLogs).not.toContain(rawToken);
      expect(allLogs).not.toContain(rawBadToken);
    });

    it('supports mounting a custom apiRouter via CreateAppOptions before apiNotFoundHandler', async () => {
      const env = parseEnv({ NODE_ENV: 'test' });
      const customApiRouter = express.Router();
      customApiRouter.get('/custom-ping', (_req, res) => {
        res.status(200).json({ pong: true });
      });

      const { app } = createApp({ env, apiRouter: customApiRouter });

      const pingRes = await request(app).get('/api/custom-ping');
      expect(pingRes.status).toBe(200);
      expect(pingRes.body).toEqual({ pong: true });

      const notFoundRes = await request(app).get('/api/nonexistent');
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body.error.code).toBe('NOT_FOUND');
    });
  });
});
