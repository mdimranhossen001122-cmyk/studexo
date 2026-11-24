import { isApiClientError } from '@/lib/apiClient';
import type { AuthPublicUser } from '@shared/schemas/auth.schema';

export type StudexoRole = AuthPublicUser['role'];

export const APP_ROUTES = {
  home: '/',
  login: '/login',
  callback: '/auth/callback',
  workspace: '/workspace',
  student: '/student',
  counselor: '/counselor',
  admin: '/admin',
} as const;

export type AuthFailureCategory =
  | 'unverified_email'
  | 'invalid_credentials'
  | 'already_registered'
  | 'oauth_cancelled'
  | 'session_expired'
  | 'account_suspended'
  | 'pending_deletion'
  | 'purge_in_progress'
  | 'identity_collision'
  | 'account_banned'
  | 'forbidden'
  | 'provider_error'
  | 'service_unavailable'
  | 'configuration_error'
  | 'rate_limited'
  | 'unknown_error';

export type AuthRecoveryAction =
  | 'resend_verification'
  | 'retry_sync'
  | 'reauthenticate'
  | 'sign_out'
  | 'go_home';

export interface AuthUiFailure {
  category: AuthFailureCategory;
  code: string;
  title: string;
  summary: string;
  guidance: string;
  recoveryActions: AuthRecoveryAction[];
  tone: 'warning' | 'danger';
  requestId?: string;
  email?: string;
}

export interface OAuthCallbackParams {
  code: string | null;
  oauthError: {
    code: string;
    description: string;
  } | null;
}

const AUTH_QUERY_AND_HASH_KEYS = new Set([
  'code',
  'state',
  'error',
  'error_code',
  'error_description',
  'access_token',
  'refresh_token',
  'expires_in',
  'token_type',
  'provider_token',
  'provider_refresh_token',
]);

export function getDefaultRouteForRole(role: StudexoRole): string {
  switch (role) {
    case 'student':
      return APP_ROUTES.student;
    case 'counselor':
      return APP_ROUTES.counselor;
    case 'admin':
      return APP_ROUTES.admin;
  }
}

export function canRoleAccessRoute(role: StudexoRole, pathname: string): boolean {
  if (pathname === APP_ROUTES.workspace) {
    return true;
  }
  if (pathname === APP_ROUTES.student) {
    return role === 'student';
  }
  if (pathname === APP_ROUTES.counselor) {
    return role === 'counselor';
  }
  if (pathname === APP_ROUTES.admin) {
    return role === 'admin';
  }
  return true;
}

/**
 * Accepts strictly internal relative app paths to prevent open-redirect vulnerabilities.
 */
export function sanitizeRedirectTarget(rawTarget: string | null | undefined): string | null {
  if (!rawTarget) {
    return null;
  }
  const trimmed = rawTarget.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }
  if (trimmed.startsWith(APP_ROUTES.callback) || trimmed.startsWith(APP_ROUTES.login)) {
    return null;
  }
  return trimmed;
}

export function maskSensitiveTokens(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g, '[REDACTED_JWT]');
}

export function parseOAuthCallbackParams(search: string, hash: string): OAuthCallbackParams {
  const queryParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);

  const code = queryParams.get('code')?.trim() || null;
  const rawError =
    queryParams.get('error_code') ||
    queryParams.get('error') ||
    hashParams.get('error_code') ||
    hashParams.get('error');

  if (!rawError) {
    return { code, oauthError: null };
  }

  const rawDescription =
    queryParams.get('error_description') ||
    hashParams.get('error_description') ||
    'The identity provider did not complete authentication.';

  return {
    code,
    oauthError: {
      code: rawError.trim(),
      description: maskSensitiveTokens(rawDescription.trim()),
    },
  };
}

export function buildUrlWithoutAuthParams(pathname: string, search: string, hash: string): string {
  const queryParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of AUTH_QUERY_AND_HASH_KEYS) {
    queryParams.delete(key);
  }
  const cleanQuery = queryParams.toString();

  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  let hasNonAuthHash = false;
  for (const key of Array.from(hashParams.keys())) {
    if (AUTH_QUERY_AND_HASH_KEYS.has(key)) {
      hashParams.delete(key);
    } else {
      hasNonAuthHash = true;
    }
  }
  const cleanHash = hasNonAuthHash && hashParams.toString() ? `#${hashParams.toString()}` : '';

  return `${pathname}${cleanQuery ? `?${cleanQuery}` : ''}${cleanHash}`;
}

export function isRecoverable401Error(err: unknown): boolean {
  if (!isApiClientError(err)) {
    return false;
  }
  return (
    err.status === 401 &&
    (err.code === 'AUTH_TOKEN_EXPIRED' ||
      err.code === 'AUTH_INVALID_TOKEN' ||
      err.code === 'AUTH_UNAUTHENTICATED' ||
      err.code === 'AUTH_INVALID_SIGNATURE')
  );
}

function getRawErrorCode(error: unknown): string {
  if (isApiClientError(error)) {
    return error.code;
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown };
    if (typeof candidate.code === 'string' && candidate.code.trim()) {
      return candidate.code.trim();
    }
  }
  return '';
}

function getRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return maskSensitiveTokens(error.message);
  }
  if (error && typeof error === 'object') {
    const candidate = error as { description?: unknown; message?: unknown };
    if (typeof candidate.description === 'string') {
      return maskSensitiveTokens(candidate.description);
    }
    if (typeof candidate.message === 'string') {
      return maskSensitiveTokens(candidate.message);
    }
  }
  if (typeof error === 'string') {
    return maskSensitiveTokens(error);
  }
  return 'An unexpected authentication error occurred.';
}

export function classifyAuthFailure(
  error: unknown,
  context?: { email?: string },
): AuthUiFailure {
  const code = getRawErrorCode(error);
  const message = getRawErrorMessage(error);
  const lowerMessage = message.toLowerCase();
  const requestId = isApiClientError(error) ? error.requestId : undefined;
  const email = context?.email?.trim() || undefined;

  if (
    code === 'AUTH_EMAIL_NOT_VERIFIED' ||
    code === 'email_not_confirmed' ||
    lowerMessage.includes('email not confirmed') ||
    lowerMessage.includes('email address is not verified')
  ) {
    return {
      category: 'unverified_email',
      code: code || 'AUTH_EMAIL_NOT_VERIFIED',
      title: 'Email verification required',
      summary: 'Your email address must be verified before Studexo can activate your account.',
      guidance:
        'Check your inbox for the verification link, or request a fresh confirmation email below.',
      recoveryActions: email
        ? ['resend_verification', 'retry_sync', 'sign_out']
        : ['retry_sync', 'sign_out'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_USER_SUSPENDED') {
    return {
      category: 'account_suspended',
      code,
      title: 'Account suspended',
      summary: 'This Studexo account is currently suspended.',
      guidance:
        'Protected workspaces and admissions services are disabled while the suspension is active. Sign out or contact Studexo support for review.',
      recoveryActions: ['sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_USER_PENDING_DELETION') {
    return {
      category: 'pending_deletion',
      code,
      title: 'Account pending deletion',
      summary: 'This account is scheduled for deletion and can no longer be accessed.',
      guidance:
        'To protect account integrity, active sessions are blocked while deletion is pending. Sign out to return to the public portal.',
      recoveryActions: ['sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_PURGE_IN_PROGRESS') {
    return {
      category: 'purge_in_progress',
      code,
      title: 'Account purge in progress',
      summary: 'Previous account cleanup for this identity is still completing.',
      guidance:
        'Sign-in and re-registration remain blocked until background account purge completes cleanly. Please sign out and try again later.',
      recoveryActions: ['sign_out'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_IDENTITY_COLLISION' || (isApiClientError(error) && error.status === 409)) {
    return {
      category: 'identity_collision',
      code: code || 'AUTH_IDENTITY_COLLISION',
      title: 'Sign-in method does not match existing account',
      summary:
        'An account using this email is already registered under a different sign-in provider.',
      guidance:
        'For account security, Studexo never merges providers automatically by email alone. Sign out and sign in with your original provider.',
      recoveryActions: ['sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_USER_BANNED') {
    return {
      category: 'account_banned',
      code,
      title: 'Identity provider access restricted',
      summary: 'Your authentication provider has restricted sign-in for this account.',
      guidance: 'Sign out to clear this session or contact support if you believe this is an error.',
      recoveryActions: ['sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (
    code === 'AUTH_TOKEN_EXPIRED' ||
    code === 'AUTH_INVALID_TOKEN' ||
    code === 'AUTH_TOKEN_MISSING' ||
    code === 'AUTH_UNAUTHENTICATED' ||
    code === 'AUTH_INVALID_SIGNATURE' ||
    code === 'AUTH_INVALID_AUDIENCE' ||
    code === 'AUTH_INVALID_ISSUER'
  ) {
    return {
      category: 'session_expired',
      code,
      title: 'Session expired or invalid',
      summary: 'Your authentication session could not be verified or has expired.',
      guidance: 'Sign in again to establish a fresh session.',
      recoveryActions: ['reauthenticate', 'sign_out'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_FORBIDDEN') {
    return {
      category: 'forbidden',
      code,
      title: 'Access restricted for your role',
      summary: 'Your account does not hold the required role for this workspace.',
      guidance: 'Return to your assigned workspace or sign in with an authorized account.',
      recoveryActions: ['go_home', 'sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (code === 'access_denied') {
    return {
      category: 'oauth_cancelled',
      code,
      title: 'OAuth sign-in cancelled',
      summary: 'Authorization was cancelled at the external provider before sign-in completed.',
      guidance: 'Choose Google, GitHub, or email/password below when you are ready to continue.',
      recoveryActions: ['reauthenticate'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_PROVIDER_ERROR' || code === 'oauth_error') {
    return {
      category: 'provider_error',
      code,
      title: 'Provider identity verification failed',
      summary: message || 'The identity provider did not return complete verified identity details.',
      guidance:
        'Ensure your provider account has a verified email address and try signing in again.',
      recoveryActions: ['reauthenticate', 'sign_out'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (
    code === 'AUTH_PROVIDER_UNAVAILABLE' ||
    code === 'DATABASE_UNAVAILABLE' ||
    code === 'SERVICE_UNAVAILABLE' ||
    (isApiClientError(error) && error.status === 503) ||
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('networkerror') ||
    lowerMessage.includes('network request failed')
  ) {
    return {
      category: 'service_unavailable',
      code: code || 'SERVICE_UNAVAILABLE',
      title: 'Authentication service temporarily unavailable',
      summary: 'Studexo or its identity provider could not complete verification right now.',
      guidance: 'Wait a moment and retry synchronization without signing out.',
      recoveryActions: ['retry_sync', 'sign_out'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (code === 'AUTH_CONFIGURATION_ERROR' || code === 'CLIENT_SUPABASE_NOT_CONFIGURED') {
    return {
      category: 'configuration_error',
      code,
      title: 'Authentication configuration incomplete',
      summary:
        code === 'CLIENT_SUPABASE_NOT_CONFIGURED'
          ? 'Browser Supabase environment variables (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) are not configured.'
          : 'The backend authentication service reported an incomplete environment configuration.',
      guidance: 'Verify environment configuration before attempting authentication.',
      recoveryActions: ['retry_sync'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (code === 'RATE_LIMIT_EXCEEDED' || (isApiClientError(error) && error.status === 429)) {
    return {
      category: 'rate_limited',
      code: code || 'RATE_LIMIT_EXCEEDED',
      title: 'Too many authentication attempts',
      summary: 'Requests are temporarily rate-limited to protect your account.',
      guidance: 'Please wait a short moment before retrying.',
      recoveryActions: ['retry_sync'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  if (
    code === 'invalid_credentials' ||
    lowerMessage.includes('invalid login credentials')
  ) {
    return {
      category: 'invalid_credentials',
      code: code || 'invalid_credentials',
      title: 'Invalid email or password',
      summary: 'The email address or password did not match an active credential.',
      guidance: 'Double-check your credentials or sign in with Google or GitHub instead.',
      recoveryActions: ['reauthenticate'],
      tone: 'danger',
      requestId,
      email,
    };
  }

  if (
    code === 'user_already_exists' ||
    lowerMessage.includes('user already registered')
  ) {
    return {
      category: 'already_registered',
      code: code || 'user_already_exists',
      title: 'Email already registered',
      summary: 'An account with this email address already exists.',
      guidance:
        'Switch to Sign In or use the identity provider originally linked to this email.',
      recoveryActions: ['reauthenticate'],
      tone: 'warning',
      requestId,
      email,
    };
  }

  return {
    category: 'unknown_error',
    code: code || 'AUTH_UNKNOWN_ERROR',
    title: 'Authentication could not be completed',
    summary: message,
    guidance: 'Retry verification or sign out and start a fresh session.',
    recoveryActions: ['retry_sync', 'sign_out'],
    tone: 'danger',
    requestId,
    email,
  };
}
