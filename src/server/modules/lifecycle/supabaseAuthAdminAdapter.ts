import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createClient,
  isAuthApiError,
  isAuthError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
import { sanitizeStringValue } from '../../lib/logger';
import type { SupabaseAuthAdminAdapter } from './storageAndPurge';

export const DEFAULT_AUTH_ADMIN_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_AUTH_ADMIN_REQUEST_TIMEOUT_MS = 25_000;
export const MAX_AUTH_ADMIN_ERROR_MESSAGE_LENGTH = 256;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SupabaseAuthAdminErrorCode =
  | 'AUTH_ADMIN_CONFIG_INVALID'
  | 'INVALID_SUPABASE_AUTH_USER_ID'
  | 'AUTH_PROVIDER_TIMEOUT'
  | 'AUTH_PROVIDER_NETWORK_ERROR'
  | 'AUTH_PROVIDER_UNCONFIRMED_404'
  | 'AUTH_PROVIDER_UNAUTHORIZED'
  | 'AUTH_PROVIDER_FORBIDDEN'
  | 'AUTH_PROVIDER_RATE_LIMITED'
  | 'AUTH_PROVIDER_5XX'
  | 'AUTH_PROVIDER_MALFORMED_RESPONSE'
  | 'AUTH_PROVIDER_4XX'
  | 'AUTH_PROVIDER_DELETE_FAILED'
  | (string & {});

export interface SupabaseAuthAdminErrorOptions {
  code: SupabaseAuthAdminErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
  providerCode?: string;
}

/**
 * Typed error thrown by `SupabaseAuthAdminAdapter.deleteUserById` on any provider,
 * validation, network, timeout, or response-integrity failure.
 *
 * Guarantees a non-empty `.code` string and a sanitized, length-bounded `.message`
 * suitable for persistence in `studexo.external_identity_purge_outbox`.
 */
export class SupabaseAuthAdminError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;
  public readonly providerCode?: string;

  constructor(options: SupabaseAuthAdminErrorOptions) {
    const safeMessage = sanitizeAndBoundMessage(options.message);
    super(safeMessage);
    this.name = 'SupabaseAuthAdminError';
    const normalizedCode = options.code.trim();
    this.code =
      normalizedCode.length > 0 ? normalizedCode : 'AUTH_PROVIDER_DELETE_FAILED';
    if (
      typeof options.status === 'number' &&
      Number.isInteger(options.status) &&
      options.status > 0
    ) {
      this.status = options.status;
    }
    this.retryable = Boolean(options.retryable);
    if (
      typeof options.providerCode === 'string' &&
      options.providerCode.trim().length > 0
    ) {
      this.providerCode = options.providerCode.trim();
    }
  }
}

export interface SupabaseAuthAdminDeleteResponse {
  data: {
    user: {
      id?: string;
    } | null;
  } | null;
  error: unknown;
}

export interface SupabaseAuthAdminDeleteClient {
  deleteUser(
    id: string,
    shouldSoftDelete?: boolean,
  ): Promise<SupabaseAuthAdminDeleteResponse>;
}

export interface CreateSupabaseAuthAdminAdapterOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  isProduction?: boolean;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  authAdminClient?: SupabaseAuthAdminDeleteClient;
}

interface FetchFailureContext {
  failureKind?: 'timeout' | 'network';
  timeoutMs?: number;
  httpResponseReceived?: boolean;
}

const fetchFailureStorage = new AsyncLocalStorage<FetchFailureContext>();

function redactAdditionalSecrets(
  input: string,
  serviceRoleKey?: string,
): string {
  let result = input;
  if (serviceRoleKey && serviceRoleKey.trim().length > 0) {
    const trimmedKey = serviceRoleKey.trim();
    result = result.split(trimmedKey).join('[REDACTED]');
  }
  // Redact new-format Supabase keys (sb_secret_..., sb_publishable_..., sb_temp_...)
  result = result.replace(
    /\bsb_(?:secret|publishable|temp)_[A-Za-z0-9_-]+/gi,
    '[REDACTED]',
  );
  // Redact raw JWT tokens (3 base64url segments starting with eyJ)
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g,
    '[REDACTED]',
  );
  // Redact explicit apikey / authorization header values in plain text
  result = result.replace(
    /\b((?:apikey|x-api-key|authorization)\s*[:=]\s*)([^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  return result;
}

export function sanitizeAndBoundMessage(
  rawMessage: string,
  serviceRoleKey?: string,
  maxLength: number = MAX_AUTH_ADMIN_ERROR_MESSAGE_LENGTH,
): string {
  const base =
    typeof rawMessage === 'string' && rawMessage.trim().length > 0
      ? rawMessage
      : 'External identity provider deletion failed';
  const loggerSanitized = sanitizeStringValue(base);
  const fullyRedacted = redactAdditionalSecrets(loggerSanitized, serviceRoleKey)
    .replace(/\s+/g, ' ')
    .trim();

  const nonEmpty =
    fullyRedacted.length > 0
      ? fullyRedacted
      : 'External identity provider deletion failed';

  if (nonEmpty.length <= maxLength) {
    return nonEmpty;
  }
  const sliceLength = Math.max(1, maxLength - 3);
  return `${nonEmpty.slice(0, sliceLength)}...`;
}

function validateAndNormalizeSupabaseUrl(
  rawUrl: string,
  isProduction: boolean,
): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SUPABASE_URL is required to initialize SupabaseAuthAdminAdapter.',
      retryable: false,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SUPABASE_URL must be a valid URL.',
      retryable: false,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SUPABASE_URL must use http: or https: protocol.',
      retryable: false,
    });
  }

  if (isProduction && parsed.protocol !== 'https:') {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SUPABASE_URL must use https: in production.',
      retryable: false,
    });
  }

  if (parsed.username || parsed.password) {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SUPABASE_URL must not contain embedded credentials.',
      retryable: false,
    });
  }

  return parsed.toString().replace(/\/+$/, '');
}

function validateServiceRoleKey(rawKey: string): string {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message:
        'SUPABASE_SERVICE_ROLE_KEY is required to initialize SupabaseAuthAdminAdapter.',
      retryable: false,
    });
  }
  return rawKey.trim();
}

function validateRequestTimeoutMs(rawTimeoutMs: number | undefined): number {
  const timeoutMs = rawTimeoutMs ?? DEFAULT_AUTH_ADMIN_REQUEST_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_AUTH_ADMIN_REQUEST_TIMEOUT_MS
  ) {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: `requestTimeoutMs must be a finite number between 1 and ${MAX_AUTH_ADMIN_REQUEST_TIMEOUT_MS}.`,
      retryable: false,
    });
  }
  return Math.floor(timeoutMs);
}

function isTimeoutOrAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return true;
  }
  if (
    typeof err.code === 'string' &&
    (err.code === 'ABORT_ERR' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      err.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      err.code === 'UND_ERR_BODY_TIMEOUT' ||
      err.code === 'request_timeout' ||
      err.code === 'hook_timeout' ||
      err.code === 'hook_timeout_after_retry')
  ) {
    return true;
  }
  if (
    typeof err.message === 'string' &&
    /(?:request\s+timed?\s*out|operation\s+was\s+aborted|the\s+operation\s+was\s+aborted|aborted\s+due\s+to\s+timeout|timeout\s+after\s+\d+\s*ms)/i.test(
      err.message,
    )
  ) {
    return true;
  }
  if (err.cause && err.cause !== error) {
    return isTimeoutOrAbortError(err.cause);
  }
  return false;
}

function createBoundedFetch(
  baseFetch: typeof globalThis.fetch,
  requestTimeoutMs: number,
  serviceRoleKey: string,
): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const callerSignal = init?.signal ?? undefined;
    const timeoutController = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      const timeoutReason = new Error(
        `Supabase Auth Admin request timed out after ${requestTimeoutMs}ms.`,
      );
      timeoutReason.name = 'TimeoutError';
      timeoutController.abort(timeoutReason);
    }, requestTimeoutMs);
    timer.unref?.();

    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await baseFetch(input, {
        ...init,
        signal: combinedSignal,
      });
      const store = fetchFailureStorage.getStore();
      if (store) {
        store.httpResponseReceived = true;
      }
      return response;
    } catch (error) {
      const store = fetchFailureStorage.getStore();
      if (timedOut || callerSignal?.aborted || isTimeoutOrAbortError(error)) {
        if (store) {
          store.failureKind = 'timeout';
          store.timeoutMs = requestTimeoutMs;
        }
        const timeoutErr = new Error(
          timedOut
            ? `Supabase Auth Admin request timed out after ${requestTimeoutMs}ms.`
            : 'Supabase Auth Admin request was aborted or timed out.',
          { cause: error },
        );
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }

      if (store) {
        store.failureKind = 'network';
      }
      const rawMessage =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Network failure while contacting Supabase Auth Admin API.';
      throw new Error(sanitizeAndBoundMessage(rawMessage, serviceRoleKey), {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function extractProviderCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.trim().length > 0) {
    return code.trim();
  }
  return undefined;
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isInteger(status) && status > 0) {
    return status;
  }
  return undefined;
}

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim().length > 0) {
      return msg;
    }
  }
  return fallback;
}

function classifyProviderFailure(
  error: unknown,
  serviceRoleKey: string,
  failureContext?: FetchFailureContext,
): SupabaseAuthAdminError {
  if (error instanceof SupabaseAuthAdminError) {
    return error;
  }

  const providerCode = extractProviderCode(error);
  const status = extractStatus(error);
  const rawMessage = extractMessage(
    error,
    'Supabase Auth Admin user deletion failed.',
  );
  const sanitizedMessage = sanitizeAndBoundMessage(rawMessage, serviceRoleKey);

  // 1. Timeout / Abort (via per-call fetch tracking, error name/code, or HTTP 408)
  if (
    failureContext?.failureKind === 'timeout' ||
    isTimeoutOrAbortError(error) ||
    status === 408
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_TIMEOUT',
      message: sanitizedMessage,
      status,
      retryable: true,
      providerCode,
    });
  }

  // 2. Non-JSON 2xx response body (where fetch succeeded with HTTP 2xx, then result.json() threw SyntaxError
  // which @supabase/auth-js wrapped into AuthRetryableFetchError with status === 0)
  if (
    failureContext?.httpResponseReceived &&
    !failureContext.failureKind &&
    isAuthRetryableFetchError(error) &&
    (error.status === 0 || !status)
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      message: `Malformed non-JSON 2xx response from Supabase Auth Admin API: ${sanitizedMessage}`,
      retryable: true,
      providerCode,
    });
  }

  // 3. Network failure (status === 0 on AuthRetryableFetchError or tracked fetch failure)
  if (
    failureContext?.failureKind === 'network' ||
    (isAuthRetryableFetchError(error) && (error.status === 0 || !status))
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_NETWORK_ERROR',
      message: sanitizedMessage,
      retryable: true,
      providerCode,
    });
  }

  // 4. Non-JSON / malformed error payload wrapped by SDK as AuthUnknownError
  if (isAuthError(error) && error.name === 'AuthUnknownError') {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      message: `Malformed non-JSON response from Supabase Auth Admin API: ${sanitizedMessage}`,
      status,
      retryable: true,
      providerCode,
    });
  }

  // 4. Unconfirmed HTTP 404 (status 404 without AuthApiError + code === 'user_not_found')
  if (status === 404) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_UNCONFIRMED_404',
      message: `Unconfirmed HTTP 404 from Supabase Auth Admin API (code=${providerCode ?? 'none'}): ${sanitizedMessage}`,
      status: 404,
      retryable: false,
      providerCode,
    });
  }

  // 5. Authentication / Authorization failures (401 / 403 or explicit auth/admin error codes)
  if (
    status === 401 ||
    providerCode === 'no_authorization' ||
    providerCode === 'bad_jwt' ||
    providerCode === 'invalid_jwt'
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_UNAUTHORIZED',
      message: sanitizedMessage,
      status: status ?? 401,
      retryable: false,
      providerCode,
    });
  }

  if (
    status === 403 ||
    providerCode === 'not_admin' ||
    providerCode === 'unexpected_audience'
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_FORBIDDEN',
      message: sanitizedMessage,
      status: status ?? 403,
      retryable: false,
      providerCode,
    });
  }

  // 6. Rate limiting (HTTP 429 or over_request_rate_limit)
  if (status === 429 || providerCode === 'over_request_rate_limit') {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_RATE_LIMITED',
      message: sanitizedMessage,
      status: status ?? 429,
      retryable: true,
      providerCode,
    });
  }

  // 7. Provider 5xx / Cloudflare 520-530 server errors
  if (
    (typeof status === 'number' && status >= 500) ||
    isAuthRetryableFetchError(error) ||
    providerCode === 'unexpected_failure'
  ) {
    return new SupabaseAuthAdminError({
      code: 'AUTH_PROVIDER_5XX',
      message: sanitizedMessage,
      status,
      retryable: true,
      providerCode,
    });
  }

  // 8. Permanent 4xx client/validation errors
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new SupabaseAuthAdminError({
      code: providerCode ?? 'AUTH_PROVIDER_4XX',
      message: sanitizedMessage,
      status,
      retryable: false,
      providerCode,
    });
  }

  // 9. Fallback for any other unexpected provider error
  return new SupabaseAuthAdminError({
    code: providerCode ?? 'AUTH_PROVIDER_DELETE_FAILED',
    message: sanitizedMessage,
    status,
    retryable: true,
    providerCode,
  });
}

/**
 * Creates a server-only `SupabaseAuthAdminAdapter` for hard-deleting external Supabase Auth
 * identities during outbox processing.
 *
 * Security & architectural guarantees:
 * - Fails closed if `supabaseUrl` or `serviceRoleKey` is missing or invalid.
 * - Requires HTTPS in production (`isProduction === true`).
 * - Configures `@supabase/supabase-js` with `autoRefreshToken: false`, `persistSession: false`,
 *   and `detectSessionInUrl: false`.
 * - Applies a bounded timeout (`requestTimeoutMs`, default 10,000ms) independently to every
 *   underlying HTTP request (`GET` and `DELETE` inside `auth.admin.deleteUser`).
 * - Never exposes PostgREST (`.from()`, `.schema()`, `.rpc()`) or Storage methods.
 */
export function createSupabaseAuthAdminAdapter(
  options: CreateSupabaseAuthAdminAdapterOptions,
): SupabaseAuthAdminAdapter {
  if (!options || typeof options !== 'object') {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'SupabaseAuthAdminAdapter configuration options are required.',
      retryable: false,
    });
  }

  const isProduction =
    options.isProduction ?? process.env.NODE_ENV === 'production';
  const supabaseUrl = validateAndNormalizeSupabaseUrl(
    options.supabaseUrl,
    isProduction,
  );
  const serviceRoleKey = validateServiceRoleKey(options.serviceRoleKey);
  const requestTimeoutMs = validateRequestTimeoutMs(options.requestTimeoutMs);

  const baseFetch = options.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new SupabaseAuthAdminError({
      code: 'AUTH_ADMIN_CONFIG_INVALID',
      message: 'A valid fetch implementation is required.',
      retryable: false,
    });
  }

  const boundedFetch = createBoundedFetch(
    baseFetch,
    requestTimeoutMs,
    serviceRoleKey,
  );

  const adminClient: SupabaseAuthAdminDeleteClient =
    options.authAdminClient ??
    createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: boundedFetch,
      },
    }).auth.admin;

  const adapter: SupabaseAuthAdminAdapter = {
    async deleteUserById(
      supabaseAuthUserId: string,
    ): Promise<{ status: 'deleted' | 'already_absent' }> {
      const normalizedUserId =
        typeof supabaseAuthUserId === 'string' ? supabaseAuthUserId.trim() : '';

      if (!UUID_REGEX.test(normalizedUserId)) {
        throw new SupabaseAuthAdminError({
          code: 'INVALID_SUPABASE_AUTH_USER_ID',
          message:
            'supabaseAuthUserId must be a valid UUID before calling Supabase Auth Admin API.',
          retryable: false,
        });
      }

      const failureContext: FetchFailureContext = {};

      let response: SupabaseAuthAdminDeleteResponse;
      try {
        response = await fetchFailureStorage.run(failureContext, () =>
          adminClient.deleteUser(normalizedUserId, false),
        );
      } catch (thrownError) {
        throw classifyProviderFailure(
          thrownError,
          serviceRoleKey,
          failureContext,
        );
      }

      if (!response || typeof response !== 'object') {
        throw new SupabaseAuthAdminError({
          code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
          message:
            'Supabase Auth Admin deleteUser returned an empty or non-object response.',
          retryable: true,
        });
      }

      if (response.error !== null && response.error !== undefined) {
        if (
          isAuthApiError(response.error) &&
          response.error.status === 404 &&
          response.error.code === 'user_not_found'
        ) {
          return { status: 'already_absent' };
        }

        throw classifyProviderFailure(
          response.error,
          serviceRoleKey,
          failureContext,
        );
      }

      const deletedUser = response.data?.user;
      if (
        !deletedUser ||
        typeof deletedUser !== 'object' ||
        typeof deletedUser.id !== 'string' ||
        deletedUser.id.trim().toLowerCase() !== normalizedUserId.toLowerCase()
      ) {
        throw new SupabaseAuthAdminError({
          code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
          message:
            'Supabase Auth Admin deleteUser succeeded without a matching deleted user id.',
          retryable: true,
        });
      }

      return { status: 'deleted' };
    },
  };

  return Object.freeze(adapter);
}
