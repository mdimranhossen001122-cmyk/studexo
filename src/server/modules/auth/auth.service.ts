/**
 * Studexo Authentication & Identity Synchronization Service (Phase 8B.5A Milestone 2)
 *
 * Coordinates:
 * 1. Safe identity resolution without email-based auto-linking.
 * 2. Atomic first-login provisioning with advisory lock concurrency protection.
 * 3. Proactive outbox account-purge check before database mutations.
 * 4. Authoritative lifecycle status guards (blocking suspended or pending-deletion accounts).
 */

import {
  AuthError,
  type AuthenticatedUser,
  type AuthoritativeUserPayload,
  type AuthTokenClaims,
} from '../../../shared/types/auth';
import type { AuthRepository, UserRecordWithIdentities } from './auth.repository';
import { mapSupabaseProvider } from './tokenVerifier';

export interface ClientProfilePreferences {
  displayName?: string | null;
  preferredLocale?: string;
  preferredCurrency?: string;
  timezone?: string;
}

export class AuthService {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Resolves an internal Studexo user from verified JWT claims.
   * Enforces lifecycle guards (rejecting suspended and pending-deletion accounts).
   * Throws `AUTH_IDENTITY_NOT_FOUND` (404) if user has not yet been provisioned via `/api/auth/sync`.
   */
  public async resolveUserFromClaims(claims: AuthTokenClaims): Promise<AuthenticatedUser> {
    const normalizedSub = claims.sub.trim().toLowerCase();

    // 1. Direct lookup by Supabase Auth User UUID (sub)
    let record = await this.repo.findUserBySupabaseAuthId(normalizedSub);

    // 2. If not found by sub, check if an authoritative providerSubject was explicitly attested
    if (!record && claims.appMetadata?.provider) {
      const provider = mapSupabaseProvider(claims.appMetadata.provider);
      const providerSubject = claims.providerSubject;

      if (provider !== 'supabase_email' && providerSubject) {
        record = await this.repo.findUserByProviderIdentity(provider, providerSubject);
      }
    }

    if (!record) {
      throw new AuthError(
        'AUTH_IDENTITY_NOT_FOUND',
        'User account has not been provisioned. Please call POST /api/auth/sync to complete onboarding.',
        { statusCode: 404 },
      );
    }

    const { user } = record;

    // 3. Enforce lifecycle status guards
    if (user.status === 'suspended') {
      throw new AuthError('AUTH_USER_SUSPENDED', 'User account is suspended.', { statusCode: 403 });
    }

    if (user.status === 'pending_deletion' || user.purgeState !== 'none') {
      throw new AuthError(
        'AUTH_USER_PENDING_DELETION',
        'User account is pending deletion or purge.',
        { statusCode: 403 },
      );
    }

    return {
      id: user.id,
      supabaseAuthUserId: user.supabaseAuthUserId,
      primaryEmail: user.primaryEmail,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
    };
  }

  /**
   * Synchronizes and provisions an internal Studexo user from authoritative Supabase identity evidence.
   * Required by `POST /api/auth/sync`.
   * Enforces trusted email confirmation, account ban checks, purge checks, anti-collision, and atomic concurrency.
   */
  public async syncAndProvisionUser(
    authoritative: AuthoritativeUserPayload,
    preferences?: ClientProfilePreferences,
  ): Promise<UserRecordWithIdentities> {
    const normalizedSub = authoritative.sub.trim().toLowerCase();
    const normalizedEmail = authoritative.email.trim().toLowerCase();

    // 1. Enforce trusted email confirmation
    if (!authoritative.emailConfirmedAt || isNaN(authoritative.emailConfirmedAt.getTime())) {
      throw new AuthError(
        'AUTH_EMAIL_NOT_VERIFIED',
        'Cannot provision account; user email address is not verified.',
        { statusCode: 403 },
      );
    }

    // 2. Enforce real-time account ban check
    if (authoritative.bannedUntil && authoritative.bannedUntil.getTime() > Date.now()) {
      throw new AuthError(
        'AUTH_USER_BANNED',
        'Cannot provision or access account; user is banned by identity provider.',
        { statusCode: 403 },
      );
    }

    // 3. Pre-check: is an external account purge active for this auth identity?
    const isPurging = await this.repo.checkIsAuthUserPendingPurge(normalizedSub);
    if (isPurging) {
      throw new AuthError(
        'AUTH_PURGE_IN_PROGRESS',
        'External auth identity has an active deletion in progress; registration is blocked until purge completes.',
        { statusCode: 403 },
      );
    }

    // 4. Check if user is already provisioned
    const existing = await this.repo.findUserBySupabaseAuthId(normalizedSub);
    if (existing) {
      // Enforce status checks on existing account
      if (existing.user.status === 'suspended') {
        throw new AuthError('AUTH_USER_SUSPENDED', 'User account is suspended.', { statusCode: 403 });
      }

      if (existing.user.status === 'pending_deletion' || existing.user.purgeState !== 'none') {
        throw new AuthError(
          'AUTH_USER_PENDING_DELETION',
          'User account is pending deletion or purge.',
          { statusCode: 403 },
        );
      }

      // Update last sign in on primary identity if present
      if (authoritative.identities.length > 0) {
        const primaryIdent = authoritative.identities[0]!;
        await this.repo.updateIdentityLastSignIn(
          existing.user.id,
          primaryIdent.provider,
          primaryIdent.providerSubject,
        );
      }

      return existing;
    }

    // 5. Execute atomic, concurrency-safe provisioning under advisory lock
    const displayName = preferences?.displayName ?? authoritative.displayName;

    return this.repo.provisionUserAtomic({
      supabaseAuthUserId: normalizedSub,
      primaryEmail: normalizedEmail,
      displayName,
      identities: authoritative.identities,
      preferredLocale: preferences?.preferredLocale,
      preferredCurrency: preferences?.preferredCurrency,
      timezone: preferences?.timezone,
    });
  }
}

export function createAuthService(repo: AuthRepository): AuthService {
  return new AuthService(repo);
}
