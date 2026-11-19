/**
 * Studexo Shared Authentication Types (Phase 8B.5A Milestone 1)
 *
 * Defines domain contracts for cryptographic claims, authoritative identity verification,
 * and error codes. Free of server-only and browser-only dependencies.
 */

export type AuthErrorCode =
  | 'AUTH_TOKEN_MISSING'
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_INVALID_SIGNATURE'
  | 'AUTH_INVALID_ALGORITHM'
  | 'AUTH_INVALID_AUDIENCE'
  | 'AUTH_INVALID_ISSUER'
  | 'AUTH_EMAIL_REQUIRED'
  | 'AUTH_EMAIL_NOT_VERIFIED'
  | 'AUTH_USER_BANNED'
  | 'AUTH_IDENTITY_NOT_FOUND'
  | 'AUTH_PROVIDER_ERROR'
  | 'AUTH_PURGE_IN_PROGRESS'
  | 'AUTH_IDENTITY_COLLISION'
  | 'AUTH_USER_SUSPENDED'
  | 'AUTH_USER_PENDING_DELETION'
  | 'AUTH_PROVISIONING_FAILED';

export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: AuthErrorCode,
    message: string,
    options?: { statusCode?: number; details?: unknown },
  ) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode =
      options?.statusCode ??
      (code === 'AUTH_EMAIL_NOT_VERIFIED' ||
      code === 'AUTH_USER_BANNED' ||
      code === 'AUTH_PURGE_IN_PROGRESS' ||
      code === 'AUTH_USER_SUSPENDED' ||
      code === 'AUTH_USER_PENDING_DELETION'
        ? 403
        : code === 'AUTH_IDENTITY_COLLISION'
          ? 409
          : code === 'AUTH_IDENTITY_NOT_FOUND'
            ? 404
            : code === 'AUTH_PROVISIONING_FAILED'
              ? 500
              : 401);
    this.details = options?.details;
  }
}

/**
 * Sanitized, parsed claims extracted from a cryptographically valid Supabase JWT.
 * Deliberately excludes the raw Bearer token string to eliminate credential leaks.
 */
export interface AuthTokenClaims {
  /** Supabase Auth User UUID (`auth.users.id`). Lowercased standard UUID. */
  sub: string;
  /** Primary contact email attested by the token. */
  email: string;
  /** Audience claim. Must equal 'authenticated' for standard Supabase access tokens. */
  aud: string;
  /** Supabase DB/PostgREST role (typically 'authenticated', NOT the internal Studexo role). */
  role: string;
  /** ISO Date when token was issued. */
  issuedAt: Date;
  /** ISO Date when token expires. */
  expiresAt: Date;
  /** Supabase GoTrue session ID, if present in claims. */
  sessionId?: string;
  /** External provider subject ID if present in user_metadata or app_metadata. */
  providerSubject?: string;
  /** Provider metadata populated by Supabase Auth engine. */
  appMetadata?: {
    provider?: string;
    providers?: string[];
    [key: string]: unknown;
  };
  /** Safe read-only user metadata copy. Never trusted for security-critical decisions. */
  userMetadata?: Record<string, unknown>;
}

export type SupportedAuthProvider = 'supabase_email' | 'google' | 'github';

/**
 * Verified external identity linked to an authoritative Supabase user.
 * Explicitly distinguishes the Supabase user UUID (`sub`) from the external
 * provider's subject ID (`providerSubject`).
 */
export interface AuthoritativeIdentity {
  provider: SupportedAuthProvider;
  /** Upstream provider subject ID (e.g. Google numeric sub "1092834...", GitHub ID, or Supabase UUID for email). */
  providerSubject: string;
  emailAtProvider?: string;
  emailVerified: boolean;
}

/**
 * Authoritative user profile confirmed by Supabase GoTrue Auth API (`auth.getUser()`).
 * Required by `POST /api/auth/sync` for safe account provisioning.
 */
export interface AuthoritativeUserPayload {
  /** Supabase Auth User UUID. */
  sub: string;
  /** Primary user email. */
  email: string;
  /** Authoritative ISO date when email was confirmed. Mandatory for account provisioning. */
  emailConfirmedAt: Date;
  /** All linked identity records returned by Supabase Auth. */
  identities: AuthoritativeIdentity[];
  /** Optional display name extracted from confirmed provider identity or profile. */
  displayName?: string | null;
  /** Timestamp until which user is banned in Supabase Auth, if active. */
  bannedUntil?: Date | null;
  /** Raw metadata from GoTrue for audit trails. */
  rawAppMetadata?: Record<string, unknown>;
  rawUserMetadata?: Record<string, unknown>;
}

/**
 * Authoritative internal Studexo user attached to `req.user` after database resolution.
 * Represents the PostgreSQL source of truth (`studexo.users.role`).
 */
export interface AuthenticatedUser {
  id: string;
  supabaseAuthUserId: string;
  primaryEmail: string;
  displayName: string | null;
  role: 'student' | 'counselor' | 'admin';
  status: 'active' | 'suspended' | 'pending_deletion';
}
