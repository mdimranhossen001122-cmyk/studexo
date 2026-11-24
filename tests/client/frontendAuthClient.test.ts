import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import App from '@/app/App';
import {
  buildUrlWithoutAuthParams,
  canRoleAccessRoute,
  classifyAuthFailure,
  getDefaultRouteForRole,
  maskSensitiveTokens,
  parseOAuthCallbackParams,
  sanitizeRedirectTarget,
} from '@/features/auth/authModel';
import {
  hydrateStudexoSession,
  SingleFlightHydrator,
} from '@/features/auth/hydrateSession';
import {
  ApiClientError,
  fetchCurrentUser,
  syncAuthSession,
} from '@/lib/apiClient';
import {
  readSupabaseClientConfig,
  SUPABASE_BROWSER_AUTH_OPTIONS,
} from '@/lib/supabaseClient';

describe('Phase 8B.5B Frontend Auth Configuration & PKCE Client', () => {
  it('reads only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and enforces PKCE options', () => {
    const valid = readSupabaseClientConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'public-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'must-never-be-used',
    });

    expect(valid).toEqual({
      configured: true,
      url: 'https://project.supabase.co',
      anonKey: 'public-anon-key-value',
    });
    expect(SUPABASE_BROWSER_AUTH_OPTIONS).toEqual({
      flowType: 'pkce',
      detectSessionInUrl: true,
      autoRefreshToken: true,
      persistSession: true,
    });
  });

  it('rejects missing config or insecure non-localhost HTTP Supabase URLs cleanly', () => {
    const missing = readSupabaseClientConfig({});
    expect(missing.configured).toBe(false);
    if (!missing.configured) {
      expect(missing.code).toBe('CLIENT_SUPABASE_NOT_CONFIGURED');
    }

    const insecureRemote = readSupabaseClientConfig({
      VITE_SUPABASE_URL: 'http://project.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
    });
    expect(insecureRemote.configured).toBe(false);

    const localHttp = readSupabaseClientConfig({
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
    });
    expect(localHttp.configured).toBe(true);
  });
});

describe('Phase 8B.5B API Client Auth Transport & Schema Validation', () => {
  it('rejects empty or whitespace-bearing access tokens locally without calling fetch', async () => {
    const fetcher = vi.fn();

    await expect(syncAuthSession('   ', {}, fetcher)).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
    });
    await expect(fetchCurrentUser('bad token', fetcher)).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends Bearer authorization and no-store cache to POST /api/auth/sync and validates response', async () => {
    const payload = {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        primaryEmail: 'amina@example.edu',
        displayName: 'Amina Rahman',
        role: 'student',
        status: 'active',
      },
      identities: [{ provider: 'google', emailVerified: true }],
      settings: {
        preferredLocale: 'en',
        preferredCurrency: 'USD',
        timezone: 'Asia/Dhaka',
        marketingOptIn: false,
      },
    };

    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await syncAuthSession(
      'header.payload.signature',
      { timezone: 'Asia/Dhaka' },
      fetcher as unknown as typeof fetch,
    );

    expect(result).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/auth/sync');
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer header.payload.signature',
      'Content-Type': 'application/json',
    });
  });

  it('parses structured ApiErrorPayload and requestId on backend auth failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'AUTH_IDENTITY_COLLISION',
            message: 'Email already bound to another identity.',
            requestId: 'req-collision-99',
          },
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      syncAuthSession('valid.jwt.token', {}, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 409,
      code: 'AUTH_IDENTITY_COLLISION',
      requestId: 'req-collision-99',
    });
  });

  it('hydrates GET /api/auth/me with strict schema parsing', async () => {
    const mePayload = {
      user: {
        id: '22222222-2222-4222-8222-222222222222',
        primaryEmail: 'counselor@studexo.org',
        displayName: 'Tariq Hasan',
        role: 'counselor',
        status: 'active',
      },
    };

    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchCurrentUser(
      'header.payload.signature',
      fetcher as unknown as typeof fetch,
    );
    expect(result).toEqual(mePayload);
  });
});

describe('Phase 8B.5B OAuth Callback Parsing, URL Scrubbing, Redirects & Error Classification', () => {
  it('parses PKCE codes and OAuth errors cleanly and scrubs auth params while preserving next', () => {
    const withCode = parseOAuthCallbackParams('?code=pkce-code-123&next=%2Fstudent', '');
    expect(withCode).toEqual({ code: 'pkce-code-123', oauthError: null });

    const withHashError = parseOAuthCallbackParams(
      '?next=%2Fcounselor',
      '#error=access_denied&error_description=User+cancelled+login',
    );
    expect(withHashError).toEqual({
      code: null,
      oauthError: {
        code: 'access_denied',
        description: 'User cancelled login',
      },
    });

    const scrubbed = buildUrlWithoutAuthParams(
      '/auth/callback',
      '?code=pkce-code-123&state=xyz&next=%2Fstudent',
      '#access_token=secret&foo=bar',
    );
    expect(scrubbed).toBe('/auth/callback?next=%2Fstudent#foo=bar');
  });

  it('blocks open redirects and allows only internal relative routes', () => {
    expect(sanitizeRedirectTarget('/student')).toBe('/student');
    expect(sanitizeRedirectTarget('/counselor?tab=overview')).toBe('/counselor?tab=overview');
    expect(sanitizeRedirectTarget('https://evil.example/phish')).toBeNull();
    expect(sanitizeRedirectTarget('//evil.example')).toBeNull();
    expect(sanitizeRedirectTarget('/\\evil.example')).toBeNull();
    expect(sanitizeRedirectTarget('/auth/callback')).toBeNull();
    expect(sanitizeRedirectTarget('/login')).toBeNull();
  });

  it('redacts accidental JWT or Bearer strings in masked messages', () => {
    const masked = maskSensitiveTokens(
      'Failed calling endpoint with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig123',
    );
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(masked).toContain('Bearer [REDACTED]');
  });

  it('classifies unverified email, suspension, pending deletion, purge lock, collision, and outage errors accurately', () => {
    const unverified = classifyAuthFailure(
      new ApiClientError({
        status: 403,
        code: 'AUTH_EMAIL_NOT_VERIFIED',
        message: 'Email not verified',
      }),
      { email: 'student@example.edu' },
    );
    expect(unverified.category).toBe('unverified_email');
    expect(unverified.recoveryActions).toContain('resend_verification');

    const suspended = classifyAuthFailure(
      new ApiClientError({
        status: 403,
        code: 'AUTH_USER_SUSPENDED',
        message: 'Suspended',
      }),
    );
    expect(suspended.category).toBe('account_suspended');
    expect(suspended.recoveryActions).toEqual(['sign_out']);

    const pendingDeletion = classifyAuthFailure(
      new ApiClientError({
        status: 403,
        code: 'AUTH_USER_PENDING_DELETION',
        message: 'Pending deletion',
      }),
    );
    expect(pendingDeletion.category).toBe('pending_deletion');

    const purge = classifyAuthFailure(
      new ApiClientError({
        status: 403,
        code: 'AUTH_PURGE_IN_PROGRESS',
        message: 'Purge active',
      }),
    );
    expect(purge.category).toBe('purge_in_progress');

    const collision = classifyAuthFailure(
      new ApiClientError({
        status: 409,
        code: 'AUTH_IDENTITY_COLLISION',
        message: 'Collision',
      }),
    );
    expect(collision.category).toBe('identity_collision');
    expect(collision.guidance).toMatch(/never merges providers automatically by email/i);
    expect(collision.recoveryActions).toEqual(['sign_out']);

    const networkOutage = classifyAuthFailure(new TypeError('Failed to fetch'));
    expect(networkOutage.category).toBe('service_unavailable');
    expect(networkOutage.recoveryActions).toContain('retry_sync');
  });

  it('enforces role route isolation for student, counselor, and admin', () => {
    expect(getDefaultRouteForRole('student')).toBe('/student');
    expect(getDefaultRouteForRole('counselor')).toBe('/counselor');
    expect(getDefaultRouteForRole('admin')).toBe('/admin');

    expect(canRoleAccessRoute('student', '/student')).toBe(true);
    expect(canRoleAccessRoute('student', '/counselor')).toBe(false);
    expect(canRoleAccessRoute('student', '/admin')).toBe(false);
    expect(canRoleAccessRoute('counselor', '/counselor')).toBe(true);
    expect(canRoleAccessRoute('counselor', '/admin')).toBe(false);
    expect(canRoleAccessRoute('admin', '/admin')).toBe(true);
    expect(canRoleAccessRoute('admin', '/workspace')).toBe(true);
  });
});

describe('Phase 8B.5B Session Hydration Coordinator & Single-Flight Deduplication', () => {
  const sampleUser = {
    id: '33333333-3333-4333-8333-333333333333',
    primaryEmail: 'student@studexo.org',
    displayName: 'Nadia Islam',
    role: 'student' as const,
    status: 'active' as const,
  };

  it('falls back from 404 AUTH_IDENTITY_NOT_FOUND on /api/auth/me to POST /api/auth/sync once', async () => {
    const fetchMe = vi.fn().mockRejectedValue(
      new ApiClientError({
        status: 404,
        code: 'AUTH_IDENTITY_NOT_FOUND',
        message: 'User not provisioned yet',
      }),
    );
    const syncSession = vi.fn().mockResolvedValue({
      user: sampleUser,
      identities: [{ provider: 'google', emailVerified: true }],
      settings: null,
    });
    const refreshSession = vi.fn();
    const signOutLocal = vi.fn();

    const outcome = await hydrateStudexoSession(
      { access_token: 'access-1', user: { email: sampleUser.primaryEmail } },
      { mode: 'hydrate' },
      { fetchMe, syncSession, refreshSession, signOutLocal },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.hydratedVia).toBe('sync');
      expect(outcome.data.user).toEqual(sampleUser);
    }
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(signOutLocal).not.toHaveBeenCalled();
  });

  it('recovers from 401 AUTH_TOKEN_EXPIRED via single refreshSession retry', async () => {
    const fetchMe = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError({
          status: 401,
          code: 'AUTH_TOKEN_EXPIRED',
          message: 'Expired token',
        }),
      )
      .mockResolvedValueOnce({ user: sampleUser });
    const refreshSession = vi.fn().mockResolvedValue({
      access_token: 'fresh-access-2',
      user: { email: sampleUser.primaryEmail },
    });
    const signOutLocal = vi.fn();

    const outcome = await hydrateStudexoSession(
      { access_token: 'expired-access-1', user: { email: sampleUser.primaryEmail } },
      { mode: 'hydrate' },
      { fetchMe, syncSession: vi.fn(), refreshSession, signOutLocal },
    );

    expect(outcome.ok).toBe(true);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenNthCalledWith(1, 'expired-access-1');
    expect(fetchMe).toHaveBeenNthCalledWith(2, 'fresh-access-2');
    expect(signOutLocal).not.toHaveBeenCalled();
  });

  it('clears local session cleanly when refresh fails after 401', async () => {
    const fetchMe = vi.fn().mockRejectedValue(
      new ApiClientError({
        status: 401,
        code: 'AUTH_TOKEN_EXPIRED',
        message: 'Expired token',
      }),
    );
    const refreshSession = vi.fn().mockResolvedValue(null);
    const signOutLocal = vi.fn().mockResolvedValue(undefined);

    const outcome = await hydrateStudexoSession(
      { access_token: 'expired-access-1', user: { email: sampleUser.primaryEmail } },
      { mode: 'hydrate' },
      { fetchMe, syncSession: vi.fn(), refreshSession, signOutLocal },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.sessionCleared).toBe(true);
      expect(outcome.failure.category).toBe('session_expired');
    }
    expect(signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('does not clear or retry on 403 purge lock and returns explicit purge_in_progress failure', async () => {
    const syncSession = vi.fn().mockRejectedValue(
      new ApiClientError({
        status: 403,
        code: 'AUTH_PURGE_IN_PROGRESS',
        message: 'Purge active',
      }),
    );
    const refreshSession = vi.fn();
    const signOutLocal = vi.fn();

    const outcome = await hydrateStudexoSession(
      { access_token: 'access-1', user: { email: sampleUser.primaryEmail } },
      { mode: 'sync' },
      { fetchMe: vi.fn(), syncSession, refreshSession, signOutLocal },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.sessionCleared).toBe(false);
      expect(outcome.failure.category).toBe('purge_in_progress');
    }
    expect(refreshSession).not.toHaveBeenCalled();
    expect(signOutLocal).not.toHaveBeenCalled();
  });

  it('deduplicates overlapping concurrent hydration calls via SingleFlightHydrator', async () => {
    const coordinator = new SingleFlightHydrator();
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true as const,
        data: {
          user: sampleUser,
          identities: null,
          settings: null,
          hydratedVia: 'me' as const,
        },
      };
    });

    const [a, b] = await Promise.all([
      coordinator.run('hydrate:tok-1', work),
      coordinator.run('hydrate:tok-1', work),
    ]);

    expect(work).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe('Phase 8B.5B React App SSR / Initial Render Smoke Test', () => {
  it('renders Studexo overview shell cleanly without leaking secrets or failing on server render', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Studexo');
    expect(html).toContain('Global Higher-Education Admissions &amp; Guidance');
    expect(html).not.toContain('SERVICE_ROLE');
  });
});
