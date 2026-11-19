/**
 * Studexo Authentication Repository (Phase 8B.5A Milestone 2)
 *
 * Implements least-privilege database operations for `studexo_app`:
 * 1. Strict 4-column INSERT on `studexo.users` (omitting role, status, purgeState to let DB defaults apply).
 * 2. Deterministic 64-bit transaction-level advisory locking for concurrent first-login safety.
 * 3. Pre-insert account-purge check via `studexo.is_auth_user_pending_purge(uuid)`.
 * 4. Anti-collision email and provider subject guards preventing account takeover.
 */

import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { accountSettings, authIdentities, users } from '../../db/schema/identity';
import {
  AuthError,
  type AuthenticatedUser,
  type AuthoritativeIdentity,
  type SupportedAuthProvider,
} from '../../../shared/types/auth';

export interface UserRecordWithIdentities {
  user: AuthenticatedUser & {
    deletionRequestedAt: Date | null;
    deletionScheduledFor: Date | null;
    purgeState: 'none' | 'pending_purge' | 'purging' | 'purge_failed' | 'purged';
  };
  identities: AuthoritativeIdentity[];
  settings?: {
    preferredLocale: string;
    preferredCurrency: string;
    timezone: string;
    marketingOptIn: boolean;
  } | null;
}

export interface ProvisionUserParams {
  supabaseAuthUserId: string;
  primaryEmail: string;
  displayName?: string | null;
  identities: AuthoritativeIdentity[];
  preferredLocale?: string;
  preferredCurrency?: string;
  timezone?: string;
}

export interface AuthRepository {
  findUserBySupabaseAuthId(supabaseAuthUserId: string): Promise<UserRecordWithIdentities | null>;
  findUserByProviderIdentity(
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<UserRecordWithIdentities | null>;
  findUserByEmail(
    email: string,
  ): Promise<{ id: string; supabaseAuthUserId: string | null; primaryEmail: string } | null>;
  checkIsAuthUserPendingPurge(supabaseAuthUserId: string): Promise<boolean>;
  provisionUserAtomic(params: ProvisionUserParams): Promise<UserRecordWithIdentities>;
  updateIdentityLastSignIn(
    userId: string,
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<void>;
}

/**
 * Canonical email normalization used identically across:
 * 1. Email advisory lock key generation (`deriveEmailProvisionLockId`).
 * 2. Pre-insert collision lookups (`findUserByEmail`, `where(eq(users.primaryEmail, ...))`).
 * 3. Database persistence on `studexo.users.primary_email` and `studexo.auth_identities.email_at_provider`.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonical auth user UUID normalization used identically across:
 * 1. User advisory lock key generation (`deriveUserProvisionLockId`).
 * 2. Pre-insert lookup and collision validation (`findUserBySupabaseAuthId`).
 * 3. Purge check call (`studexo.is_auth_user_pending_purge(uuid)`).
 * 4. Database persistence on `studexo.users.supabase_auth_user_id`.
 */
export function normalizeAuthSub(sub: string): string {
  return sub.trim().toLowerCase();
}

/**
 * Truncates a string to at most `maxChars` Unicode code points safely without breaking
 * surrogate pairs, matching PostgreSQL's `varchar(N)` character semantics.
 */
export function truncateToUnicodeChars(str: string, maxChars: number): string {
  const codePoints = Array.from(str);
  if (codePoints.length <= maxChars) {
    return str;
  }
  return codePoints.slice(0, maxChars).join('');
}

/**
 * Computes a signed 64-bit BigInt advisory lock key bit-for-bit identical to PostgreSQL:
 *   ('x' || substr(md5(lockInput), 1, 16))::bit(64)::bigint
 */
export function deriveUserProvisionLockId(supabaseAuthUserId: string): {
  lockInput: string;
  lockId: bigint;
} {
  const normalizedSub = normalizeAuthSub(supabaseAuthUserId);
  const lockInput = `studexo:user_provision:${normalizedSub}`;
  const md5Hex16 = crypto.createHash('md5').update(lockInput, 'utf8').digest('hex').slice(0, 16);
  const lockId = BigInt.asIntN(64, BigInt(`0x${md5Hex16}`));
  return { lockInput, lockId };
}

/**
 * Computes a signed 64-bit BigInt advisory lock key for email provisioning:
 *   ('x' || substr(md5(lockInput), 1, 16))::bit(64)::bigint
 */
export function deriveEmailProvisionLockId(primaryEmail: string): {
  lockInput: string;
  lockId: bigint;
} {
  const normalizedEmail = normalizeEmail(primaryEmail);
  const lockInput = `studexo:email_provision:${normalizedEmail}`;
  const md5Hex16 = crypto.createHash('md5').update(lockInput, 'utf8').digest('hex').slice(0, 16);
  const lockId = BigInt.asIntN(64, BigInt(`0x${md5Hex16}`));
  return { lockInput, lockId };
}


export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly db: StudexoDatabase) {}

  public async findUserBySupabaseAuthId(
    supabaseAuthUserId: string,
  ): Promise<UserRecordWithIdentities | null> {
    const normalizedAuthId = supabaseAuthUserId.trim().toLowerCase();

    const [userRow] = await this.db
      .select({
        id: users.id,
        supabaseAuthUserId: users.supabaseAuthUserId,
        primaryEmail: users.primaryEmail,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        purgeState: users.purgeState,
        deletionRequestedAt: users.deletionRequestedAt,
        deletionScheduledFor: users.deletionScheduledFor,
      })
      .from(users)
      .where(eq(users.supabaseAuthUserId, normalizedAuthId))
      .limit(1);

    if (!userRow || !userRow.supabaseAuthUserId) {
      return null;
    }

    const [identityRows, [settingsRow]] = await Promise.all([
      this.db
        .select({
          provider: authIdentities.provider,
          providerSubject: authIdentities.providerSubject,
          emailAtProvider: authIdentities.emailAtProvider,
          emailVerified: authIdentities.emailVerified,
        })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userRow.id)),
      this.db
        .select({
          preferredLocale: accountSettings.preferredLocale,
          preferredCurrency: accountSettings.preferredCurrency,
          timezone: accountSettings.timezone,
          marketingOptIn: accountSettings.marketingOptIn,
        })
        .from(accountSettings)
        .where(eq(accountSettings.userId, userRow.id))
        .limit(1),
    ]);

    return {
      user: {
        id: userRow.id,
        supabaseAuthUserId: userRow.supabaseAuthUserId,
        primaryEmail: userRow.primaryEmail,
        displayName: userRow.displayName,
        role: userRow.role,
        status: userRow.status,
        purgeState: userRow.purgeState,
        deletionRequestedAt: userRow.deletionRequestedAt,
        deletionScheduledFor: userRow.deletionScheduledFor,
      },
      identities: identityRows.map((r) => ({
        provider: r.provider,
        providerSubject: r.providerSubject,
        emailAtProvider: r.emailAtProvider ?? undefined,
        emailVerified: r.emailVerified,
      })),
      settings: settingsRow ?? null,
    };
  }

  public async findUserByProviderIdentity(
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<UserRecordWithIdentities | null> {
    const normalizedSubject = providerSubject.trim();

    const [identityRow] = await this.db
      .select({
        userId: authIdentities.userId,
      })
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, provider),
          eq(authIdentities.providerSubject, normalizedSubject),
        ),
      )
      .limit(1);

    if (!identityRow) {
      return null;
    }

    const [userRow] = await this.db
      .select({
        id: users.id,
        supabaseAuthUserId: users.supabaseAuthUserId,
        primaryEmail: users.primaryEmail,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        purgeState: users.purgeState,
        deletionRequestedAt: users.deletionRequestedAt,
        deletionScheduledFor: users.deletionScheduledFor,
      })
      .from(users)
      .where(eq(users.id, identityRow.userId))
      .limit(1);

    if (!userRow || !userRow.supabaseAuthUserId) {
      return null;
    }

    const [identityRows, [settingsRow]] = await Promise.all([
      this.db
        .select({
          provider: authIdentities.provider,
          providerSubject: authIdentities.providerSubject,
          emailAtProvider: authIdentities.emailAtProvider,
          emailVerified: authIdentities.emailVerified,
        })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userRow.id)),
      this.db
        .select({
          preferredLocale: accountSettings.preferredLocale,
          preferredCurrency: accountSettings.preferredCurrency,
          timezone: accountSettings.timezone,
          marketingOptIn: accountSettings.marketingOptIn,
        })
        .from(accountSettings)
        .where(eq(accountSettings.userId, userRow.id))
        .limit(1),
    ]);

    return {
      user: {
        id: userRow.id,
        supabaseAuthUserId: userRow.supabaseAuthUserId,
        primaryEmail: userRow.primaryEmail,
        displayName: userRow.displayName,
        role: userRow.role,
        status: userRow.status,
        purgeState: userRow.purgeState,
        deletionRequestedAt: userRow.deletionRequestedAt,
        deletionScheduledFor: userRow.deletionScheduledFor,
      },
      identities: identityRows.map((r) => ({
        provider: r.provider,
        providerSubject: r.providerSubject,
        emailAtProvider: r.emailAtProvider ?? undefined,
        emailVerified: r.emailVerified,
      })),
      settings: settingsRow ?? null,
    };
  }

  public async findUserByEmail(
    email: string,
  ): Promise<{ id: string; supabaseAuthUserId: string | null; primaryEmail: string } | null> {
    const normalizedEmail = email.trim().toLowerCase();

    const [userRow] = await this.db
      .select({
        id: users.id,
        supabaseAuthUserId: users.supabaseAuthUserId,
        primaryEmail: users.primaryEmail,
      })
      .from(users)
      .where(eq(users.primaryEmail, normalizedEmail))
      .limit(1);

    return userRow ?? null;
  }

  public async checkIsAuthUserPendingPurge(supabaseAuthUserId: string): Promise<boolean> {
    const normalizedAuthId = supabaseAuthUserId.trim().toLowerCase();

    // Call the SECURITY DEFINER function studexo.is_auth_user_pending_purge(uuid)
    const result = await this.db.execute<{ is_pending_purge: boolean }>(
      sql`SELECT studexo.is_auth_user_pending_purge(${normalizedAuthId}::uuid) AS is_pending_purge;`,
    );

    const firstRow = Array.isArray(result) ? result[0] : (result as unknown as { rows?: Array<{ is_pending_purge: boolean }> })?.rows?.[0];
    return Boolean(firstRow?.is_pending_purge);
  }

  public async provisionUserAtomic(params: ProvisionUserParams): Promise<UserRecordWithIdentities> {
    const normalizedAuthId = normalizeAuthSub(params.supabaseAuthUserId);
    const normalizedEmail = normalizeEmail(params.primaryEmail);
    const { lockId: subLockId } = deriveUserProvisionLockId(normalizedAuthId);
    const { lockId: emailLockId } = deriveEmailProvisionLockId(normalizedEmail);

    // Canonical monotonic ascending lock ordering eliminates deadlocks between concurrent provisioning transactions
    const lockIds =
      subLockId === emailLockId
        ? [subLockId]
        : [subLockId, emailLockId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    return this.db.transaction(async (tx) => {
      // 1. Acquire deterministic 64-bit advisory transaction locks (ordered canonically)
      for (const lockId of lockIds) {
        await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${lockId.toString()}::bigint)`);
      }

      // 2. Concurrency re-check inside the lock: did another request already provision this user?
      const [existingUser] = await tx
        .select({
          id: users.id,
          supabaseAuthUserId: users.supabaseAuthUserId,
          primaryEmail: users.primaryEmail,
          displayName: users.displayName,
          role: users.role,
          status: users.status,
          purgeState: users.purgeState,
          deletionRequestedAt: users.deletionRequestedAt,
          deletionScheduledFor: users.deletionScheduledFor,
        })
        .from(users)
        .where(eq(users.supabaseAuthUserId, normalizedAuthId))
        .limit(1);

      if (existingUser && existingUser.supabaseAuthUserId) {
        // Already provisioned by a concurrent request; load identities and return cleanly
        const [identities, [settings]] = await Promise.all([
          tx
            .select({
              provider: authIdentities.provider,
              providerSubject: authIdentities.providerSubject,
              emailAtProvider: authIdentities.emailAtProvider,
              emailVerified: authIdentities.emailVerified,
            })
            .from(authIdentities)
            .where(eq(authIdentities.userId, existingUser.id)),
          tx
            .select({
              preferredLocale: accountSettings.preferredLocale,
              preferredCurrency: accountSettings.preferredCurrency,
              timezone: accountSettings.timezone,
              marketingOptIn: accountSettings.marketingOptIn,
            })
            .from(accountSettings)
            .where(eq(accountSettings.userId, existingUser.id))
            .limit(1),
        ]);

        return {
          user: {
            id: existingUser.id,
            supabaseAuthUserId: existingUser.supabaseAuthUserId,
            primaryEmail: existingUser.primaryEmail,
            displayName: existingUser.displayName,
            role: existingUser.role,
            status: existingUser.status,
            purgeState: existingUser.purgeState,
            deletionRequestedAt: existingUser.deletionRequestedAt,
            deletionScheduledFor: existingUser.deletionScheduledFor,
          },
          identities: identities.map((i) => ({
            provider: i.provider,
            providerSubject: i.providerSubject,
            emailAtProvider: i.emailAtProvider ?? undefined,
            emailVerified: i.emailVerified,
          })),
          settings: settings ?? null,
        };
      }

      // 3. Pre-insert account-purge check
      const purgeResult = await tx.execute<{ is_pending_purge: boolean }>(
        sql`SELECT studexo.is_auth_user_pending_purge(${normalizedAuthId}::uuid) AS is_pending_purge;`,
      );
      const isPurging = Boolean(
        Array.isArray(purgeResult)
          ? purgeResult[0]?.is_pending_purge
          : (purgeResult as unknown as { rows?: Array<{ is_pending_purge: boolean }> })?.rows?.[0]?.is_pending_purge,
      );

      if (isPurging) {
        throw new AuthError(
          'AUTH_PURGE_IN_PROGRESS',
          'External auth identity has an active deletion in progress; registration is blocked until purge completes.',
          { statusCode: 403 },
        );
      }

      // 4. Anti-collision check: verify no other user has claimed this primary email
      const [emailCollision] = await tx
        .select({
          id: users.id,
          supabaseAuthUserId: users.supabaseAuthUserId,
        })
        .from(users)
        .where(eq(users.primaryEmail, normalizedEmail))
        .limit(1);

      if (emailCollision && emailCollision.supabaseAuthUserId !== normalizedAuthId) {
        throw new AuthError(
          'AUTH_IDENTITY_COLLISION',
          'An account with this email address already exists under a different identity provider.',
          { statusCode: 409 },
        );
      }

      // 5. Anti-collision check: verify none of the identities belong to another user
      for (const ident of params.identities) {
        const [identCollision] = await tx
          .select({
            id: authIdentities.id,
            userId: authIdentities.userId,
          })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, ident.provider),
              eq(authIdentities.providerSubject, ident.providerSubject),
            ),
          )
          .limit(1);

        if (identCollision) {
          throw new AuthError(
            'AUTH_IDENTITY_COLLISION',
            `Identity provider account (${ident.provider}:${ident.providerSubject}) is already linked to another user.`,
            { statusCode: 409 },
          );
        }
      }

      // 6. Strict least-privilege INSERT on studexo.users (ONLY 4 COLUMNS: id, supabase_auth_user_id, primary_email, display_name)
      // Never specify role, status, or purgeState in values({...}); let PostgreSQL schema defaults take effect!
      const newUserId = crypto.randomUUID();

      // Enforce the database schema's 160-character display-name limit defensively (Unicode code points)
      const trimmedDisplayName =
        params.displayName && params.displayName.trim().length > 0
          ? truncateToUnicodeChars(params.displayName.trim(), 160)
          : null;

      const [newUserRow] = await tx
        .insert(users)
        .values({
          id: newUserId,
          supabaseAuthUserId: normalizedAuthId,
          primaryEmail: normalizedEmail,
          displayName: trimmedDisplayName,
        })
        .returning({
          id: users.id,
          supabaseAuthUserId: users.supabaseAuthUserId,
          primaryEmail: users.primaryEmail,
          displayName: users.displayName,
          role: users.role,
          status: users.status,
          purgeState: users.purgeState,
          deletionRequestedAt: users.deletionRequestedAt,
          deletionScheduledFor: users.deletionScheduledFor,
        });

      if (!newUserRow || !newUserRow.supabaseAuthUserId) {
        throw new AuthError('AUTH_PROVISIONING_FAILED', 'Failed to create user record in studexo.users.', {
          statusCode: 500,
        });
      }

      // 7. Insert linked identities into studexo.auth_identities
      const createdIdentities: AuthoritativeIdentity[] = [];
      for (const ident of params.identities) {
        await tx.insert(authIdentities).values({
          id: crypto.randomUUID(),
          userId: newUserId,
          provider: ident.provider,
          providerSubject: ident.providerSubject,
          emailAtProvider: ident.emailAtProvider?.toLowerCase() ?? normalizedEmail,
          emailVerified: ident.emailVerified,
          lastSignInAt: new Date(),
        });
        createdIdentities.push({
          provider: ident.provider,
          providerSubject: ident.providerSubject,
          emailAtProvider: ident.emailAtProvider?.toLowerCase() ?? normalizedEmail,
          emailVerified: ident.emailVerified,
        });
      }

      // 8. Insert initial account settings into studexo.account_settings
      const initialSettings = {
        preferredLocale: params.preferredLocale ?? 'en',
        preferredCurrency: params.preferredCurrency ?? 'USD',
        timezone: params.timezone ?? 'Asia/Dhaka',
        marketingOptIn: false,
      };

      await tx.insert(accountSettings).values({
        id: crypto.randomUUID(),
        userId: newUserId,
        preferredLocale: initialSettings.preferredLocale,
        preferredCurrency: initialSettings.preferredCurrency,
        timezone: initialSettings.timezone,
        marketingOptIn: initialSettings.marketingOptIn,
      });

      return {
        user: {
          id: newUserRow.id,
          supabaseAuthUserId: newUserRow.supabaseAuthUserId,
          primaryEmail: newUserRow.primaryEmail,
          displayName: newUserRow.displayName,
          role: newUserRow.role,
          status: newUserRow.status,
          purgeState: newUserRow.purgeState,
          deletionRequestedAt: newUserRow.deletionRequestedAt,
          deletionScheduledFor: newUserRow.deletionScheduledFor,
        },
        identities: createdIdentities,
        settings: initialSettings,
      };
    });
  }

  public async updateIdentityLastSignIn(
    userId: string,
    provider: SupportedAuthProvider,
    providerSubject: string,
  ): Promise<void> {
    await this.db
      .update(authIdentities)
      .set({
        lastSignInAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(authIdentities.userId, userId),
          eq(authIdentities.provider, provider),
          eq(authIdentities.providerSubject, providerSubject),
        ),
      );
  }
}

export function createPostgresAuthRepository(db: StudexoDatabase): AuthRepository {
  return new PostgresAuthRepository(db);
}
