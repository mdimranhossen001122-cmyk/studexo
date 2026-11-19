import { describe, expect, it, vi } from 'vitest';
import {
  executeExternalIdentityOutboxPurge,
  processExternalIdentityPurgeOutboxItem,
  recoverExpiredExternalIdentityOutboxLease,
  type ExternalIdentityOutboxRecord,
  type ExternalIdentityOutboxRecoveryRepository,
  type ExternalIdentityOutboxRepository,
} from '../src/server/modules/lifecycle/storageAndPurge';
import {
  createSupabaseAuthAdminAdapter,
  DEFAULT_AUTH_ADMIN_REQUEST_TIMEOUT_MS,
  MAX_AUTH_ADMIN_ERROR_MESSAGE_LENGTH,
  MAX_AUTH_ADMIN_REQUEST_TIMEOUT_MS,
  SupabaseAuthAdminError,
} from '../src/server/modules/lifecycle/supabaseAuthAdminAdapter';

const TEST_SUPABASE_URL = 'https://studexo-unit-test.example.com';
const TEST_SERVICE_ROLE_KEY = 'sb_secret_test_service_role_key_999999';
const TEST_USER_ID = '715ed5db-f090-4b8c-a067-640ecee36aa0';

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Supabase-Api-Version': '2024-01-01',
      ...extraHeaders,
    },
  });
}

function textResponse(
  status: number,
  body: string,
  contentType: string = 'text/html',
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'X-Supabase-Api-Version': '2024-01-01',
    },
  });
}

describe('Phase 8B.4C.3 — SupabaseAuthAdminAdapter offline unit & contract suite', () => {
  it('1. validates configuration fail-closed (URL scheme, HTTPS in production, service-role key, timeout bounds, and narrow adapter surface)', () => {
    // Missing or blank URL
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: '',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'SupabaseAuthAdminError',
        code: 'AUTH_ADMIN_CONFIG_INVALID',
      }),
    );

    // Malformed URL
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: 'not-a-valid-url',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_ADMIN_CONFIG_INVALID',
      }),
    );

    // Non-HTTP/HTTPS scheme rejected
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: 'postgresql://localhost:5432/studexo',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_ADMIN_CONFIG_INVALID',
      }),
    );

    // HTTP rejected when isProduction: true
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: 'http://localhost:54321',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        isProduction: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_ADMIN_CONFIG_INVALID',
        message: expect.stringContaining('https: in production'),
      }),
    );

    // Embedded URL credentials rejected
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: 'https://user:pass@studexo-unit-test.example.com',
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_ADMIN_CONFIG_INVALID',
      }),
    );

    // Missing or whitespace serviceRoleKey rejected
    expect(() =>
      createSupabaseAuthAdminAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: '   ',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AUTH_ADMIN_CONFIG_INVALID',
      }),
    );

    // Invalid requestTimeoutMs rejected
    for (const invalidTimeout of [
      0,
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_AUTH_ADMIN_REQUEST_TIMEOUT_MS + 1,
    ]) {
      expect(() =>
        createSupabaseAuthAdminAdapter({
          supabaseUrl: TEST_SUPABASE_URL,
          serviceRoleKey: TEST_SERVICE_ROLE_KEY,
          requestTimeoutMs: invalidTimeout,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'AUTH_ADMIN_CONFIG_INVALID',
        }),
      );
    }

    // HTTP allowed when isProduction: false, and returned adapter exposes ONLY deleteUserById
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    const adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: 'http://127.0.0.1:54321',
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      isProduction: false,
      fetch: fetchSpy,
    });

    expect(Object.keys(adapter)).toEqual(['deleteUserById']);
    expect(Object.isFrozen(adapter)).toBe(true);
    const rawAdapter = adapter as unknown as Record<string, unknown>;
    expect(rawAdapter.from).toBeUndefined();
    expect(rawAdapter.rpc).toBeUndefined();
    expect(rawAdapter.schema).toBeUndefined();
    expect(rawAdapter.storage).toBeUndefined();
    expect(rawAdapter.auth).toBeUndefined();
    // Constructing the adapter with autoRefreshToken:false, persistSession:false, detectSessionInUrl:false
    // must not trigger any background HTTP requests on construction
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(DEFAULT_AUTH_ADMIN_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('2. executes GET + hard DELETE (should_soft_delete: false) and resolves { status: "deleted" } with case-insensitive UUID match', async () => {
    const calls: Array<{
      url: string;
      method: string;
      body: string | null;
      hasSignal: boolean;
    }> = [];

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : null;
      calls.push({
        url,
        method,
        body,
        hasSignal: init?.signal instanceof AbortSignal,
      });

      if (method === 'GET') {
        return jsonResponse(200, {
          id: TEST_USER_ID.toUpperCase(),
          aud: 'authenticated',
          role: 'authenticated',
          email: 'student@example.com',
        });
      }

      if (method === 'DELETE') {
        return jsonResponse(200, {});
      }

      throw new Error(`Unexpected method: ${method}`);
    };

    const adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      isProduction: true,
      fetch: mockFetch,
    });

    const result = await adapter.deleteUserById(`  ${TEST_USER_ID}  `);
    expect(result).toEqual({ status: 'deleted' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: `${TEST_SUPABASE_URL}/auth/v1/admin/users/${TEST_USER_ID}`,
      method: 'GET',
      body: null,
      hasSignal: true,
    });
    expect(calls[1]).toEqual({
      url: `${TEST_SUPABASE_URL}/auth/v1/admin/users/${TEST_USER_ID}`,
      method: 'DELETE',
      body: JSON.stringify({ should_soft_delete: false }),
      hasSignal: true,
    });

    // Also verify via injected authAdminClient seam that shouldSoftDelete=false is explicitly passed
    const deleteUserSpy = vi.fn(async (id: string, shouldSoftDelete?: boolean) => ({
      data: { user: { id } },
      error: null,
      shouldSoftDelete,
    }));
    const seamAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      authAdminClient: { deleteUser: deleteUserSpy },
    });
    await expect(seamAdapter.deleteUserById(TEST_USER_ID)).resolves.toEqual({
      status: 'deleted',
    });
    expect(deleteUserSpy).toHaveBeenCalledWith(TEST_USER_ID, false);
  });

  it('3. resolves { status: "already_absent" } on confirmed AuthApiError 404 + code="user_not_found" for both GET and DELETE race', async () => {
    // Case A: GET returns 404 with code: 'user_not_found' -> DELETE is never called
    const get404Calls: string[] = [];
    const get404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (_input, init) => {
        get404Calls.push(init?.method ?? 'GET');
        return jsonResponse(404, {
          code: 'user_not_found',
          message: 'User not found',
        });
      },
    });

    await expect(get404Adapter.deleteUserById(TEST_USER_ID)).resolves.toEqual({
      status: 'already_absent',
    });
    expect(get404Calls).toEqual(['GET']);

    // Case B: GET returns 200, then concurrent deletion causes DELETE to return 404 with code: 'user_not_found'
    const delete404Calls: string[] = [];
    const delete404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (_input, init) => {
        const method = init?.method ?? 'GET';
        delete404Calls.push(method);
        if (method === 'GET') {
          return jsonResponse(200, { id: TEST_USER_ID });
        }
        return jsonResponse(404, {
          code: 'user_not_found',
          message: 'User not found during delete',
        });
      },
    });

    await expect(delete404Adapter.deleteUserById(TEST_USER_ID)).resolves.toEqual({
      status: 'already_absent',
    });
    expect(delete404Calls).toEqual(['GET', 'DELETE']);
  });

  it('4. rejects unconfirmed 404 responses (missing code, wrong code, non-AuthApiError 404, or HTML 404) without falsely returning already_absent', async () => {
    // 4a. JSON 404 with no error code (e.g. Kong/proxy route 404)
    const route404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(404, {
          message: 'no Route matched with those values',
        }),
    });

    await expect(route404Adapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_UNCONFIRMED_404',
      status: 404,
      retryable: false,
    });

    // 4b. JSON 404 with a different code (not 'user_not_found')
    const wrongCode404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(404, {
          code: 'sso_provider_not_found',
          message: 'Provider not found',
        }),
    });

    await expect(
      wrongCode404Adapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_UNCONFIRMED_404',
      status: 404,
      providerCode: 'sso_provider_not_found',
      retryable: false,
    });

    // 4c. Plain object with status=404 and code='user_not_found' that is NOT a confirmed AuthApiError instance
    const plainObject404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      authAdminClient: {
        deleteUser: async () => ({
          data: { user: null },
          error: { status: 404, code: 'user_not_found', message: 'spoofed plain obj' },
        }),
      },
    });

    await expect(
      plainObject404Adapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_UNCONFIRMED_404',
      status: 404,
      retryable: false,
    });

    // 4d. HTML 404 from upstream proxy / CDN -> AuthUnknownError -> AUTH_PROVIDER_MALFORMED_RESPONSE
    const html404Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => textResponse(404, '<html><body>404 Not Found</body></html>'),
    });

    await expect(html404Adapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      retryable: true,
    });
  });

  it('5. classifies 401, 403, 429, 500/502/503/504, and permanent 4xx errors with deterministic non-empty codes', async () => {
    // 401 Unauthorized
    const unauthorizedAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(401, {
          code: 'no_authorization',
          message: 'This endpoint requires a valid Bearer token',
        }),
    });
    await expect(
      unauthorizedAdapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_UNAUTHORIZED',
      status: 401,
      providerCode: 'no_authorization',
      retryable: false,
    });

    // 403 Forbidden
    const forbiddenAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(403, {
          code: 'not_admin',
          message: 'User not allowed',
        }),
    });
    await expect(forbiddenAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_FORBIDDEN',
      status: 403,
      providerCode: 'not_admin',
      retryable: false,
    });

    // 429 Rate Limit (both with and without provider code)
    for (const body of [
      { code: 'over_request_rate_limit', message: 'Rate limit exceeded' },
      { message: 'Too Many Requests from Gateway' },
    ]) {
      const rateLimitAdapter = createSupabaseAuthAdminAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        fetch: async () => jsonResponse(429, body),
      });
      await expect(
        rateLimitAdapter.deleteUserById(TEST_USER_ID),
      ).rejects.toMatchObject({
        name: 'SupabaseAuthAdminError',
        code: 'AUTH_PROVIDER_RATE_LIMITED',
        status: 429,
        retryable: true,
      });
    }

    // 500, 502, 503, 504 (JSON and non-JSON gateway bodies)
    for (const status of [500, 502, 503, 504]) {
      const json5xxAdapter = createSupabaseAuthAdminAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        fetch: async () =>
          jsonResponse(status, {
            code: 'unexpected_failure',
            message: `Upstream failure ${status}`,
          }),
      });
      await expect(json5xxAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
        name: 'SupabaseAuthAdminError',
        code: 'AUTH_PROVIDER_5XX',
        status,
        retryable: true,
      });

      const html5xxAdapter = createSupabaseAuthAdminAdapter({
        supabaseUrl: TEST_SUPABASE_URL,
        serviceRoleKey: TEST_SERVICE_ROLE_KEY,
        fetch: async () => textResponse(status, `<html>${status} Bad Gateway</html>`),
      });
      await expect(html5xxAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
        name: 'SupabaseAuthAdminError',
        code: 'AUTH_PROVIDER_5XX',
        status,
        retryable: true,
      });
    }

    // Permanent 4xx (400 / 422 with and without provider error code)
    const validation422Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(422, {
          code: 'validation_failed',
          message: 'Unable to validate user deletion request',
        }),
    });
    await expect(
      validation422Adapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'validation_failed',
      status: 422,
      retryable: false,
    });

    const codeless400Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(400, {
          code: '   ',
          message: 'Bad request without code',
        }),
    });
    await expect(codeless400Adapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject(
      {
        name: 'SupabaseAuthAdminError',
        code: 'AUTH_PROVIDER_4XX',
        status: 400,
        retryable: false,
      },
    );
  });

  it('6. distinguishes network failures (AUTH_PROVIDER_NETWORK_ERROR) from per-request timeouts and aborts (AUTH_PROVIDER_TIMEOUT)', async () => {
    // 6a. Ordinary network failure (DNS/socket rejection) -> AUTH_PROVIDER_NETWORK_ERROR
    const networkAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => {
        throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:54321');
      },
    });

    await expect(networkAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_NETWORK_ERROR',
      retryable: true,
    });

    // 6b. Timeout on GET -> AUTH_PROVIDER_TIMEOUT
    const timeoutGetAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      requestTimeoutMs: 40,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const abortErr = new Error('The operation was aborted.');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true },
          );
        }),
    });

    await expect(timeoutGetAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_TIMEOUT',
      retryable: true,
      message: expect.stringContaining('timed out after 40ms'),
    });

    // 6c. Independent timeout budget applied to BOTH GET and DELETE requests:
    // With requestTimeoutMs = 60, a 35ms GET + 35ms DELETE (70ms total) succeeds because each
    // individual request receives its own fresh 60ms timeout signal.
    const seenSignals: AbortSignal[] = [];
    const independentBudgetAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      requestTimeoutMs: 60,
      fetch: async (_input, init) => {
        if (init?.signal) {
          seenSignals.push(init.signal);
        }
        await new Promise((resolve) => setTimeout(resolve, 35));
        if (init?.signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse(200, { id: TEST_USER_ID });
        }
        return jsonResponse(200, {});
      },
    });

    await expect(
      independentBudgetAdapter.deleteUserById(TEST_USER_ID),
    ).resolves.toEqual({
      status: 'deleted',
    });
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).not.toBe(seenSignals[1]);

    // 6d. Fast GET (5ms) followed by hung DELETE (exceeding 40ms) -> times out on DELETE with AUTH_PROVIDER_TIMEOUT
    let step = 0;
    const timeoutDeleteAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      requestTimeoutMs: 40,
      fetch: async (_input, init) => {
        step += 1;
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse(200, { id: TEST_USER_ID });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const abortErr = new Error('DELETE aborted due to timeout');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true },
          );
        });
      },
    });

    await expect(
      timeoutDeleteAdapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_TIMEOUT',
      retryable: true,
    });
    expect(step).toBe(2);
  });

  it('7. rejects invalid UUID before making any network request and rejects malformed 2xx / non-JSON responses', async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    const adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: fetchSpy,
    });

    for (const badId of ['', '   ', 'not-a-uuid', '715ed5db-f090-4b8c-a067-640ecee36aaZ']) {
      await expect(adapter.deleteUserById(badId)).rejects.toMatchObject({
        name: 'SupabaseAuthAdminError',
        code: 'INVALID_SUPABASE_AUTH_USER_ID',
        retryable: false,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // Malformed 200 non-JSON response on GET
    const nonJson200Adapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () => textResponse(200, 'not-valid-json'),
    });
    await expect(nonJson200Adapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      retryable: true,
    });

    // Malformed 200 JSON missing user id
    const missingIdAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse(200, { user: {} });
        }
        return jsonResponse(200, {});
      },
    });
    await expect(missingIdAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      retryable: true,
    });

    // Malformed 200 JSON with mismatched user id
    const mismatchedIdAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse(200, {
            user: { id: '00000000-0000-4000-8000-000000000000' },
          });
        }
        return jsonResponse(200, {});
      },
    });
    await expect(
      mismatchedIdAdapter.deleteUserById(TEST_USER_ID),
    ).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      retryable: true,
    });

    // Null / missing user object from injected client seam
    const nullUserAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      authAdminClient: {
        deleteUser: async () => ({ data: { user: null }, error: null }),
      },
    });
    await expect(nullUserAdapter.deleteUserById(TEST_USER_ID)).rejects.toMatchObject({
      name: 'SupabaseAuthAdminError',
      code: 'AUTH_PROVIDER_MALFORMED_RESPONSE',
      retryable: true,
    });
  });

  it('8. sanitizes secrets/tokens and bounds error message length on thrown SupabaseAuthAdminError', async () => {
    const rawJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const rawBearer = 'Bearer super_secret_bearer_token_value_123';
    const oversizedTail = 'X'.repeat(500);

    const leakyAdapter = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async () =>
        jsonResponse(500, {
          code: 'unexpected_failure',
          message: `Auth failed with key=${TEST_SERVICE_ROLE_KEY} and ${rawBearer} and jwt=${rawJwt} and apikey=SECRET_QUERY_KEY and https://proj.supabase.co/auth/v1/admin?apikey=URL_API_KEY ${oversizedTail}`,
        }),
    });

    let caughtError: SupabaseAuthAdminError | null = null;
    try {
      await leakyAdapter.deleteUserById(TEST_USER_ID);
    } catch (err) {
      caughtError = err as SupabaseAuthAdminError;
    }

    expect(caughtError).toBeInstanceOf(SupabaseAuthAdminError);
    expect(caughtError?.code).toBe('AUTH_PROVIDER_5XX');
    expect(caughtError?.message.length).toBeLessThanOrEqual(
      MAX_AUTH_ADMIN_ERROR_MESSAGE_LENGTH,
    );
    expect(caughtError?.message.endsWith('...')).toBe(true);
    expect(caughtError?.message).not.toContain(TEST_SERVICE_ROLE_KEY);
    expect(caughtError?.message).not.toContain('super_secret_bearer_token_value_123');
    expect(caughtError?.message).not.toContain(rawJwt);
    expect(caughtError?.message).not.toContain('SECRET_QUERY_KEY');
    expect(caughtError?.message).not.toContain('URL_API_KEY');
  });

  it('9. integrates cleanly with executeExternalIdentityOutboxPurge and processExternalIdentityPurgeOutboxItem across retry and exhausted-attempt reconciliation', async () => {
    let now = new Date('2026-11-17T12:00:00.000Z');
    const state: ExternalIdentityOutboxRecord = {
      id: 'outbox-integration-1',
      formerUserId: '11111111-1111-4111-8111-111111111111',
      supabaseAuthUserId: TEST_USER_ID,
      status: 'pending_purge',
      attemptCount: 9,
      maxAttempts: 10,
      nextAttemptAt: now,
      leaseOwner: null,
      lockedUntil: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: null,
    };

    let failMarkPurgedOnce = true;

    const repo: ExternalIdentityOutboxRepository &
      ExternalIdentityOutboxRecoveryRepository = {
      getOutboxItemById: async (outboxId) =>
        outboxId === state.id ? { ...state } : null,
      listDueExhaustedOutboxItems: async () => [],
      acquireOutboxLease: async ({
        outboxId,
        leaseOwner,
        leaseSeconds,
        allowExhaustedReconciliation,
      }) => {
        if (outboxId !== state.id) {
          return { status: 'unavailable', reason: 'not_found', item: null };
        }
        if (state.status === 'purged') {
          return {
            status: 'unavailable',
            reason: 'already_purged',
            item: { ...state },
          };
        }
        const isReconcile =
          Boolean(allowExhaustedReconciliation) &&
          state.status === 'purge_failed' &&
          state.attemptCount === state.maxAttempts;
        if (!isReconcile && state.attemptCount >= state.maxAttempts) {
          return {
            status: 'unavailable',
            reason: 'max_attempts_exhausted',
            item: { ...state },
          };
        }
        state.status = 'purging';
        if (!isReconcile) {
          state.attemptCount += 1;
        }
        state.leaseOwner = `${leaseOwner}:token-${state.attemptCount}-${isReconcile ? 'rec' : 'norm'}`;
        state.lockedUntil = new Date(now.getTime() + leaseSeconds * 1000);
        return {
          status: 'acquired',
          mode: isReconcile ? 'reconciliation' : 'normal',
          item: { ...state },
        };
      },
      claimDueOutboxItems: async () => [],
      markOutboxPurged: async ({ fencing }) => {
        if (failMarkPurgedOnce) {
          failMarkPurgedOnce = false;
          throw new Error('Transient DB drop after Supabase deleted user');
        }
        if (
          state.status !== 'purging' ||
          state.leaseOwner !== fencing.expectedLeaseOwner ||
          state.attemptCount !== fencing.expectedAttemptCount ||
          !state.lockedUntil ||
          state.lockedUntil.getTime() <= now.getTime()
        ) {
          return { status: 'stale_lease', item: { ...state } };
        }
        state.status = 'purged';
        state.leaseOwner = null;
        state.lockedUntil = null;
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.completedAt = now;
        return { status: 'updated', item: { ...state } };
      },
      markOutboxPurgeFailed: async ({
        retryDelaySeconds,
        errorCode,
        errorMessage,
        fencing,
      }) => {
        if (
          state.status !== 'purging' ||
          state.leaseOwner !== fencing.expectedLeaseOwner ||
          state.attemptCount !== fencing.expectedAttemptCount ||
          !state.lockedUntil ||
          state.lockedUntil.getTime() <= now.getTime()
        ) {
          return { status: 'stale_lease', item: { ...state } };
        }
        state.status = 'purge_failed';
        state.leaseOwner = null;
        state.lockedUntil = null;
        state.lastErrorCode = errorCode ?? 'OUTBOX_PURGE_FAILED';
        state.lastErrorMessage = errorMessage;
        state.nextAttemptAt = new Date(now.getTime() + retryDelaySeconds * 1000);
        return { status: 'updated', item: { ...state } };
      },
      markExpiredOutboxLeaseFailed: async ({
        expectedLeaseOwner,
        expectedAttemptCount,
        retryDelaySeconds,
        errorCode,
        errorMessage,
      }) => {
        if (
          state.status !== 'purging' ||
          state.leaseOwner !== expectedLeaseOwner ||
          state.attemptCount !== expectedAttemptCount ||
          (state.lockedUntil && state.lockedUntil.getTime() > now.getTime())
        ) {
          return { status: 'stale_lease', item: { ...state } };
        }
        state.status = 'purge_failed';
        state.leaseOwner = null;
        state.lockedUntil = null;
        state.lastErrorCode = errorCode ?? 'LEASE_EXPIRED';
        state.lastErrorMessage = errorMessage;
        state.nextAttemptAt = new Date(now.getTime() + retryDelaySeconds * 1000);
        return { status: 'updated', item: { ...state } };
      },
    };

    // Simulated GoTrue state: user exists initially, is deleted on first DELETE call, and returns 404 user_not_found thereafter
    let userExistsInGoTrue = true;
    const authAdmin = createSupabaseAuthAdminAdapter({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
      fetch: async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (!userExistsInGoTrue) {
          return jsonResponse(404, {
            code: 'user_not_found',
            message: 'User not found',
          });
        }
        if (method === 'GET') {
          return jsonResponse(200, { id: TEST_USER_ID });
        }
        if (method === 'DELETE') {
          userExistsInGoTrue = false;
          return jsonResponse(200, {});
        }
        throw new Error(`Unexpected method ${method}`);
      },
    });

    // Step 1: Attempt 10/10 deletes user in GoTrue, but DB markOutboxPurged drops connection
    await expect(
      executeExternalIdentityOutboxPurge({
        outboxId: state.id,
        leaseOwner: 'worker-1',
        leaseSeconds: 60,
        retryDelaySeconds: 30,
        repo,
        authAdmin,
      }),
    ).rejects.toThrow('Transient DB drop after Supabase deleted user');
    expect(userExistsInGoTrue).toBe(false);
    expect(state.status).toBe('purging');
    expect(state.attemptCount).toBe(10);

    // Step 2: Lease expires and recovery transitions row to purge_failed at attempt 10/10
    now = new Date(now.getTime() + 65_000);
    const recovered = await recoverExpiredExternalIdentityOutboxLease({
      outboxId: state.id,
      now,
      retryDelaySeconds: 30,
      repo,
    });
    expect(recovered.outcome).toBe('recovered_to_purge_failed');
    expect(state.status).toBe('purge_failed');
    expect(state.attemptCount).toBe(10);

    // Step 3: Reconciliation claim calls real adapter -> GoTrue returns 404 user_not_found -> adapter returns already_absent -> outbox marked purged
    now = new Date(now.getTime() + 35_000);
    const reconciled = await executeExternalIdentityOutboxPurge({
      outboxId: state.id,
      leaseOwner: 'worker-1',
      leaseSeconds: 60,
      retryDelaySeconds: 30,
      allowExhaustedReconciliation: true,
      repo,
      authAdmin,
    });

    expect(reconciled).toMatchObject({
      outboxId: state.id,
      outcome: 'purged',
      mode: 'reconciliation',
      providerStatus: 'already_absent',
    });
    expect(state.status).toBe('purged');
    expect(state.completedAt).toEqual(now);

    // Step 4: Legacy helper processExternalIdentityPurgeOutboxItem also works with the concrete adapter
    const helperRes = await processExternalIdentityPurgeOutboxItem(
      {
        id: 'legacy-item',
        formerUserId: state.formerUserId,
        supabaseAuthUserId: TEST_USER_ID,
        status: 'pending_purge',
        attemptCount: 0,
        maxAttempts: 10,
      },
      authAdmin,
    );
    expect(helperRes).toEqual({ status: 'purged' });
  });
});
