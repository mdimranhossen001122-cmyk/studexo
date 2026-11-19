/**
 * Studexo Two-Tier Express Authentication Pipeline & RBAC Guards (Phase 8B.5A Milestone 3)
 *
 * Implements:
 * - Tier 1A (`authenticateBearerClaims`): Strict Authorization Bearer extraction + cryptographic JWT verification.
 * - Tier 1B (`requireAuthoritativeSession`): Authoritative GoTrue `auth.getUser()` verification (for `/api/auth/sync`).
 * - Tier 2 (`resolveDatabaseUser`): Authoritative PostgreSQL user resolution & lifecycle enforcement (`active` only).
 * - Tier 3 (`requireRole`): Explicit DB-backed RBAC enforcement (`student`, `counselor`, `admin`).
 *
 * Security invariants:
 * - Zero raw-token retention on `req`, `res.locals`, `AuthError`, or logs.
 * - Never trusts client-supplied roles, headers, query tokens, or JWT `role`/`user_metadata`/`app_metadata` roles.
 * - Defensive request-context clearing & object freezing to eliminate spoofed or stale `req.user` state.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AuthError,
  type AuthenticatedUser,
  type AuthoritativeUserPayload,
  type AuthTokenClaims,
} from '../../shared/types/auth';
import type { AppEnv } from '../config/env';
import { DatabaseNotConfiguredError, getDb } from '../db/index';
import { createPostgresAuthRepository } from '../modules/auth/auth.repository';
import { AuthService, createAuthService } from '../modules/auth/auth.service';
import { SupabaseTokenVerifier, type TokenVerifier } from '../modules/auth/tokenVerifier';
import { AppError } from './errorHandler';

export type StudexoUserRole = AuthenticatedUser['role'];

const MAX_AUTHORIZATION_HEADER_LENGTH = 8_192;
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
]);
const TRANSIENT_PG_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);

export interface AuthMiddlewareDependencies {
  tokenVerifier?: TokenVerifier;
  authService?: AuthService;
}

export interface AuthMiddlewarePipeline {
  authenticateBearerClaims: RequestHandler;
  requireAuthoritativeSession: RequestHandler;
  resolveDatabaseUser: RequestHandler;
  requireAuth: RequestHandler[];
  requireRole: (...allowedRoles: StudexoUserRole[]) => RequestHandler;
  requireAuthRole: (...allowedRoles: StudexoUserRole[]) => RequestHandler[];
  requireStudent: RequestHandler[];
  requireCounselor: RequestHandler[];
  requireAdmin: RequestHandler[];
}

function clearRequestAuthContext(req: Request): void {
  req.authClaims = undefined;
  req.authoritativeUser = undefined;
  req.user = undefined;
}

function freezeAuthClaims(claims: AuthTokenClaims): AuthTokenClaims {
  return Object.freeze({
    ...claims,
    ...(claims.appMetadata ? { appMetadata: Object.freeze({ ...claims.appMetadata }) } : {}),
    ...(claims.userMetadata ? { userMetadata: Object.freeze({ ...claims.userMetadata }) } : {}),
  });
}

function freezeAuthoritativeUser(payload: AuthoritativeUserPayload): AuthoritativeUserPayload {
  return Object.freeze({
    ...payload,
    identities: Object.freeze(payload.identities.map((i) => Object.freeze({ ...i }))) as AuthoritativeUserPayload['identities'],
    ...(payload.rawAppMetadata ? { rawAppMetadata: Object.freeze({ ...payload.rawAppMetadata }) } : {}),
    ...(payload.rawUserMetadata ? { rawUserMetadata: Object.freeze({ ...payload.rawUserMetadata }) } : {}),
  });
}

function freezeAuthenticatedUser(user: AuthenticatedUser): AuthenticatedUser {
  return Object.freeze({ ...user });
}

function isTransientDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (TRANSIENT_NETWORK_ERROR_CODES.has(code) || TRANSIENT_PG_SQLSTATES.has(code)) {
      return true;
    }
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    return isTransientDatabaseError(cause);
  }
  return false;
}

/**
 * Strictly extracts a Bearer token solely from the HTTP `Authorization` header.
 * Rejects missing headers, non-Bearer schemes, empty tokens, duplicate headers,
 * internal whitespace, and oversized headers without retaining the raw token.
 */
export function extractBearerToken(req: Request): string {
  const rawHeader = req.header('authorization');
  if (typeof rawHeader !== 'string' || rawHeader.trim().length === 0) {
    throw new AuthError('AUTH_TOKEN_MISSING', 'Authorization Bearer token is required.');
  }

  if (rawHeader.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Authorization header exceeds maximum allowed length.');
  }

  const trimmed = rawHeader.trim();
  const match = /^bearer(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Authorization header must use the Bearer scheme.');
  }

  const candidate = match[1]?.trim() ?? '';
  if (candidate.length === 0) {
    throw new AuthError('AUTH_TOKEN_MISSING', 'Bearer token is missing from Authorization header.');
  }

  // Reject duplicate Authorization headers (joined with ", ") or whitespace-separated extra tokens
  if (/[\s,]/.test(candidate)) {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed Bearer authorization header.');
  }

  return candidate;
}

export function createAuthMiddlewarePipeline(deps: {
  getTokenVerifier: () => TokenVerifier;
  getAuthService: () => AuthService;
}): AuthMiddlewarePipeline {
  const authenticateBearerClaims: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    clearRequestAuthContext(req);

    void (async () => {
      const token = extractBearerToken(req);
      const verifier = deps.getTokenVerifier();
      const claims = await verifier.verifyToken(token);
      req.authClaims = freezeAuthClaims(claims);
      next();
    })().catch((err: unknown) => {
      clearRequestAuthContext(req);
      next(err);
    });
  };

  const requireAuthoritativeSession: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    clearRequestAuthContext(req);

    void (async () => {
      const token = extractBearerToken(req);
      const verifier = deps.getTokenVerifier();
      const authoritativeUser = await verifier.verifyAuthoritativeUser(token);
      req.authoritativeUser = freezeAuthoritativeUser(authoritativeUser);
      next();
    })().catch((err: unknown) => {
      clearRequestAuthContext(req);
      next(err);
    });
  };

  const resolveDatabaseUser: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    // Always clear any pre-existing req.user before authoritative DB resolution
    req.user = undefined;

    const claims = req.authClaims;
    if (!claims || typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
      next(
        new AuthError(
          'AUTH_UNAUTHENTICATED',
          'Verified authentication claims are required before user resolution.',
        ),
      );
      return;
    }

    void (async () => {
      const authService = deps.getAuthService();
      const user = await authService.resolveUserFromClaims(claims);
      req.user = freezeAuthenticatedUser(user);
      next();
    })().catch((err: unknown) => {
      req.user = undefined;
      if (err instanceof DatabaseNotConfiguredError) {
        next(
          new AuthError(
            'AUTH_CONFIGURATION_ERROR',
            'Database configuration is missing for identity resolution.',
            { statusCode: 500 },
          ),
        );
        return;
      }
      if (isTransientDatabaseError(err)) {
        next(new AppError(503, 'DATABASE_UNAVAILABLE', 'Database service is temporarily unavailable'));
        return;
      }
      next(err);
    });
  };

  const requireRole = (...allowedRoles: StudexoUserRole[]): RequestHandler => {
    if (allowedRoles.length === 0) {
      throw new Error('requireRole requires at least one allowed role.');
    }

    const allowedSet = new Set<StudexoUserRole>(allowedRoles);

    return (req: Request, _res: Response, next: NextFunction) => {
      const user = req.user;
      if (
        !user ||
        typeof user.id !== 'string' ||
        user.id.length === 0 ||
        typeof user.supabaseAuthUserId !== 'string' ||
        user.supabaseAuthUserId.length === 0
      ) {
        next(
          new AuthError(
            'AUTH_UNAUTHENTICATED',
            'Authenticated user context is required to access this resource.',
          ),
        );
        return;
      }

      if (user.status === 'suspended') {
        next(new AuthError('AUTH_USER_SUSPENDED', 'User account is suspended.', { statusCode: 403 }));
        return;
      }

      if (user.status === 'pending_deletion') {
        next(
          new AuthError(
            'AUTH_USER_PENDING_DELETION',
            'User account is pending deletion or purge.',
            { statusCode: 403 },
          ),
        );
        return;
      }

      if (user.status !== 'active') {
        next(new AuthError('AUTH_FORBIDDEN', 'User account is not active.', { statusCode: 403 }));
        return;
      }

      if (!allowedSet.has(user.role)) {
        next(
          new AuthError('AUTH_FORBIDDEN', 'Insufficient permissions for this resource.', {
            statusCode: 403,
          }),
        );
        return;
      }

      next();
    };
  };

  const requireAuth: RequestHandler[] = [authenticateBearerClaims, resolveDatabaseUser];
  const requireAuthRole = (...allowedRoles: StudexoUserRole[]): RequestHandler[] => [
    authenticateBearerClaims,
    resolveDatabaseUser,
    requireRole(...allowedRoles),
  ];

  return {
    authenticateBearerClaims,
    requireAuthoritativeSession,
    resolveDatabaseUser,
    requireAuth,
    requireRole,
    requireAuthRole,
    requireStudent: requireAuthRole('student'),
    requireCounselor: requireAuthRole('counselor'),
    requireAdmin: requireAuthRole('admin'),
  };
}

/**
 * Creates a lazily initialized two-tier auth middleware pipeline from AppEnv.
 * Never opens database connections or fails during app creation (`createApp`);
 * resolves and caches verifier/service dependencies on first protected request.
 */
export function createAppAuthMiddleware(
  appEnv: AppEnv,
  overrides: AuthMiddlewareDependencies = {},
): AuthMiddlewarePipeline {
  let cachedVerifier: TokenVerifier | undefined = overrides.tokenVerifier;
  let cachedAuthService: AuthService | undefined = overrides.authService;

  const getTokenVerifier = (): TokenVerifier => {
    if (cachedVerifier) {
      return cachedVerifier;
    }

    const supabaseUrl = appEnv.supabase.SUPABASE_URL ?? appEnv.supabase.VITE_SUPABASE_URL;
    const supabaseAnonKey =
      appEnv.supabase.SUPABASE_ANON_KEY ?? appEnv.supabase.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new AuthError(
        'AUTH_CONFIGURATION_ERROR',
        'Supabase authentication configuration is incomplete.',
        { statusCode: 500 },
      );
    }

    cachedVerifier = new SupabaseTokenVerifier({
      supabaseUrl,
      supabaseAnonKey,
      jwtSecret: appEnv.supabase.SUPABASE_JWT_SECRET,
      publicKey: appEnv.supabase.SUPABASE_JWT_PUBLIC_KEY,
    });
    return cachedVerifier;
  };

  const getAuthService = (): AuthService => {
    if (cachedAuthService) {
      return cachedAuthService;
    }

    if (!appEnv.database.DATABASE_URL) {
      throw new AuthError(
        'AUTH_CONFIGURATION_ERROR',
        'Database configuration is missing for identity resolution.',
        { statusCode: 500 },
      );
    }

    const db = getDb(appEnv);
    cachedAuthService = createAuthService(createPostgresAuthRepository(db));
    return cachedAuthService;
  };

  return createAuthMiddlewarePipeline({
    getTokenVerifier,
    getAuthService,
  });
}
