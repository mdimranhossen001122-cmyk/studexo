/**
 * Studexo Cryptographic Token Verifier & Authoritative Identity Engine (Phase 8B.5A Milestone 1)
 *
 * Implements:
 * 1. Cryptographic JWT verification via Node 22 built-in `node:crypto` (supporting HS256/RS256/ES256,
 *    algorithm allowlisting, audience/issuer validation, and zero raw-token retention).
 * 2. Authoritative identity verification via Supabase GoTrue Auth API (`auth.getUser()`), enforcing
 *    trusted email confirmation evidence, real-time ban checking, and provider subject mapping.
 * 3. MockTokenVerifier for comprehensive offline test execution.
 */

import crypto from 'node:crypto';
import {
  createClient,
  isAuthApiError,
  isAuthRetryableFetchError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import {
  AuthError,
  type AuthoritativeIdentity,
  type AuthoritativeUserPayload,
  type AuthTokenClaims,
  type SupportedAuthProvider,
} from '../../../shared/types/auth';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_JWT_ALGORITHMS = new Set(['HS256', 'RS256', 'ES256']);

export interface LocalJwtVerifierOptions {
  jwtSecret?: string;
  publicKey?: string | Buffer | crypto.KeyObject;
  expectedIssuer?: string;
  expectedAudience?: string;
  clockToleranceSeconds?: number;
  allowedAlgorithms?: string[];
}

export interface TokenVerifier {
  /**
   * Cryptographically validates a Bearer JWT access token and returns sanitized claims.
   * Discards the raw token string immediately. Does NOT require external network calls
   * when local secret or public key is configured.
   */
  verifyToken(token: string): Promise<AuthTokenClaims>;

  /**
   * Authoritatively confirms the user session with Supabase GoTrue Auth API (`auth.getUser()`).
   * Validates server-attested `email_confirmed_at`, account ban state, and linked provider identities.
   * Required before provisioning internal `studexo.users` in `/api/auth/sync`.
   */
  verifyAuthoritativeUser(token: string): Promise<AuthoritativeUserPayload>;
}

export interface SupabaseTokenVerifierOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  jwtSecret?: string;
  publicKey?: string | Buffer | crypto.KeyObject;
  expectedAudience?: string;
  requestTimeoutMs?: number;
  client?: SupabaseClient;
}

interface RawJwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

interface RawJwtPayload {
  sub?: string;
  email?: string;
  email_confirmed_at?: string | null;
  aud?: string | string[];
  role?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  iss?: string;
  session_id?: string;
  app_metadata?: {
    provider?: string;
    providers?: string[];
    [key: string]: unknown;
  };
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function base64UrlDecode(str: string): string {
  try {
    return Buffer.from(str, 'base64url').toString('utf8');
  } catch {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Token contains invalid base64url encoding.');
  }
}

export function normalizeVerificationPublicKey(
  rawKey: string | Buffer | crypto.KeyObject,
): crypto.KeyObject | Buffer {
  if (rawKey instanceof crypto.KeyObject) {
    return rawKey;
  }

  if (Buffer.isBuffer(rawKey)) {
    return rawKey;
  }

  const trimmed = rawKey.trim();
  if (!trimmed) {
    throw new AuthError('AUTH_CONFIGURATION_ERROR', 'Configured JWT verification public key is empty.');
  }

  if (trimmed.startsWith('{')) {
    try {
      const jwk = JSON.parse(trimmed) as crypto.JsonWebKey;
      return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new AuthError(
        'AUTH_CONFIGURATION_ERROR',
        'Configured JWT verification JWK public key is invalid.',
      );
    }
  }

  const normalizedPem = trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  try {
    return crypto.createPublicKey(normalizedPem);
  } catch {
    throw new AuthError(
      'AUTH_CONFIGURATION_ERROR',
      'Configured JWT verification PEM public key is invalid.',
    );
  }
}

/**
 * Pure cryptographic JWT verifier using Node 22 built-in `node:crypto`.
 * Enforces algorithm allowlisting, timing-safe signature comparison, expiry, issuer, and audience.
 */
export class LocalJwtVerifier {
  private readonly jwtSecret?: string;
  private readonly publicKey?: crypto.KeyObject | Buffer;
  private readonly publicKeyConfigError?: AuthError;
  private readonly expectedIssuer?: string;
  private readonly expectedAudience: string;
  private readonly clockToleranceSeconds: number;
  private readonly allowedAlgorithms: Set<string>;

  constructor(options: LocalJwtVerifierOptions = {}) {
    this.jwtSecret = options.jwtSecret?.trim() || undefined;
    this.expectedIssuer = options.expectedIssuer?.trim();
    this.expectedAudience = options.expectedAudience ?? 'authenticated';
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;

    if (options.publicKey !== undefined) {
      try {
        this.publicKey = normalizeVerificationPublicKey(options.publicKey);
      } catch (err) {
        if (err instanceof AuthError) {
          this.publicKeyConfigError = err;
        } else {
          this.publicKeyConfigError = new AuthError(
            'AUTH_CONFIGURATION_ERROR',
            'Configured JWT verification public key is invalid.',
          );
        }
      }
    }

    if (options.allowedAlgorithms) {
      this.allowedAlgorithms = new Set(
        options.allowedAlgorithms.map((a) => a.toUpperCase()).filter((a) => a !== 'NONE'),
      );
    } else {
      const derived = new Set<string>();
      if (this.jwtSecret) {
        derived.add('HS256');
      }
      if (this.publicKey) {
        if (this.publicKey instanceof crypto.KeyObject) {
          if (this.publicKey.asymmetricKeyType === 'ec') {
            derived.add('ES256');
          } else if (
            this.publicKey.asymmetricKeyType === 'rsa' ||
            this.publicKey.asymmetricKeyType === 'rsa-pss'
          ) {
            derived.add('RS256');
          } else {
            derived.add('RS256');
            derived.add('ES256');
          }
        } else {
          derived.add('RS256');
          derived.add('ES256');
        }
      }
      // If neither secret nor key is configured yet, preserve default set so verify() raises AUTH_CONFIGURATION_ERROR
      this.allowedAlgorithms = derived.size > 0 ? derived : new Set(ALLOWED_JWT_ALGORITHMS);
    }
  }

  public verify(token: string): AuthTokenClaims {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new AuthError('AUTH_TOKEN_MISSING', 'Authentication token is missing or empty.');
    }

    if (this.publicKeyConfigError) {
      throw this.publicKeyConfigError;
    }

    if (!this.jwtSecret && !this.publicKey) {
      throw new AuthError(
        'AUTH_CONFIGURATION_ERROR',
        'Local JWT verification is not configured with a signing secret or public key.',
      );
    }

    const segments = token.trim().split('.');
    if (segments.length !== 3) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed token format; expected 3 segments.');
    }

    const rawHeader = segments[0]!;
    const rawPayload = segments[1]!;
    const rawSignature = segments[2]!;

    // 1. Decode and validate header
    let header: RawJwtHeader;
    try {
      header = JSON.parse(base64UrlDecode(rawHeader));
    } catch {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed JWT header JSON.');
    }

    if (!header || typeof header !== 'object' || typeof header.alg !== 'string') {
      throw new AuthError('AUTH_INVALID_TOKEN', 'JWT header missing algorithm parameter.');
    }

    const alg = header.alg.toUpperCase();
    if (alg === 'NONE' || !this.allowedAlgorithms.has(alg)) {
      throw new AuthError(
        'AUTH_INVALID_ALGORITHM',
        `Unsupported or forbidden JWT algorithm: "${header.alg}".`,
      );
    }

    // 2. Cryptographic signature validation
    const signedData = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');

    if (alg === 'HS256') {
      if (!this.jwtSecret) {
        throw new AuthError(
          'AUTH_CONFIGURATION_ERROR',
          'Local HS256 verification requested, but SUPABASE_JWT_SECRET is not configured.',
        );
      }

      const expectedSignature = crypto
        .createHmac('sha256', this.jwtSecret)
        .update(signedData)
        .digest('base64url');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      const actualBuffer = Buffer.from(rawSignature, 'utf8');

      if (
        expectedBuffer.length !== actualBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
      ) {
        throw new AuthError('AUTH_INVALID_SIGNATURE', 'Cryptographic signature verification failed.');
      }
    } else if (alg === 'RS256' || alg === 'ES256') {
      if (!this.publicKey) {
        throw new AuthError(
          'AUTH_CONFIGURATION_ERROR',
          `Local ${alg} verification requested, but public key is not configured.`,
        );
      }

      const verifier = crypto.createVerify(alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
      verifier.update(signedData);

      let isValid: boolean;
      try {
        const sigBuffer = Buffer.from(rawSignature, 'base64url');
        if (alg === 'ES256') {
          // RFC 7518 Section 3.4 requires IEEE P1363 (64 bytes) for ECDSA P-256 JWT signatures
          const verifyKeyInput: crypto.VerifyKeyObjectInput | crypto.VerifyPublicKeyInput =
            this.publicKey instanceof crypto.KeyObject
              ? {
                  key: this.publicKey,
                  dsaEncoding: sigBuffer.length === 64 ? 'ieee-p1363' : 'der',
                }
              : {
                  key: this.publicKey,
                  dsaEncoding: sigBuffer.length === 64 ? 'ieee-p1363' : 'der',
                };
          isValid = verifier.verify(verifyKeyInput, sigBuffer);
        } else {
          isValid = verifier.verify(this.publicKey, sigBuffer);
        }
      } catch (cryptoErr) {
        throw new AuthError('AUTH_INVALID_SIGNATURE', 'Signature check encountered cryptographic error.', {
          details: cryptoErr instanceof Error ? cryptoErr.message : String(cryptoErr),
        });
      }

      if (!isValid) {
        throw new AuthError('AUTH_INVALID_SIGNATURE', 'Cryptographic signature verification failed.');
      }
    } else {
      throw new AuthError('AUTH_INVALID_ALGORITHM', `Unhandled allowed algorithm "${alg}".`);
    }

    // 3. Decode and validate payload
    let payload: RawJwtPayload;
    try {
      payload = JSON.parse(base64UrlDecode(rawPayload));
    } catch {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed JWT payload JSON.');
    }

    if (!payload || typeof payload !== 'object') {
      throw new AuthError('AUTH_INVALID_TOKEN', 'JWT payload is not a valid JSON object.');
    }

    // 4. Validate temporal claims (exp, nbf, iat)
    const nowSec = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'JWT payload missing valid numeric exp claim.');
    }

    if (payload.exp <= nowSec - this.clockToleranceSeconds) {
      throw new AuthError('AUTH_TOKEN_EXPIRED', 'Authentication token has expired.');
    }

    if (
      typeof payload.nbf === 'number' &&
      Number.isFinite(payload.nbf) &&
      payload.nbf > nowSec + this.clockToleranceSeconds
    ) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Authentication token is not yet valid (nbf).');
    }

    // 5. Validate audience
    if (this.expectedAudience) {
      const aud = payload.aud;
      const audienceMatches = Array.isArray(aud)
        ? aud.includes(this.expectedAudience)
        : aud === this.expectedAudience;

      if (!audienceMatches) {
        throw new AuthError(
          'AUTH_INVALID_AUDIENCE',
          `JWT audience mismatch; expected "${this.expectedAudience}".`,
        );
      }
    }

    // 6. Validate issuer
    if (this.expectedIssuer && payload.iss !== this.expectedIssuer) {
      throw new AuthError(
        'AUTH_INVALID_ISSUER',
        `JWT issuer mismatch; expected "${this.expectedIssuer}".`,
      );
    }

    // 7. Validate identity claims (sub, email)
    if (typeof payload.sub !== 'string' || !UUID_REGEX.test(payload.sub.trim())) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'JWT sub claim must be a valid UUID.');
    }

    if (typeof payload.email !== 'string' || payload.email.trim().length === 0 || !payload.email.includes('@')) {
      throw new AuthError('AUTH_EMAIL_REQUIRED', 'JWT payload missing valid email claim.');
    }

    // Do NOT trust user-editable user_metadata for identity resolution.
    // Provider subject must come strictly from authoritative GoTrue identities[] during sync
    // or server-attested app_metadata.
    let providerSubject: string | undefined;
    if (typeof payload.app_metadata?.provider_id === 'string' && payload.app_metadata.provider_id.trim()) {
      providerSubject = payload.app_metadata.provider_id.trim();
    } else if (typeof payload.app_metadata?.provider_subject === 'string' && payload.app_metadata.provider_subject.trim()) {
      providerSubject = payload.app_metadata.provider_subject.trim();
    }

    // Return sanitized claims without raw token credential
    return {
      sub: payload.sub.trim().toLowerCase(),
      email: payload.email.trim().toLowerCase(),
      aud: Array.isArray(payload.aud) ? payload.aud.join(',') : String(payload.aud ?? ''),
      role: String(payload.role ?? 'authenticated'),
      issuedAt: new Date((payload.iat ?? nowSec) * 1000),
      expiresAt: new Date(payload.exp * 1000),
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      providerSubject,
      appMetadata: payload.app_metadata && typeof payload.app_metadata === 'object' ? payload.app_metadata : undefined,
      userMetadata: payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : undefined,
    };
  }
}

/**
 * Maps raw provider strings from Supabase GoTrue identities to Studexo `SupportedAuthProvider`.
 */
export function mapSupabaseProvider(rawProvider?: string): SupportedAuthProvider {
  const normalized = (rawProvider ?? '').trim().toLowerCase();
  if (normalized === 'google') return 'google';
  if (normalized === 'github') return 'github';
  return 'supabase_email';
}

function parseOAuthSubjectCandidate(
  value: unknown,
  fieldName: string,
  provider: 'google' | 'github',
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new AuthError(
        'AUTH_PROVIDER_ERROR',
        `Authoritative ${provider} identity contains empty ${fieldName}.`,
        { statusCode: 403 },
      );
    }
    return trimmed;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  throw new AuthError(
    'AUTH_PROVIDER_ERROR',
    `Authoritative ${provider} identity contains invalid ${fieldName}.`,
    { statusCode: 403 },
  );
}

function extractStrictOAuthProviderSubject(
  ident: NonNullable<User['identities']>[number],
  provider: 'google' | 'github',
  normalizedUserId: string,
): string {
  if (!ident.identity_data || typeof ident.identity_data !== 'object' || Array.isArray(ident.identity_data)) {
    throw new AuthError(
      'AUTH_PROVIDER_ERROR',
      `Authoritative ${provider} identity is missing identity_data.`,
      { statusCode: 403 },
    );
  }

  // Only accept external provider subject evidence from authoritative Supabase identity_data
  // (never fall back to ident.id, ident.identity_id, or user.id).
  const dataProviderId = parseOAuthSubjectCandidate(
    ident.identity_data.provider_id,
    'identity_data.provider_id',
    provider,
  );
  const dataSub = parseOAuthSubjectCandidate(ident.identity_data.sub, 'identity_data.sub', provider);
  const topLevelProviderId = parseOAuthSubjectCandidate(
    (ident as unknown as { provider_id?: unknown })?.provider_id,
    'provider_id',
    provider,
  );

  const identityDataCandidates = [dataProviderId, dataSub].filter((v): v is string => v !== undefined);
  if (identityDataCandidates.length === 0) {
    throw new AuthError(
      'AUTH_PROVIDER_ERROR',
      `Authoritative ${provider} identity is missing external provider subject in identity_data.`,
      { statusCode: 403 },
    );
  }

  const allCandidates =
    topLevelProviderId !== undefined ? [...identityDataCandidates, topLevelProviderId] : identityDataCandidates;
  const distinctCandidates = new Set(allCandidates);

  if (distinctCandidates.size > 1) {
    throw new AuthError(
      'AUTH_PROVIDER_ERROR',
      `Authoritative ${provider} identity has ambiguous or conflicting provider subjects.`,
      { statusCode: 403 },
    );
  }

  const resolvedSubject = identityDataCandidates[0]!;
  const normalizedSubject = resolvedSubject.toLowerCase();
  const normalizedIdentityRecordId =
    typeof ident.identity_id === 'string' ? ident.identity_id.trim().toLowerCase() : '';
  const normalizedIdentUserId =
    typeof ident.user_id === 'string' ? ident.user_id.trim().toLowerCase() : '';

  if (
    normalizedSubject === normalizedUserId ||
    (normalizedIdentUserId.length > 0 && normalizedSubject === normalizedIdentUserId) ||
    (normalizedIdentityRecordId.length > 0 && normalizedSubject === normalizedIdentityRecordId) ||
    UUID_REGEX.test(resolvedSubject)
  ) {
    throw new AuthError(
      'AUTH_PROVIDER_ERROR',
      `Authoritative ${provider} provider subject cannot be an internal Supabase UUID or identity record ID.`,
      { statusCode: 403 },
    );
  }

  return resolvedSubject;
}

/**
 * Extracts and confirms trusted email verification evidence from an authoritative Supabase `User` object.
 * Rejects accounts without confirmed email timestamps or valid provider attestation.
 */
export function extractVerifiedIdentities(user: User): {
  email: string;
  emailConfirmedAt: Date;
  identities: AuthoritativeIdentity[];
} {
  if (typeof user.id !== 'string' || !UUID_REGEX.test(user.id.trim())) {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Authoritative Supabase user lacks a valid UUID identifier.');
  }
  const normalizedUserId = user.id.trim().toLowerCase();

  const primaryEmail = (user.email ?? '').trim().toLowerCase();
  if (!primaryEmail || !primaryEmail.includes('@')) {
    throw new AuthError('AUTH_EMAIL_REQUIRED', 'Authoritative Supabase user lacks a primary email address.');
  }

  // Authoritative email confirmation timestamp check
  let confirmedDate: Date | null = null;
  if (user.email_confirmed_at && !isNaN(Date.parse(user.email_confirmed_at))) {
    confirmedDate = new Date(user.email_confirmed_at);
  } else if (user.confirmed_at && !isNaN(Date.parse(user.confirmed_at))) {
    confirmedDate = new Date(user.confirmed_at);
  }

  const rawIdentities = Array.isArray(user.identities) ? user.identities : [];
  const authoritativeIdentities: AuthoritativeIdentity[] = [];

  for (const ident of rawIdentities) {
    const provider = mapSupabaseProvider(ident.provider);
    const providerSubject =
      provider === 'supabase_email'
        ? normalizedUserId
        : extractStrictOAuthProviderSubject(ident, provider, normalizedUserId);

    const identEmail = typeof ident.identity_data?.email === 'string' ? ident.identity_data.email.toLowerCase() : undefined;
    const isVerifiedAtProvider = Boolean(ident.identity_data?.email_verified ?? confirmedDate !== null);

    authoritativeIdentities.push({
      provider,
      providerSubject,
      emailAtProvider: identEmail,
      emailVerified: isVerifiedAtProvider,
    });
  }

  // If no identities array was populated by GoTrue, ONLY supabase_email may retain its Supabase UUID mapping.
  // Never synthesize google or github identities when identities[] is empty.
  if (authoritativeIdentities.length === 0) {
    const provider = mapSupabaseProvider(user.app_metadata?.provider);
    if (provider !== 'supabase_email') {
      throw new AuthError(
        'AUTH_PROVIDER_ERROR',
        `Authoritative ${provider} user is missing required provider identity records.`,
        { statusCode: 403 },
      );
    }

    authoritativeIdentities.push({
      provider: 'supabase_email',
      providerSubject: normalizedUserId,
      emailAtProvider: primaryEmail,
      emailVerified: confirmedDate !== null,
    });
  }

  // Cross-check: If email_confirmed_at was missing, check if third-party OAuth provider verified the exact primary email
  if (!confirmedDate) {
    const matchingVerifiedOAuth = authoritativeIdentities.find(
      (i) => i.provider !== 'supabase_email' && i.emailVerified && i.emailAtProvider === primaryEmail,
    );
    if (matchingVerifiedOAuth) {
      confirmedDate = new Date();
    }
  }

  if (!confirmedDate) {
    throw new AuthError(
      'AUTH_EMAIL_NOT_VERIFIED',
      'User email address has not been confirmed with the identity provider.',
      { statusCode: 403 },
    );
  }

  return {
    email: primaryEmail,
    emailConfirmedAt: confirmedDate,
    identities: authoritativeIdentities,
  };
}

/**
 * Production-ready SupabaseTokenVerifier.
 * - `verifyToken`: executes local cryptographic check when secret/public key is configured,
 *   or delegates to Supabase GoTrue Auth API.
 * - `verifyAuthoritativeUser`: calls `auth.getUser(token)` to verify real-time user existence,
 *   email confirmation, ban status, and linked identities.
 */
export class SupabaseTokenVerifier implements TokenVerifier {
  private readonly supabaseClient: SupabaseClient;
  private readonly localVerifier?: LocalJwtVerifier;
  private readonly requestTimeoutMs: number;

  constructor(options: SupabaseTokenVerifierOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const supabaseUrl = options.supabaseUrl.trim().replace(/\/+$/, '');
    const supabaseAnonKey = options.supabaseAnonKey.trim();

    this.supabaseClient =
      options.client ??
      createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });

    if (options.jwtSecret || options.publicKey) {
      this.localVerifier = new LocalJwtVerifier({
        jwtSecret: options.jwtSecret,
        publicKey: options.publicKey,
        expectedAudience: options.expectedAudience ?? 'authenticated',
        expectedIssuer: `${supabaseUrl}/auth/v1`,
      });
    }
  }

  public async verifyToken(token: string): Promise<AuthTokenClaims> {
    // 1. Fast local verification if secret or public key is available
    if (this.localVerifier) {
      return this.localVerifier.verify(token);
    }

    // 2. Authoritative check via getUser if local secret is not configured
    const userPayload = await this.verifyAuthoritativeUser(token);
    const now = new Date();

    return {
      sub: userPayload.sub,
      email: userPayload.email,
      aud: 'authenticated',
      role: 'authenticated',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 3600 * 1000),
      appMetadata: userPayload.rawAppMetadata,
      userMetadata: userPayload.rawUserMetadata,
    };
  }

  public async verifyAuthoritativeUser(token: string): Promise<AuthoritativeUserPayload> {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new AuthError('AUTH_TOKEN_MISSING', 'Authentication token is required for identity verification.');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new AuthError(
              'AUTH_PROVIDER_UNAVAILABLE',
              'Identity provider verification timed out.',
              { statusCode: 503 },
            ),
          );
        }, this.requestTimeoutMs);
        timer.unref?.();
      });

      const { data, error } = await Promise.race([
        this.supabaseClient.auth.getUser(token.trim()),
        timeoutPromise,
      ]);

      if (error || !data.user) {
        if (isAuthRetryableFetchError(error)) {
          throw new AuthError(
            'AUTH_PROVIDER_UNAVAILABLE',
            'Identity provider is temporarily unreachable.',
            { statusCode: 503 },
          );
        }

        if (isAuthApiError(error)) {
          if (error.status >= 500 || error.status === 429 || error.status === 0) {
            throw new AuthError(
              'AUTH_PROVIDER_UNAVAILABLE',
              'Identity provider returned an upstream error.',
              { statusCode: 503 },
            );
          }
          if (error.code === 'user_banned') {
            throw new AuthError(
              'AUTH_USER_BANNED',
              'Account has been banned by identity provider administrator.',
              { statusCode: 403 },
            );
          }
          if (
            error.status === 401 ||
            error.code === 'bad_jwt' ||
            error.code === 'invalid_jwt' ||
            error.code === 'session_not_found' ||
            error.code === 'user_not_found'
          ) {
            throw new AuthError('AUTH_INVALID_TOKEN', error.message);
          }
          if (error.status === 403) {
            throw new AuthError('AUTH_INVALID_AUDIENCE', error.message, { statusCode: 403 });
          }
          throw new AuthError('AUTH_INVALID_TOKEN', error.message);
        }

        if (error) {
          const rawStatus = (error as { status?: unknown }).status;
          if (typeof rawStatus !== 'number' || rawStatus === 0 || rawStatus >= 500) {
            throw new AuthError(
              'AUTH_PROVIDER_UNAVAILABLE',
              'Identity provider is temporarily unavailable.',
              { statusCode: 503 },
            );
          }
          throw new AuthError('AUTH_INVALID_TOKEN', error.message);
        }

        throw new AuthError('AUTH_INVALID_TOKEN', 'User session is invalid or revoked.');
      }

      const user = data.user;

      // Check account ban status
      if (user.banned_until) {
        const banExpiry = Date.parse(user.banned_until);
        if (!isNaN(banExpiry) && banExpiry > Date.now()) {
          throw new AuthError('AUTH_USER_BANNED', 'Account has been banned by identity provider administrator.', {
            statusCode: 403,
          });
        }
      }

      const verified = extractVerifiedIdentities(user);
      const displayName =
        (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim().length > 0
          ? user.user_metadata.full_name.trim()
          : typeof user.user_metadata?.name === 'string' && user.user_metadata.name.trim().length > 0
            ? user.user_metadata.name.trim()
            : null);

      return {
        sub: user.id.toLowerCase(),
        email: verified.email,
        emailConfirmedAt: verified.emailConfirmedAt,
        identities: verified.identities,
        displayName,
        bannedUntil: user.banned_until ? new Date(user.banned_until) : null,
        rawAppMetadata: user.app_metadata,
        rawUserMetadata: user.user_metadata,
      };
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        'AUTH_PROVIDER_UNAVAILABLE',
        'Identity provider verification failed due to a network or upstream outage.',
        { statusCode: 503 },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Offline MockTokenVerifier for Vitest test suites.
 * Capable of minting synthetic cryptographically valid tokens using `node:crypto`
 * and returning deterministic claims and authoritative payloads without network calls.
 */
export class MockTokenVerifier implements TokenVerifier {
  public defaultSecret: string = 'test-mock-secret-for-offline-vitest-suites-32-bytes-long';
  public localVerifier: LocalJwtVerifier;
  public mockAuthoritativeUsers: Map<string, AuthoritativeUserPayload> = new Map();

  constructor(secret?: string) {
    if (secret) {
      this.defaultSecret = secret;
    }
    this.localVerifier = new LocalJwtVerifier({
      jwtSecret: this.defaultSecret,
      expectedAudience: 'authenticated',
    });
  }

  /**
   * Helper to mint synthetic signed tokens using `node:crypto` for cryptographic tests.
   */
  public mintToken(
    claims: Partial<RawJwtPayload> & { sub: string; email: string },
    options: {
      secret?: string;
      alg?: string;
      expiresInSeconds?: number;
      issuedAtOffsetSeconds?: number;
      mutateSignature?: boolean;
      customHeader?: Record<string, unknown>;
    } = {},
  ): string {
    const nowSec = Math.floor(Date.now() / 1000) + (options.issuedAtOffsetSeconds ?? 0);
    const expSec = nowSec + (options.expiresInSeconds ?? 3600);

    const header = options.customHeader ?? {
      alg: options.alg ?? 'HS256',
      typ: 'JWT',
    };

    const payload: RawJwtPayload = {
      aud: 'authenticated',
      role: 'authenticated',
      iat: nowSec,
      exp: expSec,
      iss: 'https://mock.studexo.test/auth/v1',
      ...claims,
      sub: claims.sub,
      email: claims.email,
    };

    const rawHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const rawPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const secret = options.secret ?? this.defaultSecret;

    let signature: string;
    if (header.alg === 'HS256') {
      signature = crypto
        .createHmac('sha256', secret)
        .update(`${rawHeader}.${rawPayload}`)
        .digest('base64url');
    } else if (header.alg === 'none') {
      signature = '';
    } else {
      signature = Buffer.from('mock-unsupported-sig').toString('base64url');
    }

    if (options.mutateSignature) {
      signature = signature.split('').reverse().join('');
    }

    return `${rawHeader}.${rawPayload}.${signature}`;
  }

  public registerAuthoritativeUser(user: AuthoritativeUserPayload): void {
    this.mockAuthoritativeUsers.set(user.sub.toLowerCase(), user);
  }

  public async verifyToken(token: string): Promise<AuthTokenClaims> {
    return this.localVerifier.verify(token);
  }

  public async verifyAuthoritativeUser(token: string): Promise<AuthoritativeUserPayload> {
    const claims = await this.verifyToken(token);
    const registered = this.mockAuthoritativeUsers.get(claims.sub.toLowerCase());

    if (registered) {
      if (registered.bannedUntil && registered.bannedUntil.getTime() > Date.now()) {
        throw new AuthError('AUTH_USER_BANNED', 'User account is banned in mock.', { statusCode: 403 });
      }
      return registered;
    }

    const provider = mapSupabaseProvider(claims.appMetadata?.provider);
    if (provider !== 'supabase_email' && !claims.providerSubject) {
      throw new AuthError(
        'AUTH_PROVIDER_ERROR',
        `MockTokenVerifier cannot synthesize ${provider} identity without authoritative registration or explicit providerSubject.`,
        { statusCode: 403 },
      );
    }

    // Default synthetic payload derived from verified claims (only supabase_email uses claims.sub)
    return {
      sub: claims.sub,
      email: claims.email,
      emailConfirmedAt: new Date(),
      identities: [
        {
          provider,
          providerSubject: provider === 'supabase_email' ? claims.sub : claims.providerSubject!,
          emailAtProvider: claims.email,
          emailVerified: true,
        },
      ],
      displayName: (claims.userMetadata?.full_name as string) ?? null,
      rawAppMetadata: claims.appMetadata,
      rawUserMetadata: claims.userMetadata,
    };
  }
}
