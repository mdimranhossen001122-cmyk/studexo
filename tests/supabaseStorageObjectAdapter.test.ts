import { describe, expect, it, vi } from 'vitest';
import {
  executeStorageFirstAccountPurge,
  processPendingStoredFileDeletion,
  recoverInterruptedAccountPurge,
  type AccountPurgeLeaseRecoveryRepository,
  type AccountPurgeRepository,
  type FilePurgeLeaseRecoveryRepository,
  type FilePurgeWorkerRepository,
  type StoredFileLifecycleRecord,
  type UserLifecycleRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';
import {
  createSupabaseStorageObjectAdapter,
  MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH,
  MAX_STORAGE_BUCKET_LENGTH,
  MAX_STORAGE_OBJECT_KEY_LENGTH,
  SupabaseStorageError,
  type StorageAdminClient,
} from '../src/server/modules/lifecycle/supabaseStorageObjectAdapter';

const TEST_SUPABASE_URL = 'https://studexo-storage-unit.supabase.co';
const TEST_SERVICE_ROLE_KEY = 'sb_secret_unit_test_storage_service_role_9988776655';
const TEST_JWT_SECRET =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.signature_secret_token';
const VALID_BUCKET = 'student-documents';
const VALID_OBJECT_KEY = 'users/22222222-2222-4222-8222-222222222222/cv.pdf';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

function extractHeaders(init?: Parameters<typeof globalThis.fetch>[1]): Record<string, string> {
  const record: Record<string, string> = {};
  if (!init?.headers) {
    return record;
  }
  const headers = new Headers(init.headers);
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

async function readBodyText(
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<string | null> {
  if (init?.body === undefined || init?.body === null) {
    return null;
  }
  if (typeof init.body === 'string') {
    return init.body;
  }
  return String(init.body);
}

function jsonResponse(status: number, payload: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function validInfoPayload(bucket = VALID_BUCKET, objectKey = VALID_OBJECT_KEY) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    version: 'v1',
    name: objectKey,
    bucket_id: bucket,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
    last_modified: '2026-11-17T00:00:00.000Z',
    size: 2048,
    content_type: 'application/pdf',
  };
}

function validRemoveEntry(bucket = VALID_BUCKET, objectKey = VALID_OBJECT_KEY) {
  return {
    name: objectKey,
    id: '44444444-4444-4444-8444-444444444444',
    bucket_id: bucket,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
    last_accessed_at: '2026-11-17T00:00:00.000Z',
    metadata: null,
  };
}

describe('Phase 8B.4D.1 — Supabase Storage Object Adapter (Offline Verification)', () => {
  it('1. validates adapter configuration, enforces HTTPS in production, rejects embedded credentials, and freezes the narrow adapter surface (Req 19)', () => {
    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: '',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrow(/non-empty supabaseUrl/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: 'not-a-valid-url',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrow(/malformed supabaseUrl/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: 'ftp://studexo.supabase.co',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrow(/http: or https:/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: 'http://studexo.supabase.co',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        isProduction: true,
      }),
    ).toThrow(/requires an https: supabaseUrl in production/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: 'https://admin:secret@studexo.supabase.co',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrow(/embedded credentials/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: '   ',
      }),
    ).toThrow(/non-empty serviceRoleKey/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        requestTimeoutMs: 0,
      }),
    ).toThrow(/requestTimeoutMs/);

    expect(() =>
      createSupabaseStorageObjectAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        requestTimeoutMs: 25_001,
      }),
    ).toThrow(/requestTimeoutMs/);

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: 'http://127.0.0.1:54321',
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      isProduction: false,
      fetch: async () => jsonResponse(200, []),
    });

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.keys(adapter).sort()).toEqual(['removeObject', 'verifyObjectAbsent']);
    expect('storage' in adapter).toBe(false);
    expect('auth' in adapter).toBe(false);
    expect('from' in adapter).toBe(false);
    expect('rpc' in adapter).toBe(false);
  });

  it('2. executes successful single-object removal, empty removal result, and explicit NoSuchKey during removal (Reqs 1, 2, 3, 20)', async () => {
    const requests: RecordedRequest[] = [];
    let callIndex = 0;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: extractHeaders(init),
        bodyText: await readBodyText(init),
      });

      callIndex += 1;
      if (callIndex === 1) {
        // 1. Standard non-empty removal response
        return jsonResponse(200, [validRemoveEntry()]);
      }
      if (callIndex === 2) {
        // 2. Empty array removal result (object already absent in Storage)
        return jsonResponse(200, []);
      }
      // 3. Explicit confirmed NoSuchKey during removal
      return jsonResponse(404, {
        statusCode: '404',
        error: 'not_found',
        message: 'Object not found',
        code: 'NoSuchKey',
      });
    };

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: mockFetch,
    });

    await expect(adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBeUndefined();
    await expect(adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBeUndefined();
    await expect(adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBeUndefined();

    expect(requests).toHaveLength(3);
    for (const req of requests) {
      expect(req.method).toBe('DELETE');
      expect(req.url).toBe(`${TEST_SUPABASE_URL}/storage/v1/object/${VALID_BUCKET}`);
      expect(req.headers['apikey']).toBe(TEST_SERVICE_ROLE_KEY);
      expect(req.headers['authorization']).toBe(`Bearer ${TEST_SERVICE_ROLE_KEY}`);
      expect(JSON.parse(req.bodyText ?? '{}')).toEqual({
        prefixes: [VALID_OBJECT_KEY],
      });
    }
  });

  it('3. verifies object absence using info(objectKey): returns false on valid metadata and true strictly on StorageApiError + NoSuchKey (Reqs 4, 5, 20)', async () => {
    const requests: RecordedRequest[] = [];
    let callIndex = 0;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: extractHeaders(init),
        bodyText: await readBodyText(init),
      });

      callIndex += 1;
      if (callIndex === 1) {
        return jsonResponse(200, validInfoPayload());
      }
      return jsonResponse(400, {
        statusCode: '404',
        error: 'not_found',
        message: 'Object not found',
        code: 'NoSuchKey',
      });
    };

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: mockFetch,
    });

    // 1. Metadata exists -> returns false
    await expect(adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBe(false);

    // 2. Confirmed StorageApiError with code === 'NoSuchKey' -> returns true
    await expect(adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBe(true);

    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.method).toBe('GET');
      expect(req.url).toBe(
        `${TEST_SUPABASE_URL}/storage/v1/object/info/${VALID_BUCKET}/${VALID_OBJECT_KEY}`,
      );
      expect(req.headers['apikey']).toBe(TEST_SERVICE_ROLE_KEY);
    }

    // 3. Narrow test double: verify that info(objectKey) (not exists) is invoked with exact bucket & key
    const removeSpy = vi.fn(async () => ({
      data: [validRemoveEntry()],
      error: null,
    }));
    const infoSpy = vi.fn(async () => ({
      data: validInfoPayload(),
      error: null,
    }));
    const fromSpy = vi.fn(() => ({
      remove: removeSpy,
      info: infoSpy,
    }));

    const seamAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      storageClient: { from: fromSpy },
    });

    await seamAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY);
    await expect(seamAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY)).resolves.toBe(
      false,
    );

    expect(fromSpy).toHaveBeenNthCalledWith(1, VALID_BUCKET);
    expect(fromSpy).toHaveBeenNthCalledWith(2, VALID_BUCKET);
    expect(removeSpy).toHaveBeenCalledWith([VALID_OBJECT_KEY]);
    expect(infoSpy).toHaveBeenCalledWith(VALID_OBJECT_KEY);
  });

  it('4. rejects NoSuchBucket and generic/unconfirmed 404 responses on both removeObject and verifyObjectAbsent (Reqs 6, 7)', async () => {
    // 4a. NoSuchBucket on info() and remove()
    const noSuchBucketAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(404, {
          statusCode: '404',
          error: 'Bucket not found',
          message: 'Bucket not found',
          code: 'NoSuchBucket',
        }),
    });

    await expect(
      noSuchBucketAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      name: 'SupabaseStorageError',
      code: 'STORAGE_BUCKET_NOT_FOUND',
      status: 404,
      retryable: false,
    });

    await expect(
      noSuchBucketAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      name: 'SupabaseStorageError',
      code: 'STORAGE_BUCKET_NOT_FOUND',
      status: 404,
      retryable: false,
    });

    // 4b. Generic 404 JSON without code (which StorageFileApi.exists() would have falsely treated as absent!)
    const genericJson404Adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(404, {
          statusCode: '404',
          error: 'Not Found',
          message: 'Route not found',
        }),
    });

    await expect(
      genericJson404Adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      name: 'SupabaseStorageError',
      code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
      status: 404,
      retryable: false,
    });

    await expect(
      genericJson404Adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      name: 'SupabaseStorageError',
      code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
      status: 404,
      retryable: false,
    });

    // 4c. Non-JSON HTML 404 from upstream proxy / CDN
    const html404Adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        new Response('<html><body>404 Not Found</body></html>', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'text/html' },
        }),
    });

    await expect(
      html404Adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      name: 'SupabaseStorageError',
      code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
      status: 404,
      retryable: false,
    });

    // 4d. Spoofed plain object `{ status: 404, code: 'NoSuchKey' }` that is NOT an instance of StorageApiError
    const spoofedPlainObjectClient: StorageAdminClient = {
      from: () => ({
        remove: async () => ({
          data: null,
          error: { status: 404, statusCode: '404', code: 'NoSuchKey', message: 'spoofed' },
        }),
        info: async () => ({
          data: null,
          error: { status: 404, statusCode: '404', code: 'NoSuchKey', message: 'spoofed' },
        }),
      }),
    };

    const spoofedAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      storageClient: spoofedPlainObjectClient,
    });

    await expect(
      spoofedAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
      retryable: false,
    });

    await expect(
      spoofedAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_PROVIDER_UNCONFIRMED_404',
      retryable: false,
    });
  });

  it('5. classifies 401, 403, 429, 5xx, and 4xx provider errors with deterministic codes and retryability (Reqs 8, 9, 10)', async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      expectedCode: SupabaseStorageError['code'];
      expectedRetryable: boolean;
    }> = [
      {
        status: 401,
        body: { statusCode: '401', error: 'Unauthorized', message: 'Invalid JWT', code: 'InvalidJWT' },
        expectedCode: 'STORAGE_UNAUTHORIZED',
        expectedRetryable: false,
      },
      {
        status: 403,
        body: {
          statusCode: '403',
          error: 'Forbidden',
          message: 'Access denied by policy',
          code: 'AccessDenied',
        },
        expectedCode: 'STORAGE_FORBIDDEN',
        expectedRetryable: false,
      },
      {
        status: 429,
        body: {
          statusCode: '429',
          error: 'TooManyRequests',
          message: 'Rate limit exceeded',
          code: 'TooManyRequests',
        },
        expectedCode: 'STORAGE_RATE_LIMITED',
        expectedRetryable: true,
      },
      {
        status: 500,
        body: {
          statusCode: '500',
          error: 'InternalServerError',
          message: 'Database timeout',
          code: 'InternalError',
        },
        expectedCode: 'STORAGE_PROVIDER_ERROR',
        expectedRetryable: true,
      },
      {
        status: 503,
        body: {
          statusCode: '503',
          error: 'ServiceUnavailable',
          message: 'Upstream S3 unavailable',
        },
        expectedCode: 'STORAGE_PROVIDER_ERROR',
        expectedRetryable: true,
      },
      {
        status: 400,
        body: {
          statusCode: '400',
          error: 'InvalidKey',
          message: 'Invalid key format',
          code: 'InvalidKey',
        },
        expectedCode: 'STORAGE_PROVIDER_ERROR',
        expectedRetryable: false,
      },
    ];

    for (const testCase of cases) {
      const adapter = createSupabaseStorageObjectAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        fetch: async () => jsonResponse(testCase.status, testCase.body),
      });

      for (const invoke of [
        () => adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
        () => adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
      ]) {
        let caught: unknown;
        try {
          await invoke();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SupabaseStorageError);
        const storageErr = caught as SupabaseStorageError;
        expect(storageErr.code).toBe(testCase.expectedCode);
        expect(storageErr.status).toBe(testCase.status);
        expect(storageErr.retryable).toBe(testCase.expectedRetryable);
        expect(storageErr.message.length).toBeGreaterThan(0);
        expect(storageErr.message.length).toBeLessThanOrEqual(
          MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH,
        );
      }
    }
  });

  it('6. rejects non-JSON and malformed HTTP 200 responses on both removeObject and verifyObjectAbsent (Req 11)', async () => {
    // 6a. HTTP 200 with non-JSON HTML body
    const html200Adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        new Response('<html>200 OK Gateway Intercept</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    await expect(
      html200Adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      status: 200,
      retryable: false,
    });

    await expect(
      html200Adapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      status: 200,
      retryable: false,
    });

    // 6b. HTTP 200 on remove() returning a non-array JSON object `{}`
    const objectInsteadOfArrayAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => jsonResponse(200, { unexpected: true }),
    });

    await expect(
      objectInsteadOfArrayAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      retryable: false,
    });

    // 6c. HTTP 200 on remove() returning an entry with a mismatched object name
    const mismatchedRemoveAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(200, [validRemoveEntry(VALID_BUCKET, 'users/other/wrong.pdf')]),
    });

    await expect(
      mismatchedRemoveAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      retryable: false,
    });

    // 6d. HTTP 200 on info() returning `{}` (missing `name`) or mismatched `name` / `bucket_id`
    const emptyInfoAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => jsonResponse(200, {}),
    });

    await expect(
      emptyInfoAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      retryable: false,
    });

    const mismatchedBucketInfoAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => jsonResponse(200, validInfoPayload('wrong-bucket', VALID_OBJECT_KEY)),
    });

    await expect(
      mismatchedBucketInfoAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_MALFORMED_RESPONSE',
      retryable: false,
    });
  });

  it('7. classifies network failures, per-request timeouts, caller aborts, and isolates concurrent calls on a shared adapter instance (Reqs 12, 13)', async () => {
    // 7a. Network failure (ECONNREFUSED)
    const networkAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:54321');
      },
    });

    await expect(
      networkAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_NETWORK_ERROR',
      status: null,
      retryable: true,
    });

    await expect(
      networkAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_NETWORK_ERROR',
      status: null,
      retryable: true,
    });

    // 7b. Per-request timeout on removeObject and verifyObjectAbsent
    const timeoutAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      requestTimeoutMs: 40,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    });

    await expect(
      timeoutAdapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_TIMEOUT',
      status: null,
      retryable: true,
    });

    await expect(
      timeoutAdapter.verifyObjectAbsent(VALID_BUCKET, VALID_OBJECT_KEY),
    ).rejects.toMatchObject({
      code: 'STORAGE_TIMEOUT',
      status: null,
      retryable: true,
    });

    // 7c. Concurrent requests on the SAME shared adapter instance do not cross-contaminate AsyncLocalStorage contexts
    const sharedAdapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      requestTimeoutMs: 45,
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('timeout.pdf')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        if (url.includes('network.pdf')) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new TypeError('socket hang up');
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
        return jsonResponse(404, {
          statusCode: '404',
          error: 'not_found',
          message: 'Object not found',
          code: 'NoSuchKey',
        });
      },
    });

    const [timeoutOutcome, networkOutcome, absentOutcome] = await Promise.allSettled([
      sharedAdapter.verifyObjectAbsent(VALID_BUCKET, 'users/u1/timeout.pdf'),
      sharedAdapter.verifyObjectAbsent(VALID_BUCKET, 'users/u1/network.pdf'),
      sharedAdapter.verifyObjectAbsent(VALID_BUCKET, 'users/u1/absent.pdf'),
    ]);

    expect(timeoutOutcome.status).toBe('rejected');
    if (timeoutOutcome.status === 'rejected') {
      expect((timeoutOutcome.reason as SupabaseStorageError).code).toBe('STORAGE_TIMEOUT');
    }

    expect(networkOutcome.status).toBe('rejected');
    if (networkOutcome.status === 'rejected') {
      expect((networkOutcome.reason as SupabaseStorageError).code).toBe('STORAGE_NETWORK_ERROR');
    }

    expect(absentOutcome).toEqual({ status: 'fulfilled', value: true });
  });

  it('8. rejects invalid bucket names and invalid object keys before making any network calls, and accepts all existing repository fixture keys unchanged (Reqs 14, 15, 16, 17)', async () => {
    const fetchSpy = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/object/info/')) {
        return jsonResponse(404, {
          statusCode: '404',
          error: 'not_found',
          message: 'Object not found',
          code: 'NoSuchKey',
        });
      }
      return jsonResponse(200, []);
    });

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: fetchSpy,
    });

    const invalidBuckets = [
      '',
      ' ',
      ' leading-space',
      'trailing-space ',
      '.',
      '..',
      'bucket/with/slash',
      'bucket\\backslash',
      'bucket?query=1',
      'bucket#hash',
      'bucket with space',
      'bucket%20encoded',
      'bucket\u0000null',
      'b'.repeat(MAX_STORAGE_BUCKET_LENGTH + 1),
    ];

    for (const invalidBucket of invalidBuckets) {
      await expect(adapter.removeObject(invalidBucket, VALID_OBJECT_KEY)).rejects.toMatchObject({
        name: 'SupabaseStorageError',
        code: 'INVALID_STORAGE_BUCKET',
        retryable: false,
      });
      await expect(
        adapter.verifyObjectAbsent(invalidBucket, VALID_OBJECT_KEY),
      ).rejects.toMatchObject({
        name: 'SupabaseStorageError',
        code: 'INVALID_STORAGE_BUCKET',
        retryable: false,
      });
    }

    const invalidObjectKeys = [
      '',
      ' ',
      ' users/u1/doc.pdf',
      'users/u1/doc.pdf ',
      '/users/u1/doc.pdf',
      'users/u1/doc.pdf/',
      'users//u1/doc.pdf',
      '.',
      '..',
      './users/u1/doc.pdf',
      'users/../u1/doc.pdf',
      'users/./u1/doc.pdf',
      'users/u1/..',
      'users/u1/.',
      'users\\u1\\doc.pdf',
      'users/u1/doc.pdf?versionId=1',
      'users/u1/doc.pdf#fragment',
      'users/u1/doc%20name.pdf',
      'users/u1/doc with spaces.pdf',
      'users/u1/résumé.pdf',
      'users/u1/文件.pdf',
      'users/u1/doc\u0000.pdf',
      'users/u1/doc\u001f.pdf',
      'users/u1/doc\u007f.pdf',
      'users/u1/doc\u0085.pdf',
      `users/${'a'.repeat(MAX_STORAGE_OBJECT_KEY_LENGTH)}`,
    ];

    for (const invalidKey of invalidObjectKeys) {
      await expect(adapter.removeObject(VALID_BUCKET, invalidKey)).rejects.toMatchObject({
        name: 'SupabaseStorageError',
        code: 'INVALID_STORAGE_OBJECT_KEY',
        retryable: false,
      });
      await expect(adapter.verifyObjectAbsent(VALID_BUCKET, invalidKey)).rejects.toMatchObject({
        name: 'SupabaseStorageError',
        code: 'INVALID_STORAGE_OBJECT_KEY',
        retryable: false,
      });
    }

    // Zero network requests must have been made for all invalid inputs above
    expect(fetchSpy).not.toHaveBeenCalled();

    // All existing repository fixture bucket + objectKey combinations must be accepted unchanged
    const existingFixtures: Array<{ bucket: string; objectKey: string }> = [
      { bucket: 'private-docs', objectKey: 'user-1/draft.pdf' },
      { bucket: 'private-docs', objectKey: 'user-1/leaking.pdf' },
      { bucket: 'private-docs', objectKey: 'user-1/present.pdf' },
      { bucket: 'private-docs', objectKey: 'user-1/done.pdf' },
      { bucket: 'private-docs', objectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/doc.pdf' },
      { bucket: 'studexo-documents', objectKey: '11111111-1111-4111-8111-111111111111/cv.pdf' },
      {
        bucket: 'studexo-documents',
        objectKey: '11111111-1111-4111-8111-111111111111/transcript.pdf',
      },
      {
        bucket: 'student-documents',
        objectKey: 'users/22222222-2222-4222-8222-222222222222/cv.pdf',
      },
      {
        bucket: 'student-documents',
        objectKey:
          'users/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf',
      },
    ];

    for (const fixture of existingFixtures) {
      await expect(adapter.removeObject(fixture.bucket, fixture.objectKey)).resolves.toBeUndefined();
      await expect(
        adapter.verifyObjectAbsent(fixture.bucket, fixture.objectKey),
      ).resolves.toBe(true);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(existingFixtures.length * 2);
  });

  it('9. redacts service-role keys, JWTs, signed URLs, and connection strings from error messages and bounds length to <= 256 chars (Req 18)', async () => {
    const noisyErrorMessage = [
      `Storage failure with key=${TEST_SERVICE_ROLE_KEY}`,
      `Authorization: Bearer ${TEST_JWT_SECRET}`,
      `signedUrl=https://studexo-storage-unit.supabase.co/storage/v1/object/sign/student-documents/users/u1/cv.pdf?token=secret_signed_token_12345`,
      `postgres://studexo_purge_worker:super_secret_db_pass@db.studexo.internal:5432/studexo`,
      'extra_padding_'.repeat(30),
    ].join(' | ');

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(500, {
          statusCode: '500',
          error: 'InternalError',
          message: noisyErrorMessage,
          code: 'InternalError',
        }),
    });

    let caughtError: SupabaseStorageError | null = null;
    try {
      await adapter.removeObject(VALID_BUCKET, VALID_OBJECT_KEY);
    } catch (err) {
      caughtError = err as SupabaseStorageError;
    }

    expect(caughtError).toBeInstanceOf(SupabaseStorageError);
    expect(caughtError!.code).toBe('STORAGE_PROVIDER_ERROR');
    expect(caughtError!.retryable).toBe(true);
    expect(caughtError!.message.length).toBeLessThanOrEqual(
      MAX_SANITIZED_STORAGE_ERROR_MESSAGE_LENGTH,
    );
    expect(caughtError!.message).not.toContain(TEST_SERVICE_ROLE_KEY);
    expect(caughtError!.message).not.toContain(TEST_JWT_SECRET);
    expect(caughtError!.message).not.toContain('secret_signed_token_12345');
    expect(caughtError!.message).not.toContain('super_secret_db_pass');
  });

  it('10. integrates cleanly with Stage 2 processPendingStoredFileDeletion, executeStorageFirstAccountPurge, and recoverInterruptedAccountPurge', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const objectExistsInStorage = new Set<string>([`${VALID_BUCKET}/${VALID_OBJECT_KEY}`]);
    let failNextVerifyWith503 = false;

    const adapter = createSupabaseStorageObjectAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';

        if (method === 'DELETE') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { prefixes: string[] };
          const deleted = [];
          for (const prefix of body.prefixes) {
            const coord = `${VALID_BUCKET}/${prefix}`;
            if (objectExistsInStorage.delete(coord)) {
              deleted.push(validRemoveEntry(VALID_BUCKET, prefix));
            }
          }
          return jsonResponse(200, deleted);
        }

        if (failNextVerifyWith503) {
          failNextVerifyWith503 = false;
          return jsonResponse(503, {
            statusCode: '503',
            error: 'ServiceUnavailable',
            message: `Temporary failure with secret ${TEST_SERVICE_ROLE_KEY}`,
          });
        }

        const coord = `${VALID_BUCKET}/${VALID_OBJECT_KEY}`;
        if ( url.endsWith(`/object/info/${coord}`) && objectExistsInStorage.has(coord) ) {
          return jsonResponse(200, validInfoPayload(VALID_BUCKET, VALID_OBJECT_KEY));
        }

        return jsonResponse(400, {
          statusCode: '404',
          error: 'not_found',
          message: 'Object not found',
          code: 'NoSuchKey',
        });
      },
    });

    let fileRecord: StoredFileLifecycleRecord = {
      id: fileId,
      ownerUserId: userId,
      storageBucket: VALID_BUCKET,
      objectKey: VALID_OBJECT_KEY,
      uploadStatus: 'uploaded',
      purgeState: 'pending_purge',
      deletedAt: null,
      deletedByUserId: userId,
      purgedAt: null,
      purgeAttempts: 0,
      purgeLeaseUntil: null,
      lastPurgeError: null,
    };

    const workerRepo: FilePurgeWorkerRepository = {
      getFileForPurge: async () => ({ ...fileRecord }),
      markFilePendingPurge: async () => {
        fileRecord = { ...fileRecord, purgeState: 'pending_purge' };
        return { ...fileRecord };
      },
      acquireFilePurgeLeaseIfUnreferenced: async (_id, _ownerId, leaseSeconds) => {
        fileRecord = {
          ...fileRecord,
          purgeState: 'purging',
          purgeAttempts: fileRecord.purgeAttempts + 1,
          purgeLeaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        };
        return { status: 'acquired', file: { ...fileRecord } };
      },
      acquireFilePurgeLease: async (_id, _ownerId, leaseSeconds) => {
        fileRecord = {
          ...fileRecord,
          purgeState: 'purging',
          purgeAttempts: fileRecord.purgeAttempts + 1,
          purgeLeaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        };
        return { ...fileRecord };
      },
      markFilePurged: async (_id, _ownerId, completedAt) => {
        fileRecord = {
          ...fileRecord,
          uploadStatus: 'deleted',
          purgeState: 'purged',
          deletedAt: completedAt ?? new Date(),
          purgedAt: completedAt ?? new Date(),
          purgeLeaseUntil: null,
        };
      },
      markFilePurgeFailed: async (_id, _ownerId, errorMessage) => {
        fileRecord = {
          ...fileRecord,
          purgeState: 'purge_failed',
          purgeLeaseUntil: null,
          lastPurgeError: errorMessage,
        };
      },
      revertPendingPurgeToNone: async () => {},
      listDueFilesForPurge: async () => [],
      listExpiredPurgeLeases: async () => [],
    };

    // 10a. First attempt: removeObject deletes the object, but verifyObjectAbsent hits a 503 error
    failNextVerifyWith503 = true;
    await expect(
      processPendingStoredFileDeletion({
        fileId,
        ownerUserId: userId,
        repo: workerRepo,
        storage: adapter,
      }),
    ).rejects.toMatchObject({
      code: 'STORAGE_PROVIDER_ERROR',
      retryable: true,
    });

    expect(fileRecord.purgeState).toBe('purge_failed');
    expect(fileRecord.lastPurgeError).not.toContain(TEST_SERVICE_ROLE_KEY);

    // 10b. Interrupted account purge recovery checks verifyObjectAbsent -> confirms object was already deleted
    const expiredNow = new Date('2026-11-17T12:00:00.000Z');
    const userRecord: UserLifecycleRecord = {
      id: userId,
      supabaseAuthUserId: '33333333-3333-4333-8333-333333333333',
      status: 'pending_deletion',
      purgeState: 'purging',
      deletionRequestedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletionScheduledFor: new Date('2026-10-15T00:00:00.000Z'),
      purgeLeaseOwner: 'worker-1',
      purgeLeaseUntil: new Date('2026-11-17T11:00:00.000Z'),
      purgeAttempts: 1,
      lastPurgeError: null,
    };

    const accountRepo: AccountPurgeRepository = {
      getUserForPurge: async () => ({ ...userRecord }),
      markUserPurging: async ({ leaseOwner, leaseUntil }) => ({
        ...userRecord,
        purgeState: 'purging',
        purgeLeaseOwner: leaseOwner,
        purgeLeaseUntil: leaseUntil ?? null,
        purgeAttempts: userRecord.purgeAttempts + 1,
      }),
      markUserPurgeFailed: async () => {},
      listUserStoredFiles: async () => [{ ...fileRecord }],
      executeAccountPurgeRpc: async () => {},
      listDueUsersForPurge: async () => [],
      listExpiredAccountPurges: async () => [],
    };

    const fileRecoveryRepo: FilePurgeLeaseRecoveryRepository = {
      markExpiredPurgeLeaseFailed: async () => ({ ...fileRecord }),
    };

    const accountRecoveryRepo: AccountPurgeLeaseRecoveryRepository = {
      markExpiredAccountPurgeLeaseFailed: async ({ errorMessage }) => ({
        ...userRecord,
        purgeState: 'purge_failed',
        purgeLeaseOwner: null,
        purgeLeaseUntil: null,
        lastPurgeError: errorMessage,
      }),
      findExternalIdentityOutboxByAuthUserId: async () => null,
    };

    const recoveryResult = await recoverInterruptedAccountPurge({
      userId,
      now: expiredNow,
      accountRepo,
      fileRecoveryRepo,
      recoveryRepo: accountRecoveryRepo,
      storage: adapter,
    });

    expect(recoveryResult.outcome).toBe('recovered_to_purge_failed');
    expect(recoveryResult.storageConfirmedAbsentFileIds).toEqual([fileId]);
    expect(recoveryResult.storageStillPresentFileIds).toEqual([]);

    // 10c. Retry Stage 2 file deletion: removeObject succeeds idempotently (data: []) and verifyObjectAbsent returns true
    const retryResult = await processPendingStoredFileDeletion({
      fileId,
      ownerUserId: userId,
      repo: workerRepo,
      storage: adapter,
    });
    expect(retryResult).toEqual({ fileId, outcome: 'purged' });
    expect(fileRecord.purgeState).toBe('purged');
    expect(fileRecord.uploadStatus).toBe('deleted');

    // 10d. Account purge with another unpurged file completes end-to-end
    fileRecord = {
      ...fileRecord,
      purgeState: 'none',
      uploadStatus: 'uploaded',
      deletedAt: null,
      purgedAt: null,
    };
    objectExistsInStorage.add(`${VALID_BUCKET}/${VALID_OBJECT_KEY}`);
    userRecord.purgeState = 'purge_failed';

    const accountPurgeResult = await executeStorageFirstAccountPurge({
      userId,
      now: expiredNow,
      accountRepo,
      fileRepo: workerRepo,
      storage: adapter,
    });

    expect(accountPurgeResult).toEqual({
      userId,
      purgedFileIds: [fileId],
      alreadyPurgedFileIds: [],
      databasePurgeExecuted: true,
    });
  });
});
