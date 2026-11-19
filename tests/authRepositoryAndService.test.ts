import { describe, expect, it } from 'vitest';
import { AuthError, type AuthoritativeUserPayload, type AuthTokenClaims } from '../src/shared/types/auth';
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

describe('Phase 8B.5A Milestone 2 — Authoritative Identity Resolution, Anti-Collision & Provisioning Engine', () => {
  const SUB_1 = '00000000-0000-4000-8000-000000000001';
  const SUB_2 = '00000000-0000-4000-8000-000000000002';
  const EMAIL_1 = 'student1@studexo.example.com';
  const EMAIL_2 = 'student2@studexo.example.com';

  describe('Advisory Lock Derivation & Canonical Normalization', () => {
    it('normalizes emails and auth UUIDs canonically', () => {
      expect(normalizeEmail('  Alice.Student@Example.COM  ')).toBe('alice.student@example.com');
      expect(normalizeAuthSub('  00000000-0000-4000-8000-000000000001  ')).toBe(SUB_1);
    });

    it('safely truncates display names using Unicode code points without breaking surrogate pairs', () => {
      // 159 ASCII chars + 1 surrogate pair emoji (🎉 = 2 UTF-16 code units) + extra chars
      const emojiString = 'A'.repeat(159) + '🎉' + 'B'.repeat(50);
      const truncated = truncateToUnicodeChars(emojiString, 160);

      // Must be exactly 160 Unicode code points (PostgreSQL varchar(160) limit)
      expect(Array.from(truncated)).toHaveLength(160);
      expect(truncated.endsWith('🎉')).toBe(true);
      // UTF-16 code units length is 161 because emoji is 2 code units
      expect(truncated.length).toBe(161);
    });

    it('derives a deterministic 64-bit signed BigInt user lock key', () => {
      const lock1 = deriveUserProvisionLockId(SUB_1);
      const lock2 = deriveUserProvisionLockId(SUB_1.toUpperCase());
      const lockOther = deriveUserProvisionLockId(SUB_2);

      expect(typeof lock1.lockId).toBe('bigint');
      expect(lock1.lockId).toBe(lock2.lockId);
      expect(lock1.lockId).not.toBe(lockOther.lockId);
      expect(lock1.lockInput).toBe(`studexo:user_provision:${SUB_1}`);
    });

    it('derives a deterministic 64-bit signed BigInt email lock key', () => {
      const lock1 = deriveEmailProvisionLockId(EMAIL_1);
      const lock2 = deriveEmailProvisionLockId(EMAIL_1.toUpperCase());
      const lockOther = deriveEmailProvisionLockId(EMAIL_2);

      expect(typeof lock1.lockId).toBe('bigint');
      expect(lock1.lockId).toBe(lock2.lockId);
      expect(lock1.lockId).not.toBe(lockOther.lockId);
      expect(lock1.lockInput).toBe(`studexo:email_provision:${EMAIL_1}`);
    });
  });

  // In-memory mock repository implementing the exact contract of PostgresAuthRepository
  class MockAuthRepository implements AuthRepository {
    public usersBySub: Map<string, UserRecordWithIdentities> = new Map();
    public usersByEmail: Map<string, { id: string; supabaseAuthUserId: string; primaryEmail: string }> = new Map();
    public identitiesByProviderKey: Map<string, string> = new Map(); // provider:subject -> userId
    public pendingPurgeSubs: Set<string> = new Set();
    public lastSignInUpdates: Array<{ userId: string; provider: string; providerSubject: string }> = [];
    public capturedInserts: Array<ProvisionUserParams> = [];

    public async findUserBySupabaseAuthId(
      supabaseAuthUserId: string,
    ): Promise<UserRecordWithIdentities | null> {
      return this.usersBySub.get(supabaseAuthUserId.toLowerCase()) ?? null;
    }

    public async findUserByProviderIdentity(
      provider: 'supabase_email' | 'google' | 'github',
      providerSubject: string,
    ): Promise<UserRecordWithIdentities | null> {
      const userId = this.identitiesByProviderKey.get(`${provider}:${providerSubject}`);
      if (!userId) return null;
      for (const record of this.usersBySub.values()) {
        if (record.user.id === userId) return record;
      }
      return null;
    }

    public async findUserByEmail(
      email: string,
    ): Promise<{ id: string; supabaseAuthUserId: string | null; primaryEmail: string } | null> {
      return this.usersByEmail.get(email.toLowerCase()) ?? null;
    }

    public async checkIsAuthUserPendingPurge(supabaseAuthUserId: string): Promise<boolean> {
      return this.pendingPurgeSubs.has(supabaseAuthUserId.toLowerCase());
    }

    private activeLocks: Set<string> = new Set();
    private waitQueue: Array<() => void> = [];

    private async acquireCanonicalLocks(keys: string[]): Promise<() => void> {
      const tryAcquire = () => keys.every((k) => !this.activeLocks.has(k));
      while (!tryAcquire()) {
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
        for (const notify of waiters) {
          notify();
        }
      };
    }

    public async provisionUserAtomic(params: ProvisionUserParams): Promise<UserRecordWithIdentities> {
      const normalizedSub = normalizeAuthSub(params.supabaseAuthUserId);
      const normalizedEmail = normalizeEmail(params.primaryEmail);
      const { lockId: subLockId } = deriveUserProvisionLockId(normalizedSub);
      const { lockId: emailLockId } = deriveEmailProvisionLockId(normalizedEmail);

      // Determine canonical lock ordering matching PostgreSQL bigint comparison
      const lockKeys =
        subLockId === emailLockId
          ? [`sub:${normalizedSub}`]
          : subLockId < emailLockId
            ? [`sub:${normalizedSub}`, `email:${normalizedEmail}`]
            : [`email:${normalizedEmail}`, `sub:${normalizedSub}`];

      const releaseLocks = await this.acquireCanonicalLocks(lockKeys);

      try {
        // 1. Concurrency re-check inside the lock: already provisioned by sub
        const existing = this.usersBySub.get(normalizedSub);
        if (existing) {
          return existing;
        }

        // 2. Purge check
        if (this.pendingPurgeSubs.has(normalizedSub)) {
          throw new AuthError(
            'AUTH_PURGE_IN_PROGRESS',
            'External auth identity has an active deletion in progress; registration is blocked until purge completes.',
            { statusCode: 403 },
          );
        }

        // 3. Email collision check (serialized under email lock!)
        const emailMatch = this.usersByEmail.get(normalizedEmail);
        if (emailMatch && emailMatch.supabaseAuthUserId !== normalizedSub) {
          throw new AuthError(
            'AUTH_IDENTITY_COLLISION',
            'An account with this email address already exists under a different identity provider.',
            { statusCode: 409 },
          );
        }

        // 4. Provider identity collision check
        for (const ident of params.identities) {
          const key = `${ident.provider}:${ident.providerSubject}`;
          const existingUserId = this.identitiesByProviderKey.get(key);
          if (existingUserId) {
            throw new AuthError(
              'AUTH_IDENTITY_COLLISION',
              `Identity provider account (${ident.provider}:${ident.providerSubject}) is already linked to another user.`,
              { statusCode: 409 },
            );
          }
        }

        this.capturedInserts.push(params);

        // 5. Enforce 160-char display name limit defensively (Unicode code points)
        const trimmedDisplayName =
          params.displayName && params.displayName.trim().length > 0
            ? truncateToUnicodeChars(params.displayName.trim(), 160)
            : null;

        // 6. Atomic user record creation (strictly 4 columns, defaults apply)
        const newUserId = `user-${normalizedSub}`;
        const userRecord: UserRecordWithIdentities = {
          user: {
            id: newUserId,
            supabaseAuthUserId: normalizedSub,
            primaryEmail: normalizedEmail,
            displayName: trimmedDisplayName,
            role: 'student', // schema default
            status: 'active', // schema default
            purgeState: 'none', // schema default
            deletionRequestedAt: null,
            deletionScheduledFor: null,
          },
          identities: params.identities,
          settings: {
            preferredLocale: params.preferredLocale ?? 'en',
            preferredCurrency: params.preferredCurrency ?? 'USD',
            timezone: params.timezone ?? 'Asia/Dhaka',
            marketingOptIn: false,
          },
        };

        this.usersBySub.set(normalizedSub, userRecord);
        this.usersByEmail.set(normalizedEmail, {
          id: newUserId,
          supabaseAuthUserId: normalizedSub,
          primaryEmail: normalizedEmail,
        });

        for (const ident of params.identities) {
          this.identitiesByProviderKey.set(`${ident.provider}:${ident.providerSubject}`, newUserId);
        }

        return userRecord;
      } finally {
        releaseLocks();
      }
    }

    public async updateIdentityLastSignIn(
      userId: string,
      provider: 'supabase_email' | 'google' | 'github',
      providerSubject: string,
    ): Promise<void> {
      this.lastSignInUpdates.push({ userId, provider, providerSubject });
    }
  }

  describe('AuthService Identity Resolution & Anti-Collision Guards', () => {
    it('successfully resolves an existing active user from verified token claims', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      // Pre-provision a student user
      await repo.provisionUserAtomic({
        supabaseAuthUserId: SUB_1,
        primaryEmail: EMAIL_1,
        displayName: 'Alice Student',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      });

      const claims: AuthTokenClaims = {
        sub: SUB_1,
        email: EMAIL_1,
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };

      const resolved = await service.resolveUserFromClaims(claims);
      expect(resolved.id).toBe(`user-${SUB_1}`);
      expect(resolved.supabaseAuthUserId).toBe(SUB_1);
      expect(resolved.primaryEmail).toBe(EMAIL_1);
      expect(resolved.role).toBe('student');
      expect(resolved.status).toBe('active');
    });

    it('throws AUTH_IDENTITY_NOT_FOUND (404) when token identity has not been provisioned', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const claims: AuthTokenClaims = {
        sub: SUB_2,
        email: EMAIL_2,
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };

      await expect(service.resolveUserFromClaims(claims)).rejects.toThrowError(AuthError);
      try {
        await service.resolveUserFromClaims(claims);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_IDENTITY_NOT_FOUND');
        expect(authErr.statusCode).toBe(404);
      }
    });

    it('throws AUTH_USER_SUSPENDED (403) when user status is suspended', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const record = await repo.provisionUserAtomic({
        supabaseAuthUserId: SUB_1,
        primaryEmail: EMAIL_1,
        displayName: 'Suspended Student',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      });
      record.user.status = 'suspended'; // simulate admin suspension

      const claims: AuthTokenClaims = {
        sub: SUB_1,
        email: EMAIL_1,
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };

      await expect(service.resolveUserFromClaims(claims)).rejects.toThrowError(AuthError);
      try {
        await service.resolveUserFromClaims(claims);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_USER_SUSPENDED');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });

    it('throws AUTH_USER_PENDING_DELETION (403) when user status is pending_deletion or purgeState is not none', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const record = await repo.provisionUserAtomic({
        supabaseAuthUserId: SUB_1,
        primaryEmail: EMAIL_1,
        displayName: 'Departing Student',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      });
      record.user.status = 'pending_deletion';
      record.user.purgeState = 'pending_purge';

      const claims: AuthTokenClaims = {
        sub: SUB_1,
        email: EMAIL_1,
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };

      await expect(service.resolveUserFromClaims(claims)).rejects.toThrowError(AuthError);
      try {
        await service.resolveUserFromClaims(claims);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_USER_PENDING_DELETION');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });
  });

  describe('AuthService Sync & Provisioning Pipeline', () => {
    it('successfully provisions new user, identities, and settings on first login', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const authoritativePayload: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        displayName: 'New Student',
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: SUB_1,
            emailAtProvider: EMAIL_1,
            emailVerified: true,
          },
        ],
      };

      const result = await service.syncAndProvisionUser(authoritativePayload, {
        preferredLocale: 'en',
        preferredCurrency: 'USD',
        timezone: 'Asia/Dhaka',
      });

      expect(result.user.supabaseAuthUserId).toBe(SUB_1);
      expect(result.user.primaryEmail).toBe(EMAIL_1);
      expect(result.user.displayName).toBe('New Student');
      expect(result.user.role).toBe('student');
      expect(result.user.status).toBe('active');
      expect(result.identities).toHaveLength(1);
      expect(result.settings?.timezone).toBe('Asia/Dhaka');
    });

    it('rejects provisioning when user email is not confirmed (AUTH_EMAIL_NOT_VERIFIED)', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const unverifiedPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: null as unknown as Date,
        identities: [{ provider: 'supabase_email' as const, providerSubject: SUB_1, emailVerified: false }],
      };

      await expect(service.syncAndProvisionUser(unverifiedPayload)).rejects.toThrowError(AuthError);
      try {
        await service.syncAndProvisionUser(unverifiedPayload);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_EMAIL_NOT_VERIFIED');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });

    it('rejects provisioning when external identity has an active account purge (AUTH_PURGE_IN_PROGRESS)', async () => {
      const repo = new MockAuthRepository();
      repo.pendingPurgeSubs.add(SUB_1);
      const service = new AuthService(repo);

      const payload: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      };

      await expect(service.syncAndProvisionUser(payload)).rejects.toThrowError(AuthError);
      try {
        await service.syncAndProvisionUser(payload);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_PURGE_IN_PROGRESS');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });

    it('prevents account takeover: rejects linking when incoming email matches an existing account with a different sub (AUTH_IDENTITY_COLLISION)', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      // Victim registers with SUB_1 and EMAIL_1
      await service.syncAndProvisionUser({
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'google', providerSubject: 'google-sub-victim', emailVerified: true }],
      });

      // Attacker attempts to register/sync with SUB_2 but claims the same EMAIL_1
      const collidingPayload: AuthoritativeUserPayload = {
        sub: SUB_2,
        email: EMAIL_1, // colliding email!
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'supabase_email', providerSubject: SUB_2, emailVerified: true }],
      };

      await expect(service.syncAndProvisionUser(collidingPayload)).rejects.toThrowError(AuthError);
      try {
        await service.syncAndProvisionUser(collidingPayload);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_IDENTITY_COLLISION');
        expect(authErr.statusCode).toBe(409);
        expect(authErr.message).toContain('already exists under a different identity provider');
      }
    });

    it('prevents account takeover: rejects linking when provider subject is already linked to another user (AUTH_IDENTITY_COLLISION)', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      // User 1 links Google account "google-sub-123"
      await service.syncAndProvisionUser({
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'google', providerSubject: 'google-sub-123', emailVerified: true }],
      });

      // User 2 attempts to link the same Google account "google-sub-123" under a different email
      const collidingProviderPayload: AuthoritativeUserPayload = {
        sub: SUB_2,
        email: EMAIL_2,
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'google', providerSubject: 'google-sub-123', emailVerified: true }],
      };

      await expect(service.syncAndProvisionUser(collidingProviderPayload)).rejects.toThrowError(AuthError);
      try {
        await service.syncAndProvisionUser(collidingProviderPayload);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_IDENTITY_COLLISION');
        expect(authErr.statusCode).toBe(409);
        expect(authErr.message).toContain('already linked to another user');
      }
    });

    it('guarantees concurrency safety: simultaneous first-login requests resolve cleanly to the single provisioned user', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const payload: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        displayName: 'Concurrent Student',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      };

      // Fire 3 simultaneous provisioning calls for the same sub
      const [res1, res2, res3] = await Promise.all([
        service.syncAndProvisionUser(payload),
        service.syncAndProvisionUser(payload),
        service.syncAndProvisionUser(payload),
      ]);

      expect(res1.user.id).toBe(`user-${SUB_1}`);
      expect(res2.user.id).toBe(`user-${SUB_1}`);
      expect(res3.user.id).toBe(`user-${SUB_1}`);
      // Prove that in-memory repository only recorded exactly 1 provision
      expect(repo.capturedInserts).toHaveLength(1);
    });

    it('resolves user via OAuth external provider subject fallback when claims.providerSubject is present', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      // Pre-provision user with Google identity
      await repo.provisionUserAtomic({
        supabaseAuthUserId: SUB_1,
        primaryEmail: EMAIL_1,
        displayName: 'Google Student',
        identities: [{ provider: 'google', providerSubject: 'google-numeric-sub-98765', emailVerified: true }],
      });

      // Claims where token sub is different (or re-minted) but providerSubject is the external Google subject
      const claimsWithProviderSub: AuthTokenClaims = {
        sub: '00000000-0000-4000-8000-000000000099',
        email: EMAIL_1,
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
        providerSubject: 'google-numeric-sub-98765',
        appMetadata: { provider: 'google' },
      };

      const resolved = await service.resolveUserFromClaims(claimsWithProviderSub);
      expect(resolved.id).toBe(`user-${SUB_1}`);
      expect(resolved.primaryEmail).toBe(EMAIL_1);
    });

    it('does NOT use client-editable user_metadata to resolve provider identity (blocks metadata spoofing)', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      // Pre-provision victim user with Google identity
      await repo.provisionUserAtomic({
        supabaseAuthUserId: SUB_1,
        primaryEmail: EMAIL_1,
        displayName: 'Victim Student',
        identities: [{ provider: 'google', providerSubject: 'google-victim-12345', emailVerified: true }],
      });

      // Attacker has their own GoTrue sub, but attempts to inject victim's provider_id in user_metadata
      const spoofedClaims: AuthTokenClaims = {
        sub: '00000000-0000-4000-8000-000000000999',
        email: 'attacker@studexo.example.com',
        aud: 'authenticated',
        role: 'authenticated',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
        appMetadata: { provider: 'google' },
        userMetadata: {
          sub: 'google-victim-12345',
          provider_id: 'google-victim-12345',
        },
      };

      // Must fail closed with 404 AUTH_IDENTITY_NOT_FOUND, refusing to resolve victim's account
      await expect(service.resolveUserFromClaims(spoofedClaims)).rejects.toThrowError(AuthError);
      try {
        await service.resolveUserFromClaims(spoofedClaims);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_IDENTITY_NOT_FOUND');
        expect((err as AuthError).statusCode).toBe(404);
      }
    });

    it('guarantees email concurrency safety: simultaneous first-login requests from different UUIDs claiming the same email serialize and reject collision', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const payload1: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        displayName: 'User One',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      };

      const payload2: AuthoritativeUserPayload = {
        sub: SUB_2,
        email: EMAIL_1, // SAME EMAIL!
        emailConfirmedAt: new Date(),
        displayName: 'User Two',
        identities: [{ provider: 'supabase_email', providerSubject: SUB_2, emailVerified: true }],
      };

      // Simultaneously attempt to provision two different UUIDs with the same email
      const results = await Promise.allSettled([
        service.syncAndProvisionUser(payload1),
        service.syncAndProvisionUser(payload2),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason as AuthError;
      expect(rejectedError).toBeInstanceOf(AuthError);
      expect(rejectedError.code).toBe('AUTH_IDENTITY_COLLISION');
      expect(rejectedError.statusCode).toBe(409);

      // Exactly 1 user was provisioned into the database
      expect(repo.capturedInserts).toHaveLength(1);
    });

    it('defensively truncates display name exceeding the database 160-character limit', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const overlyLongName = 'LongName'.repeat(30); // 240 chars > 160 chars
      const payload: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        displayName: overlyLongName,
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      };

      const result = await service.syncAndProvisionUser(payload);
      expect(result.user.displayName).not.toBeNull();
      expect(result.user.displayName!.length).toBe(160);
      expect(result.user.displayName).toBe(overlyLongName.slice(0, 160));
    });

    it('subsequent sync for an already provisioned user updates lastSignInAt and does not re-insert', async () => {
      const repo = new MockAuthRepository();
      const service = new AuthService(repo);

      const payload: AuthoritativeUserPayload = {
        sub: SUB_1,
        email: EMAIL_1,
        emailConfirmedAt: new Date(),
        identities: [{ provider: 'supabase_email', providerSubject: SUB_1, emailVerified: true }],
      };

      const firstSync = await service.syncAndProvisionUser(payload);
      expect(repo.capturedInserts).toHaveLength(1);

      const secondSync = await service.syncAndProvisionUser(payload);
      expect(secondSync.user.id).toBe(firstSync.user.id);
      expect(repo.capturedInserts).toHaveLength(1); // not called again!
      expect(repo.lastSignInUpdates).toHaveLength(1);
      expect(repo.lastSignInUpdates[0]!.userId).toBe(firstSync.user.id);
    });
  });
});

