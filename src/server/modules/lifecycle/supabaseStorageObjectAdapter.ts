import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, StorageApiError } from '@supabase/supabase-js';
import { sanitizeStringValue } from '../../lib/logger';
import type { StorageObjectAdapter } from './storageAndPurge';

export const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_STORAGE_REQUEST_TIMEOUT_MS = 25_000;
export const MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH = 256;
export const MAX_STORAGE_BUCKET_LENGTH = 100;
export const MAX_STORAGE_OBJECT_KEY_LENGTH = 1024;

const BUCKET_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
function hasControlCharacters(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}
const OBJECT_KEY_SEGMENT_REGEX = /^[a-zA-Z0-9._~!$&'()*+,;=:@-]+$/;

export type SupabaseStorageErrorCode =
  | 'INVALID_STORAGE_BUCKET'
  | 'INVALID_STORAGE_OBJECT_KEY'
  | 'STORAGE_BUCKET_NOT_FOUND'
  | 'STORAGE_PROVIDER_UNCONFIRMED_404'
  | 'STORAGE_UNAUTHORIZED'
  | 'STORAGE_FORBIDDEN'
  | 'STORAGE_RATE_LIMITED'
  | 'STORAGE_PROVIDER_ERROR'
  | 'STORAGE_NETWORK_ERROR'
  | 'STORAGE_TIMEOUT'
  | 'STORAGE_REQUEST_ABORTED'
  | 'STORAGE_MALFORMED_RESPONSE';

export interface SupabaseStorageErrorOptions {
  code: SupabaseStorageErrorCode;
  message: string;
  status?: number | null;
  retryable: boolean;
  serviceRoleKey?: string;
  cause?: unknown;
}

/**
 * Typed error raised by the server-only Supabase Storage Object Adapter.
 *
 * Guarantees:
 * - Deterministic non-empty `.code` (`SupabaseStorageErrorCode`).
 * - Sanitized, single-line `.message` bounded to `<= 256` characters (`MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH`)
 *   so `processPendingStoredFileDeletion()` and `executeStorageFirstAccountPurge()` can safely persist
 *   `error.message` to `studexo.stored_files.last_purge_error` and `studexo.users.last_purge_error`.
 * - `.retryable` metadata distinguishing transient failures (rate-limit, 5xx, network, timeout)
 *   from permanent failures (invalid bucket/key, missing bucket, unconfirmed 404, 401/403, malformed response).
 */
export class SupabaseStorageError extends Error {
  readonly code: SupabaseStorageErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(options: SupabaseStorageErrorOptions) {
    const sanitizedMessage = sanitizeAndBoundStorageMessage(
      options.message,
      options.serviceRoleKey,
    );
    super(
      sanitizedMessage,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'SupabaseStorageError';
    const normalizedCode = typeof options.code === 'string' ? options.code.trim() : '';
    this.code = (
      normalizedCode.length > 0 ? normalizedCode : 'STORAGE_PROVIDER_ERROR'
    ) as SupabaseStorageErrorCode;
    this.status =
      typeof options.status === 'number' && Number.isFinite(options.status)
        ? options.status
        : null;
    this.retryable = Boolean(options.retryable);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StorageBucketOperationsClient {
  remove(paths: string[]): Promise<{
    data: Array<{ name?: unknown } & Record<string, unknown>> | null;
    error: unknown;
  }>;
  info(path: string): Promise<{
    data: ({ name?: unknown; bucketId?: unknown } & Record<string, unknown>) | null;
    error: unknown;
  }>;
}

export interface StorageAdminClient {
  from(bucketId: string): StorageBucketOperationsClient;
}

export interface SupabaseStorageObjectAdapterConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  isProduction?: boolean;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * Optional narrow test seam for unit tests that need to inject a pre-configured
   * `StorageClient`-compatible `.from(bucket)` double. Production code omits this
   * and constructs the client via `@supabase/supabase-js` `createClient(...)`.
   */
  storageClient?: StorageAdminClient;
}

interface FetchFailureContext {
  failureKind?: 'timeout' | 'abort' | 'network';
  failureCause?: unknown;
  httpResponseReceived?: boolean;
  httpStatus?: number;
}

const fetchFailureStorage = new AsyncLocalStorage<FetchFailureContext>();

function redactAdditionalStorageSecrets(value: string, serviceRoleKey?: string): string {
  let sanitized = value;

  if (serviceRoleKey && serviceRoleKey.trim().length > 0) {
    const trimmedKey = serviceRoleKey.trim();
    sanitized = sanitized.split(trimmedKey).join('[REDACTED]');
    const encodedKey = encodeURIComponent(trimmedKey);
    if (encodedKey !== trimmedKey) {
      sanitized = sanitized.split(encodedKey).join('[REDACTED]');
    }
  }

  // Redact Supabase secret/service keys, personal tokens, and JWT-shaped tokens
  sanitized = sanitized.replace(/\bsb_(?:secret|publishable|temp)_[A-Za-z0-9_-]+/g, '[REDACTED]');
  sanitized = sanitized.replace(/\bsbp_[A-Za-z0-9_-]+/g, '[REDACTED]');
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    '[REDACTED]',
  );

  // Redact any residual apikey / service_role / authorization key-value pairs
  sanitized = sanitized.replace(
    /((?:apikey|api_key|service_role_key|authorization|token|secret)\s*[:=]\s*)([^\s,;'"&]+)/gi,
    '$1[REDACTED]',
  );

  return sanitized;
}

export function sanitizeAndBoundStorageMessage(
  rawMessage: unknown,
  serviceRoleKey?: string,
): string {
  const baseText =
    typeof rawMessage === 'string' && rawMessage.trim().length > 0
      ? rawMessage
      : 'Supabase Storage request failed.';

  const preRedacted = redactAdditionalStorageSecrets(baseText, serviceRoleKey);
  const loggerSanitized = sanitizeStringValue(preRedacted);
  const postRedacted = redactAdditionalStorageSecrets(loggerSanitized, serviceRoleKey);
  const singleLine = postRedacted.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (singleLine.length === 0) {
    return 'Supabase Storage request failed.';
  }

  if (singleLine.length <= MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH) {
    return singleLine;
  }

  return `${singleLine.slice(0, MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function validateAndNormalizeSupabaseUrl(rawUrl: unknown, isProduction: boolean): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('Supabase Storage adapter requires a non-empty supabaseUrl.');
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Supabase Storage adapter received a malformed supabaseUrl.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Supabase Storage adapter supabaseUrl must use http: or https: protocol.');
  }

  if (isProduction && parsed.protocol !== 'https:') {
    throw new Error('Supabase Storage adapter requires an https: supabaseUrl in production.');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'Supabase Storage adapter supabaseUrl must not contain embedded credentials.',
    );
  }

  return parsed.origin;
}

function validateServiceRoleKey(rawKey: unknown): string {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new Error('Supabase Storage adapter requires a non-empty serviceRoleKey.');
  }
  return rawKey.trim();
}

function validateRequestTimeoutMs(rawTimeoutMs: unknown): number {
  if (rawTimeoutMs === undefined) {
    return DEFAULT_STORAGE_REQUEST_TIMEOUT_MS;
  }
  if (
    typeof rawTimeoutMs !== 'number' ||
    !Number.isFinite(rawTimeoutMs) ||
    !Number.isInteger(rawTimeoutMs) ||
    rawTimeoutMs <= 0 ||
    rawTimeoutMs > MAX_STORAGE_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `Supabase Storage adapter requestTimeoutMs must be an integer between 1 and ${MAX_STORAGE_REQUEST_TIMEOUT_MS}.`,
    );
  }
  return rawTimeoutMs;
}

/**
 * Validates the bucket name before any SDK or network call.
 * Never trims, rewrites, or normalizes the caller-supplied bucket name.
 */
export function assertValidStorageBucket(bucket: unknown, serviceRoleKey?: string): string {
  if (
    typeof bucket !== 'string' ||
    bucket.length < 1 ||
    bucket.length > MAX_STORAGE_BUCKET_LENGTH ||
    bucket.trim() !== bucket ||
    bucket === '.' ||
    bucket === '..' ||
    !BUCKET_NAME_REGEX.test(bucket)
  ) {
    throw new SupabaseStorageError({
      code: 'INVALID_STORAGE_BUCKET',
      message:
        'Invalid storage bucket name: must be 1-100 characters matching /^[a-zA-Z0-9._-]+$/ and not "." or "..".',
      status: null,
      retryable: false,
      serviceRoleKey,
    });
  }

  return bucket;
}

/**
 * Validates the object key before any SDK or network call.
 * Never trims, normalizes, encodes, decodes, collapses, or rewrites persisted object keys.
 */
export function assertValidStorageObjectKey(objectKey: unknown, serviceRoleKey?: string): string {
  if (
    typeof objectKey !== 'string' ||
    objectKey.length < 1 ||
    objectKey.length > MAX_STORAGE_OBJECT_KEY_LENGTH ||
    objectKey.trim() !== objectKey ||
    hasControlCharacters(objectKey) ||
    objectKey.startsWith('/') ||
    objectKey.endsWith('/') ||
    objectKey.includes('\\') ||
    objectKey.includes('?') ||
    objectKey.includes('#') ||
    objectKey.includes('%')
  ) {
    throw new SupabaseStorageError({
      code: 'INVALID_STORAGE_OBJECT_KEY',
      message:
        'Invalid storage object key: must be a 1-1024 character relative path without control characters, leading/trailing slashes, backslashes, "?", "#", or "%".',
      status: null,
      retryable: false,
      serviceRoleKey,
    });
  }

  const segments = objectKey.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      !OBJECT_KEY_SEGMENT_REGEX.test(segment)
    ) {
      throw new SupabaseStorageError({
        code: 'INVALID_STORAGE_OBJECT_KEY',
        message:
          'Invalid storage object key: path segments must be non-empty, must not be "." or "..", and must match /^[a-zA-Z0-9._~!$&\'()*+,;=:@-]+$/.',
        status: null,
        retryable: false,
        serviceRoleKey,
      });
    }
  }

  return objectKey;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.name === 'TimeoutError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 20
  );
}

function createBoundedFetch(params: {
  baseFetch: typeof globalThis.fetch;
  requestTimeoutMs: number;
  serviceRoleKey: string;
}): typeof globalThis.fetch {
  const { baseFetch, requestTimeoutMs, serviceRoleKey } = params;

  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const store = fetchFailureStorage.getStore();
    if (store) {
      store.failureKind = undefined;
      store.failureCause = undefined;
      store.httpResponseReceived = false;
      store.httpStatus = undefined;
    }

    const timeoutController = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(
        new Error(`Supabase Storage HTTP request timed out after ${requestTimeoutMs}ms.`),
      );
    }, requestTimeoutMs);

    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      timer.unref?.();
    }

    const callerSignal = init?.signal ?? undefined;
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await baseFetch(input, {
        ...init,
        signal: combinedSignal,
      });

      if (store) {
        store.httpResponseReceived = true;
        store.httpStatus = response.status;
      }

      return response;
    } catch (error) {
      if (store) {
        if (timedOut) {
          store.failureKind = 'timeout';
          store.failureCause = error;
        } else if (callerSignal?.aborted || isAbortLikeError(error)) {
          store.failureKind = 'abort';
          store.failureCause = error;
        } else {
          store.failureKind = 'network';
          store.failureCause = error;
        }
      }

      if (timedOut) {
        throw new Error(`Supabase Storage HTTP request timed out after ${requestTimeoutMs}ms.`, {
          cause: error,
        });
      }

      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeAndBoundStorageMessage(rawMessage, serviceRoleKey), {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseNumericStatus(status: unknown, statusCode: unknown): number | null {
  if (typeof status === 'number' && Number.isFinite(status) && status > 0) {
    return status;
  }
  if (typeof statusCode === 'string' && /^\d{3}$/.test(statusCode.trim())) {
    const parsed = Number.parseInt(statusCode.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function classifyStorageFailure(
  error: unknown,
  serviceRoleKey: string,
  failureContext?: FetchFailureContext,
): SupabaseStorageError {
  if (error instanceof SupabaseStorageError) {
    return error;
  }

  // 1. Explicit timeout / caller-abort / network failure captured at the fetch boundary
  if (failureContext?.failureKind === 'timeout') {
    return new SupabaseStorageError({
      code: 'STORAGE_TIMEOUT',
      message: error instanceof Error ? error.message : 'Supabase Storage request timed out.',
      status: null,
      retryable: true,
      serviceRoleKey,
      cause: failureContext.failureCause ?? error,
    });
  }

  if (failureContext?.failureKind === 'abort') {
    return new SupabaseStorageError({
      code: 'STORAGE_REQUEST_ABORTED',
      message: error instanceof Error ? error.message : 'Supabase Storage request was aborted.',
      status: null,
      retryable: true,
      serviceRoleKey,
      cause: failureContext.failureCause ?? error,
    });
  }

  if (failureContext?.failureKind === 'network') {
    return new SupabaseStorageError({
      code: 'STORAGE_NETWORK_ERROR',
      message: error instanceof Error ? error.message : 'Supabase Storage network request failed.',
      status: null,
      retryable: true,
      serviceRoleKey,
      cause: failureContext.failureCause ?? error,
    });
  }

  // 2. If an HTTP 2xx response was received from fetch, but `@supabase/storage-js` `_handleRequest`
  //    rejected while calling `result.json()` (wrapped in `StorageUnknownError`), classify as malformed response.
  if (failureContext?.httpResponseReceived && !failureContext.failureKind) {
    const status = failureContext.httpStatus ?? 200;
    if (status >= 200 && status < 300) {
      return new SupabaseStorageError({
        code: 'STORAGE_MALFORMED_RESPONSE',
        message: `Supabase Storage returned HTTP ${status} with a non-JSON or malformed response body.`,
        status,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }
  }

  // 3. Public `StorageApiError` from `@supabase/supabase-js`
  if (error instanceof StorageApiError) {
    const status = parseNumericStatus(error.status, error.statusCode);
    const providerCode =
      typeof error.code === 'string' && error.code.trim().length > 0 ? error.code.trim() : null;

    if (providerCode === 'NoSuchBucket') {
      return new SupabaseStorageError({
        code: 'STORAGE_BUCKET_NOT_FOUND',
        message: `Supabase Storage bucket does not exist (NoSuchBucket): ${error.message}`,
        status: status ?? 404,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 404 || error.statusCode === '404') {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
        message: `Unconfirmed 404 from Supabase Storage (code=${providerCode ?? 'none'}): ${error.message}`,
        status: 404,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 401 || providerCode === 'InvalidJWT') {
      return new SupabaseStorageError({
        code: 'STORAGE_UNAUTHORIZED',
        message: `Supabase Storage unauthorized (HTTP ${status ?? 401}${providerCode ? `, code=${providerCode}` : ''}): ${error.message}`,
        status: status ?? 401,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (
      status === 403 ||
      providerCode === 'AccessDenied' ||
      providerCode === 'InsufficientPermissions'
    ) {
      return new SupabaseStorageError({
        code: 'STORAGE_FORBIDDEN',
        message: `Supabase Storage forbidden (HTTP ${status ?? 403}${providerCode ? `, code=${providerCode}` : ''}): ${error.message}`,
        status: status ?? 403,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (
      status === 429 ||
      providerCode === 'SlowDown' ||
      providerCode === 'TooManyRequests'
    ) {
      return new SupabaseStorageError({
        code: 'STORAGE_RATE_LIMITED',
        message: `Supabase Storage rate limited (HTTP ${status ?? 429}${providerCode ? `, code=${providerCode}` : ''}): ${error.message}`,
        status: status ?? 429,
        retryable: true,
        serviceRoleKey,
        cause: error,
      });
    }

    if (
      (status !== null && status >= 500 && status < 600) ||
      providerCode === 'InternalError' ||
      providerCode === 'DatabaseTimeout' ||
      providerCode === 'ServiceUnavailable'
    ) {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_ERROR',
        message: `Supabase Storage server error (HTTP ${status ?? 500}${providerCode ? `, code=${providerCode}` : ''}): ${error.message}`,
        status: status ?? 500,
        retryable: true,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status !== null && status >= 400 && status < 500) {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_ERROR',
        message: `Supabase Storage request rejected (HTTP ${status}${providerCode ? `, code=${providerCode}` : ''}): ${error.message}`,
        status,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    return new SupabaseStorageError({
      code: 'STORAGE_PROVIDER_ERROR',
      message: error.message || 'Supabase Storage API error.',
      status,
      retryable: true,
      serviceRoleKey,
      cause: error,
    });
  }

  // 4. Inspect non-`StorageApiError` objects (including `StorageUnknownError` or plain objects from test doubles)
  if (error && typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
      originalError?: unknown;
    };

    const status = parseNumericStatus(candidate.status, candidate.statusCode);
    const providerCode =
      typeof candidate.code === 'string' && candidate.code.trim().length > 0
        ? candidate.code.trim()
        : null;
    const messageText =
      typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? candidate.message
        : 'Supabase Storage provider error.';

    if (providerCode === 'NoSuchBucket') {
      return new SupabaseStorageError({
        code: 'STORAGE_BUCKET_NOT_FOUND',
        message: `Supabase Storage bucket does not exist: ${messageText}`,
        status: status ?? 404,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 404) {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
        message: `Unconfirmed 404 from Supabase Storage (not a confirmed StorageApiError): ${messageText}`,
        status: 404,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 401) {
      return new SupabaseStorageError({
        code: 'STORAGE_UNAUTHORIZED',
        message: messageText,
        status: 401,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 403) {
      return new SupabaseStorageError({
        code: 'STORAGE_FORBIDDEN',
        message: messageText,
        status: 403,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status === 429) {
      return new SupabaseStorageError({
        code: 'STORAGE_RATE_LIMITED',
        message: messageText,
        status: 429,
        retryable: true,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status !== null && status >= 500 && status < 600) {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_ERROR',
        message: messageText,
        status,
        retryable: true,
        serviceRoleKey,
        cause: error,
      });
    }

    if (status !== null && status >= 400 && status < 500) {
      return new SupabaseStorageError({
        code: 'STORAGE_PROVIDER_ERROR',
        message: messageText,
        status,
        retryable: false,
        serviceRoleKey,
        cause: error,
      });
    }

    const underlying = candidate.originalError ?? error;
    if (isAbortLikeError(underlying)) {
      return new SupabaseStorageError({
        code: 'STORAGE_REQUEST_ABORTED',
        message: messageText,
        status: null,
        retryable: true,
        serviceRoleKey,
        cause: error,
      });
    }
  }

  return new SupabaseStorageError({
    code: 'STORAGE_NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'Supabase Storage request failed.',
    status: null,
    retryable: true,
    serviceRoleKey,
    cause: error,
  });
}

function matchesRemovedObjectPath(
  candidateName: string,
  bucket: string,
  objectKey: string,
): boolean {
  return candidateName === objectKey || candidateName === `${bucket}/${objectKey}`;
}

/**
 * Creates a server-only `StorageObjectAdapter` backed by `@supabase/supabase-js` Storage API.
 *
 * Security & architectural invariants:
 * - Never exposes the underlying `SupabaseClient`, `StorageClient`, PostgREST, or upload/signed-URL APIs.
 * - Uses session-less configuration (`autoRefreshToken: false`, `persistSession: false`, `detectSessionInUrl: false`).
 * - Validates `bucket` and `objectKey` before any network activity without silently rewriting persisted keys.
 * - `removeObject` invokes `client.storage.from(bucket).remove([objectKey])`.
 * - `verifyObjectAbsent` invokes `client.storage.from(bucket).info(objectKey)` (never `exists()`) and returns
 *   `true` strictly and exclusively when `error` is a public `StorageApiError` with `code === 'NoSuchKey'`.
 */
export function createSupabaseStorageObjectAdapter(
  config: SupabaseStorageObjectAdapterConfig,
): StorageObjectAdapter {
  if (!config || typeof config !== 'object') {
    throw new Error('Supabase Storage adapter requires a configuration object.');
  }

  const isProduction = config.isProduction ?? process.env.NODE_ENV === 'production';
  const supabaseUrl = validateAndNormalizeSupabaseUrl(config.supabaseUrl, isProduction);
  const serviceRoleKey = validateServiceRoleKey(config.serviceRoleKey);
  const requestTimeoutMs = validateRequestTimeoutMs(config.requestTimeoutMs);

  const baseFetch = config.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new Error('Supabase Storage adapter requires a valid fetch implementation.');
  }

  const boundedFetch = createBoundedFetch({
    baseFetch,
    requestTimeoutMs,
    serviceRoleKey,
  });

  const storageClient: StorageAdminClient =
    config.storageClient ??
    (createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: boundedFetch,
      },
    }).storage as unknown as StorageAdminClient);

  const adapter: StorageObjectAdapter = {
    async removeObject(bucket: string, objectKey: string): Promise<void> {
      const validBucket = assertValidStorageBucket(bucket, serviceRoleKey);
      const validObjectKey = assertValidStorageObjectKey(objectKey, serviceRoleKey);

      const failureContext: FetchFailureContext = {};
      let response: Awaited<ReturnType<StorageBucketOperationsClient['remove']>>;

      try {
        response = await fetchFailureStorage.run(failureContext, () =>
          storageClient.from(validBucket).remove([validObjectKey]),
        );
      } catch (thrownError) {
        if (thrownError instanceof StorageApiError && thrownError.code === 'NoSuchKey') {
          return;
        }
        throw classifyStorageFailure(thrownError, serviceRoleKey, failureContext);
      }

      if (!response || typeof response !== 'object') {
        throw new SupabaseStorageError({
          code: 'STORAGE_MALFORMED_RESPONSE',
          message: 'Supabase Storage remove() returned an empty or non-object response.',
          status: failureContext.httpStatus ?? null,
          retryable: false,
          serviceRoleKey,
        });
      }

      if (response.error) {
        if (response.error instanceof StorageApiError && response.error.code === 'NoSuchKey') {
          return;
        }
        throw classifyStorageFailure(response.error, serviceRoleKey, failureContext);
      }

      if (!Array.isArray(response.data)) {
        throw new SupabaseStorageError({
          code: 'STORAGE_MALFORMED_RESPONSE',
          message: 'Supabase Storage remove() succeeded without returning a deleted-objects array.',
          status: failureContext.httpStatus ?? 200,
          retryable: false,
          serviceRoleKey,
        });
      }

      for (const entry of response.data) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          typeof entry.name !== 'string' ||
          !matchesRemovedObjectPath(entry.name, validBucket, validObjectKey)
        ) {
          throw new SupabaseStorageError({
            code: 'STORAGE_MALFORMED_RESPONSE',
            message:
              'Supabase Storage remove() returned a malformed or mismatched FileObject entry.',
            status: failureContext.httpStatus ?? 200,
            retryable: false,
            serviceRoleKey,
          });
        }
      }
    },

    async verifyObjectAbsent(bucket: string, objectKey: string): Promise<boolean> {
      const validBucket = assertValidStorageBucket(bucket, serviceRoleKey);
      const validObjectKey = assertValidStorageObjectKey(objectKey, serviceRoleKey);

      const failureContext: FetchFailureContext = {};
      let response: Awaited<ReturnType<StorageBucketOperationsClient['info']>>;

      try {
        response = await fetchFailureStorage.run(failureContext, () =>
          storageClient.from(validBucket).info(validObjectKey),
        );
      } catch (thrownError) {
        if (thrownError instanceof StorageApiError && thrownError.code === 'NoSuchKey') {
          return true;
        }
        throw classifyStorageFailure(thrownError, serviceRoleKey, failureContext);
      }

      if (!response || typeof response !== 'object') {
        throw new SupabaseStorageError({
          code: 'STORAGE_MALFORMED_RESPONSE',
          message: 'Supabase Storage info() returned an empty or non-object response.',
          status: failureContext.httpStatus ?? null,
          retryable: false,
          serviceRoleKey,
        });
      }

      if (response.error) {
        if (response.error instanceof StorageApiError && response.error.code === 'NoSuchKey') {
          return true;
        }
        throw classifyStorageFailure(response.error, serviceRoleKey, failureContext);
      }

      const infoData = response.data;
      if (
        !infoData ||
        typeof infoData !== 'object' ||
        Array.isArray(infoData) ||
        typeof infoData.name !== 'string' ||
        !matchesRemovedObjectPath(infoData.name, validBucket, validObjectKey)
      ) {
        throw new SupabaseStorageError({
          code: 'STORAGE_MALFORMED_RESPONSE',
          message:
            'Supabase Storage info() returned HTTP 200 without valid matching object metadata.',
          status: failureContext.httpStatus ?? 200,
          retryable: false,
          serviceRoleKey,
        });
      }

      if (
        infoData.bucketId !== undefined &&
        infoData.bucketId !== null &&
        infoData.bucketId !== validBucket
      ) {
        throw new SupabaseStorageError({
          code: 'STORAGE_MALFORMED_RESPONSE',
          message: 'Supabase Storage info() returned metadata for a mismatched bucketId.',
          status: failureContext.httpStatus ?? 200,
          retryable: false,
          serviceRoleKey,
        });
      }

      return false;
    },
  };

  return Object.freeze(adapter);
}
