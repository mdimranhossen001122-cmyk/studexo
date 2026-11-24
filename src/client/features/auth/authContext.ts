import { createContext, useContext } from 'react';
import type { AuthUiFailure } from '@/features/auth/authModel';
import type {
  AuthAccountSettingsDto,
  AuthPublicIdentity,
  AuthPublicUser,
} from '@shared/schemas/auth.schema';

export type AuthSessionStatus =
  | 'initializing'
  | 'authenticating'
  | 'authenticated'
  | 'unauthenticated'
  | 'error'
  | 'unconfigured';

export interface SignUpWithEmailInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface AuthActionResult {
  ok: boolean;
  requiresEmailVerification?: boolean;
  failure?: AuthUiFailure;
}

export interface AuthContextValue {
  status: AuthSessionStatus;
  user: AuthPublicUser | null;
  identities: AuthPublicIdentity[] | null;
  settings: AuthAccountSettingsDto | null;
  hydratedVia: 'me' | 'sync' | null;
  failure: AuthUiFailure | null;
  pendingConfirmationEmail: string | null;
  isBusy: boolean;
  signInWithEmail: (email: string, password: string) => Promise<AuthActionResult>;
  signUpWithEmail: (input: SignUpWithEmailInput) => Promise<AuthActionResult>;
  signInWithOAuth: (
    provider: 'google' | 'github',
    nextPath?: string | null,
  ) => Promise<AuthActionResult>;
  resendVerificationEmail: (email: string) => Promise<AuthActionResult>;
  refreshMe: () => Promise<AuthActionResult>;
  resyncAccount: () => Promise<AuthActionResult>;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  signOut: () => Promise<void>;
  clearFailure: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return ctx;
}
