import {
  classifyAuthFailure,
  isRecoverable401Error,
  type AuthUiFailure,
} from '@/features/auth/authModel';
import {
  fetchCurrentUser,
  isApiClientError,
  syncAuthSession,
} from '@/lib/apiClient';
import type {
  AuthAccountSettingsDto,
  AuthMeResponse,
  AuthPublicIdentity,
  AuthPublicUser,
  AuthSyncRequest,
  AuthSyncResponse,
} from '@shared/schemas/auth.schema';

export interface HydratedSessionPayload {
  user: AuthPublicUser;
  identities: AuthPublicIdentity[] | null;
  settings: AuthAccountSettingsDto | null;
  hydratedVia: 'me' | 'sync';
}

export type HydrateSessionOutcome =
  | {
      ok: true;
      data: HydratedSessionPayload;
    }
  | {
      ok: false;
      failure: AuthUiFailure;
      sessionCleared: boolean;
    };

export interface AuthSessionLike {
  access_token: string;
  user?: {
    email?: string | null;
  } | null;
}

export interface SessionHydrationDeps {
  syncSession?: (token: string, prefs?: AuthSyncRequest) => Promise<AuthSyncResponse>;
  fetchMe?: (token: string) => Promise<AuthMeResponse>;
  refreshSession: () => Promise<AuthSessionLike | null>;
  signOutLocal: () => Promise<void>;
}

/**
 * Coordinates backend session hydration (`GET /api/auth/me`) and authoritative
 * provisioning/sync (`POST /api/auth/sync`), including single-retry token refresh
 * on recoverable 401 responses and clean local session clearing when refresh fails.
 */
export async function hydrateStudexoSession(
  session: AuthSessionLike,
  options: {
    mode: 'sync' | 'hydrate';
    preferences?: AuthSyncRequest;
  },
  deps: SessionHydrationDeps,
): Promise<HydrateSessionOutcome> {
  const syncFn = deps.syncSession ?? ((token, prefs) => syncAuthSession(token, prefs));
  const meFn = deps.fetchMe ?? ((token) => fetchCurrentUser(token));
  const email = session.user?.email ?? undefined;

  const executeAttempt = async (accessToken: string): Promise<HydratedSessionPayload> => {
    if (options.mode === 'sync') {
      const synced = await syncFn(accessToken, options.preferences);
      return {
        user: synced.user,
        identities: synced.identities,
        settings: synced.settings,
        hydratedVia: 'sync',
      };
    }

    try {
      const me = await meFn(accessToken);
      return {
        user: me.user,
        identities: null,
        settings: null,
        hydratedVia: 'me',
      };
    } catch (err: unknown) {
      if (isApiClientError(err) && err.status === 404 && err.code === 'AUTH_IDENTITY_NOT_FOUND') {
        const synced = await syncFn(accessToken, options.preferences);
        return {
          user: synced.user,
          identities: synced.identities,
          settings: synced.settings,
          hydratedVia: 'sync',
        };
      }
      throw err;
    }
  };

  try {
    const data = await executeAttempt(session.access_token);
    return { ok: true, data };
  } catch (firstErr: unknown) {
    if (isRecoverable401Error(firstErr)) {
      let refreshedSession: AuthSessionLike | null;
      try {
        refreshedSession = await deps.refreshSession();
      } catch {
        refreshedSession = null;
      }

      if (refreshedSession?.access_token) {
        try {
          const data = await executeAttempt(refreshedSession.access_token);
          return { ok: true, data };
        } catch (retryErr: unknown) {
          if (isRecoverable401Error(retryErr)) {
            await safeSignOutLocal(deps.signOutLocal);
            return {
              ok: false,
              failure: classifyAuthFailure(retryErr, { email }),
              sessionCleared: true,
            };
          }

          return {
            ok: false,
            failure: classifyAuthFailure(retryErr, { email }),
            sessionCleared: false,
          };
        }
      }

      await safeSignOutLocal(deps.signOutLocal);
      return {
        ok: false,
        failure: classifyAuthFailure(firstErr, { email }),
        sessionCleared: true,
      };
    }

    return {
      ok: false,
      failure: classifyAuthFailure(firstErr, { email }),
      sessionCleared: false,
    };
  }
}

async function safeSignOutLocal(signOutLocal: () => Promise<void>): Promise<void> {
  try {
    await signOutLocal();
  } catch {
    // Ignore local cleanup error so caller still enters clean unauthenticated state.
  }
}

/**
 * Deduplicates concurrent hydration requests triggered by overlapping Supabase
 * auth events (`INITIAL_SESSION` + `SIGNED_IN`) or React StrictMode mounts.
 */
export class SingleFlightHydrator {
  private inflightKey: string | null = null;
  private inflightPromise: Promise<HydrateSessionOutcome> | null = null;

  public run(
    key: string,
    factory: () => Promise<HydrateSessionOutcome>,
  ): Promise<HydrateSessionOutcome> {
    if (this.inflightPromise && this.inflightKey === key) {
      return this.inflightPromise;
    }

    this.inflightKey = key;
    const promise = factory().finally(() => {
      if (this.inflightPromise === promise) {
        this.inflightKey = null;
        this.inflightPromise = null;
      }
    });
    this.inflightPromise = promise;
    return promise;
  }

  public reset(): void {
    this.inflightKey = null;
    this.inflightPromise = null;
  }
}
