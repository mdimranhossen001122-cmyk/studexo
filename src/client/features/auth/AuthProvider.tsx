import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AuthContext,
  type AuthActionResult,
  type AuthContextValue,
  type AuthSessionStatus,
  type SignUpWithEmailInput,
} from '@/features/auth/authContext';
import {
  APP_ROUTES,
  buildUrlWithoutAuthParams,
  classifyAuthFailure,
  parseOAuthCallbackParams,
  sanitizeRedirectTarget,
  type AuthUiFailure,
} from '@/features/auth/authModel';
import {
  hydrateStudexoSession,
  SingleFlightHydrator,
  type HydrateSessionOutcome,
} from '@/features/auth/hydrateSession';
import { getSupabaseClient } from '@/lib/supabaseClient';
import type {
  AuthAccountSettingsDto,
  AuthPublicIdentity,
  AuthPublicUser,
  AuthSyncRequest,
} from '@shared/schemas/auth.schema';

interface AuthProviderProps {
  children: ReactNode;
}

function getBrowserTimezonePreference(): AuthSyncRequest | undefined {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone && /^[A-Za-z0-9_/+.-]{1,64}$/.test(timezone)) {
      return { timezone };
    }
  } catch {
    // Ignore unsupported Intl environments
  }
  return undefined;
}

function buildOAuthRedirectUrl(nextPath?: string | null): string {
  const redirectUrl = new URL(APP_ROUTES.callback, window.location.origin);
  const safeNext = sanitizeRedirectTarget(nextPath);
  if (safeNext) {
    redirectUrl.searchParams.set('next', safeNext);
  }
  return redirectUrl.toString();
}

export function AuthProvider({ children }: AuthProviderProps) {
  const initialBootstrap = useMemo(() => getSupabaseClient(), []);
  const [status, setStatus] = useState<AuthSessionStatus>(() =>
    initialBootstrap.client && initialBootstrap.config.configured
      ? 'initializing'
      : 'unconfigured',
  );
  const [user, setUser] = useState<AuthPublicUser | null>(null);
  const [identities, setIdentities] = useState<AuthPublicIdentity[] | null>(null);
  const [settings, setSettings] = useState<AuthAccountSettingsDto | null>(null);
  const [hydratedVia, setHydratedVia] = useState<'me' | 'sync' | null>(null);
  const [failure, setFailure] = useState<AuthUiFailure | null>(() => {
    if (initialBootstrap.client && initialBootstrap.config.configured) {
      return null;
    }
    return classifyAuthFailure({
      code: initialBootstrap.config.configured
        ? 'CLIENT_SUPABASE_NOT_CONFIGURED'
        : initialBootstrap.config.code,
      message: initialBootstrap.config.configured ? '' : initialBootstrap.config.reason,
    });
  });
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const clientRef = useRef<SupabaseClient | null>(null);
  const singleFlightRef = useRef(new SingleFlightHydrator());
  const lastCompletedTokenRef = useRef<string | null>(null);
  const preserveFailureOnSignOutRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applyUnauthenticatedState = useCallback((nextFailure: AuthUiFailure | null = null) => {
    lastCompletedTokenRef.current = null;
    if (!isMountedRef.current) return;
    setUser(null);
    setIdentities(null);
    setSettings(null);
    setHydratedVia(null);
    setFailure(nextFailure);
    setStatus(nextFailure ? 'error' : 'unauthenticated');
  }, []);

  const runSessionHydration = useCallback(
    async (
      supabase: SupabaseClient,
      session: Session,
      mode: 'sync' | 'hydrate',
      preferences?: AuthSyncRequest,
    ): Promise<HydrateSessionOutcome> => {
      const flightKey = `${mode}:${session.access_token}`;
      return singleFlightRef.current.run(flightKey, async () => {
        if (isMountedRef.current) {
          setFailure(null);
          setStatus((prev) => (prev === 'authenticated' ? prev : 'authenticating'));
        }

        const outcome = await hydrateStudexoSession(
          session,
          { mode, preferences },
          {
            refreshSession: async () => {
              const { data, error } = await supabase.auth.refreshSession();
              if (error || !data.session) {
                return null;
              }
              return data.session;
            },
            signOutLocal: async () => {
              preserveFailureOnSignOutRef.current = true;
              await supabase.auth.signOut({ scope: 'local' });
            },
          },
        );

        if (!isMountedRef.current) {
          return outcome;
        }

        if (outcome.ok) {
          lastCompletedTokenRef.current = session.access_token;
          setUser(outcome.data.user);
          if (outcome.data.identities !== null) {
            setIdentities(outcome.data.identities);
          }
          if (outcome.data.settings !== null) {
            setSettings(outcome.data.settings);
          }
          setHydratedVia(outcome.data.hydratedVia);
          setPendingConfirmationEmail(null);
          setFailure(null);
          setStatus('authenticated');
        } else {
          lastCompletedTokenRef.current = null;
          setUser(null);
          setIdentities(null);
          setSettings(null);
          setHydratedVia(null);
          setFailure(outcome.failure);
          setStatus('error');
        }

        return outcome;
      });
    },
    [],
  );

  useEffect(() => {
    const { client, config } = initialBootstrap;
    clientRef.current = client;

    if (!client || !config.configured) {
      return;
    }

    let cancelled = false;
    const oauthParams = parseOAuthCallbackParams(window.location.search, window.location.hash);

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;

      if (event === 'SIGNED_OUT') {
        if (preserveFailureOnSignOutRef.current) {
          preserveFailureOnSignOutRef.current = false;
          return;
        }
        setPendingConfirmationEmail(null);
        applyUnauthenticatedState(null);
        return;
      }

      if (!session) {
        if (event === 'INITIAL_SESSION' && !oauthParams.oauthError) {
          applyUnauthenticatedState(null);
        }
        return;
      }

      if (event === 'SIGNED_IN') {
        if (lastCompletedTokenRef.current === session.access_token) {
          return;
        }
        void runSessionHydration(client, session, 'sync', getBrowserTimezonePreference());
        return;
      }

      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        void runSessionHydration(client, session, 'hydrate', getBrowserTimezonePreference());
      }
    });

    void (async () => {
      if (oauthParams.oauthError) {
        const cleanUrl = buildUrlWithoutAuthParams(
          window.location.pathname,
          window.location.search,
          window.location.hash,
        );
        window.history.replaceState(null, '', cleanUrl);
        if (!cancelled) {
          applyUnauthenticatedState(classifyAuthFailure(oauthParams.oauthError));
        }
        return;
      }

      const { data, error } = await client.auth.getSession();

      if (oauthParams.code || window.location.hash.includes('access_token=')) {
        const cleanUrl = buildUrlWithoutAuthParams(
          window.location.pathname,
          window.location.search,
          window.location.hash,
        );
        window.history.replaceState(null, '', cleanUrl);
      }

      if (cancelled) return;

      if (error) {
        applyUnauthenticatedState(classifyAuthFailure(error));
        return;
      }

      if (data.session) {
        const isCallbackFlow =
          Boolean(oauthParams.code) || window.location.pathname === APP_ROUTES.callback;
        await runSessionHydration(
          client,
          data.session,
          isCallbackFlow ? 'sync' : 'hydrate',
          getBrowserTimezonePreference(),
        );
      } else {
        applyUnauthenticatedState(null);
      }
    })();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applyUnauthenticatedState, initialBootstrap, runSessionHydration]);

  const signInWithEmail = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      const supabase = clientRef.current;
      if (!supabase) {
        const unconfigured = classifyAuthFailure({ code: 'CLIENT_SUPABASE_NOT_CONFIGURED' });
        setFailure(unconfigured);
        setStatus('unconfigured');
        return { ok: false, failure: unconfigured };
      }

      setIsBusy(true);
      setFailure(null);
      setPendingConfirmationEmail(null);

      try {
        const trimmedEmail = email.trim().toLowerCase();
        const { data, error } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });

        if (error) {
          const classified = classifyAuthFailure(error, { email: trimmedEmail });
          if (classified.category === 'unverified_email') {
            setPendingConfirmationEmail(trimmedEmail);
          }
          setFailure(classified);
          setStatus((prev) => (prev === 'authenticated' ? prev : 'error'));
          return { ok: false, failure: classified };
        }

        if (!data.session) {
          const classified = classifyAuthFailure(
            { code: 'AUTH_EMAIL_NOT_VERIFIED' },
            { email: trimmedEmail },
          );
          setPendingConfirmationEmail(trimmedEmail);
          setFailure(classified);
          setStatus('error');
          return { ok: false, requiresEmailVerification: true, failure: classified };
        }

        const outcome = await runSessionHydration(
          supabase,
          data.session,
          'sync',
          getBrowserTimezonePreference(),
        );

        if (!outcome.ok) {
          return { ok: false, failure: outcome.failure };
        }

        return { ok: true };
      } finally {
        if (isMountedRef.current) {
          setIsBusy(false);
        }
      }
    },
    [runSessionHydration],
  );

  const signUpWithEmail = useCallback(
    async (input: SignUpWithEmailInput): Promise<AuthActionResult> => {
      const supabase = clientRef.current;
      if (!supabase) {
        const unconfigured = classifyAuthFailure({ code: 'CLIENT_SUPABASE_NOT_CONFIGURED' });
        setFailure(unconfigured);
        setStatus('unconfigured');
        return { ok: false, failure: unconfigured };
      }

      setIsBusy(true);
      setFailure(null);

      try {
        const trimmedEmail = input.email.trim().toLowerCase();
        const trimmedDisplayName = input.displayName?.trim() || undefined;
        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password: input.password,
          options: {
            emailRedirectTo: buildOAuthRedirectUrl(APP_ROUTES.workspace),
            data: trimmedDisplayName ? { full_name: trimmedDisplayName } : undefined,
          },
        });

        if (error) {
          const classified = classifyAuthFailure(error, { email: trimmedEmail });
          setFailure(classified);
          return { ok: false, failure: classified };
        }

        if (!data.session) {
          setPendingConfirmationEmail(trimmedEmail);
          setStatus('unauthenticated');
          return { ok: true, requiresEmailVerification: true };
        }

        const prefs = {
          ...getBrowserTimezonePreference(),
          ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
        };
        const outcome = await runSessionHydration(supabase, data.session, 'sync', prefs);
        if (!outcome.ok) {
          return { ok: false, failure: outcome.failure };
        }

        return { ok: true };
      } finally {
        if (isMountedRef.current) {
          setIsBusy(false);
        }
      }
    },
    [runSessionHydration],
  );

  const signInWithOAuth = useCallback(
    async (
      provider: 'google' | 'github',
      nextPath?: string | null,
    ): Promise<AuthActionResult> => {
      const supabase = clientRef.current;
      if (!supabase) {
        const unconfigured = classifyAuthFailure({ code: 'CLIENT_SUPABASE_NOT_CONFIGURED' });
        setFailure(unconfigured);
        setStatus('unconfigured');
        return { ok: false, failure: unconfigured };
      }

      setIsBusy(true);
      setFailure(null);

      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: buildOAuthRedirectUrl(nextPath),
          },
        });

        if (error) {
          const classified = classifyAuthFailure(error);
          setFailure(classified);
          return { ok: false, failure: classified };
        }

        return { ok: true };
      } finally {
        if (isMountedRef.current) {
          setIsBusy(false);
        }
      }
    },
    [],
  );

  const resendVerificationEmail = useCallback(async (email: string): Promise<AuthActionResult> => {
    const supabase = clientRef.current;
    if (!supabase) {
      const unconfigured = classifyAuthFailure({ code: 'CLIENT_SUPABASE_NOT_CONFIGURED' });
      setFailure(unconfigured);
      return { ok: false, failure: unconfigured };
    }

    setIsBusy(true);
    try {
      const trimmedEmail = email.trim().toLowerCase();
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: trimmedEmail,
        options: {
          emailRedirectTo: buildOAuthRedirectUrl(APP_ROUTES.workspace),
        },
      });
      if (error) {
        const classified = classifyAuthFailure(error, { email: trimmedEmail });
        setFailure(classified);
        return { ok: false, failure: classified };
      }
      setPendingConfirmationEmail(trimmedEmail);
      return { ok: true, requiresEmailVerification: true };
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false);
      }
    }
  }, []);

  const refreshSessionAndHydrate = useCallback(
    async (mode: 'hydrate' | 'sync'): Promise<AuthActionResult> => {
      const supabase = clientRef.current;
      if (!supabase) {
        const unconfigured = classifyAuthFailure({ code: 'CLIENT_SUPABASE_NOT_CONFIGURED' });
        setFailure(unconfigured);
        setStatus('unconfigured');
        return { ok: false, failure: unconfigured };
      }

      setIsBusy(true);
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          const classified = classifyAuthFailure(error);
          applyUnauthenticatedState(classified);
          return { ok: false, failure: classified };
        }

        if (!data.session) {
          applyUnauthenticatedState(null);
          return {
            ok: false,
            failure: classifyAuthFailure({ code: 'AUTH_TOKEN_MISSING' }),
          };
        }

        const outcome = await runSessionHydration(
          supabase,
          data.session,
          mode,
          getBrowserTimezonePreference(),
        );
        if (!outcome.ok) {
          return { ok: false, failure: outcome.failure };
        }
        return { ok: true };
      } finally {
        if (isMountedRef.current) {
          setIsBusy(false);
        }
      }
    },
    [applyUnauthenticatedState, runSessionHydration],
  );

  const refreshMe = useCallback(
    () => refreshSessionAndHydrate('hydrate'),
    [refreshSessionAndHydrate],
  );

  const resyncAccount = useCallback(
    () => refreshSessionAndHydrate('sync'),
    [refreshSessionAndHydrate],
  );

  const getAccessToken = useCallback(
    async (options?: { forceRefresh?: boolean }): Promise<string | null> => {
      const supabase = clientRef.current;
      if (!supabase) {
        return null;
      }

      if (options?.forceRefresh) {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session?.access_token) {
          preserveFailureOnSignOutRef.current = true;
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch {
            // Best-effort local cleanup
          }
          applyUnauthenticatedState(
            classifyAuthFailure({ code: 'AUTH_TOKEN_EXPIRED' }),
          );
          return null;
        }
        return data.session.access_token;
      }

      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        return null;
      }
      return data.session.access_token;
    },
    [applyUnauthenticatedState],
  );

  const signOut = useCallback(async (): Promise<void> => {
    const supabase = clientRef.current;
    setIsBusy(true);
    singleFlightRef.current.reset();
    preserveFailureOnSignOutRef.current = false;

    try {
      if (supabase) {
        const { error } = await supabase.auth.signOut();
        if (error) {
          await supabase.auth.signOut({ scope: 'local' });
        }
      }
    } catch {
      if (supabase) {
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // Local cleanup best-effort
        }
      }
    } finally {
      setPendingConfirmationEmail(null);
      applyUnauthenticatedState(null);
      if (isMountedRef.current) {
        setIsBusy(false);
      }
    }
  }, [applyUnauthenticatedState]);

  const clearFailure = useCallback(() => {
    setFailure(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      identities,
      settings,
      hydratedVia,
      failure,
      pendingConfirmationEmail,
      isBusy,
      signInWithEmail,
      signUpWithEmail,
      signInWithOAuth,
      resendVerificationEmail,
      refreshMe,
      resyncAccount,
      getAccessToken,
      signOut,
      clearFailure,
    }),
    [
      status,
      user,
      identities,
      settings,
      hydratedVia,
      failure,
      pendingConfirmationEmail,
      isBusy,
      signInWithEmail,
      signUpWithEmail,
      signInWithOAuth,
      resendVerificationEmail,
      refreshMe,
      resyncAccount,
      getAccessToken,
      signOut,
      clearFailure,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
