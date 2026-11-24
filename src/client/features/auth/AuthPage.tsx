import { ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthStatusBanner } from '@/features/auth/AuthStatusBanner';
import { useAuth } from '@/features/auth/authContext';
import {
  APP_ROUTES,
  getDefaultRouteForRole,
  sanitizeRedirectTarget,
} from '@/features/auth/authModel';
import { useLocation, useNavigate } from '@/lib/navigation';

type AuthFormMode = 'sign_in' | 'sign_up';

export function AuthPage() {
  const {
    status,
    user,
    failure,
    pendingConfirmationEmail,
    isBusy,
    signInWithEmail,
    signUpWithEmail,
    signInWithOAuth,
    resendVerificationEmail,
    clearFailure,
  } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState<AuthFormMode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localValidationError, setLocalValidationError] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const searchParams = new URLSearchParams(location.search);
  const nextTarget = sanitizeRedirectTarget(searchParams.get('next'));

  useEffect(() => {
    if (status === 'authenticated' && user && user.status === 'active') {
      navigate(nextTarget ?? getDefaultRouteForRole(user.role), { replace: true });
    }
  }, [navigate, nextTarget, status, user]);

  const switchMode = (nextMode: AuthFormMode) => {
    setMode(nextMode);
    setLocalValidationError(null);
    setResendNotice(null);
    clearFailure();
  };

  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalValidationError(null);
    setResendNotice(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setLocalValidationError('Enter a valid email address.');
      return;
    }

    if (mode === 'sign_up' && password.length < 8) {
      setLocalValidationError('Password must be at least 8 characters long.');
      return;
    }

    if (!password) {
      setLocalValidationError('Enter your password.');
      return;
    }

    if (mode === 'sign_in') {
      await signInWithEmail(trimmedEmail, password);
    } else {
      await signUpWithEmail({
        email: trimmedEmail,
        password,
        displayName: displayName.trim() || undefined,
      });
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setLocalValidationError(null);
    setResendNotice(null);
    await signInWithOAuth(provider, nextTarget);
  };

  const handleResend = async () => {
    if (!pendingConfirmationEmail) return;
    setResendNotice(null);
    const result = await resendVerificationEmail(pendingConfirmationEmail);
    if (result.ok) {
      setResendNotice(
        `A fresh confirmation link has been sent to ${pendingConfirmationEmail}.`,
      );
    }
  };

  const isAuthDisabled = status === 'unconfigured' || status === 'initializing' || isBusy;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
      <div className="space-y-6 lg:col-span-5">
        <div>
          <p className="font-mono text-xs font-medium tracking-wide text-blue-700 uppercase">
            Studexo Identity Gateway
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            {mode === 'sign_in' ? 'Sign in to Studexo' : 'Create your Studexo account'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Authenticate with Google or GitHub via OAuth PKCE, or with your verified email and
            password. Your role and account status are always hydrated directly from the Studexo
            database after verification.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
            <div className="space-y-1.5 text-xs leading-relaxed text-slate-600">
              <p className="font-semibold text-slate-900">Session verification guarantees</p>
              <p>
                Every sign-in runs authoritative verification via{' '}
                <span className="font-mono text-slate-800">POST /api/auth/sync</span> and hydrates
                role permissions from{' '}
                <span className="font-mono text-slate-800">GET /api/auth/me</span>.
              </p>
              <p>
                Unverified emails, active account purges, suspended profiles, and cross-provider
                email collisions are blocked fail-closed.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 lg:col-span-7">
        {failure ? <AuthStatusBanner failure={failure} onDismiss={clearFailure} /> : null}

        {pendingConfirmationEmail ? (
          <section className="rounded-lg border border-blue-200 bg-blue-50 p-5 text-blue-950">
            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
              <div className="min-w-0 flex-1 space-y-2">
                <h2 className="text-sm font-semibold">Verify your email address</h2>
                <p className="text-xs leading-relaxed text-blue-900">
                  We sent a confirmation link to{' '}
                  <span className="font-mono font-medium">{pendingConfirmationEmail}</span>. Open
                  that link to verify your email, then return here to sync your Studexo workspace.
                </p>
                {resendNotice ? (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>{resendNotice}</span>
                  </p>
                ) : null}
                <div className="pt-1">
                  <button
                    type="button"
                    disabled={isAuthDisabled}
                    onClick={() => void handleResend()}
                    className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-900 hover:bg-blue-100 disabled:opacity-60"
                  >
                    Resend confirmation email
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border border-slate-200 bg-white p-6 sm:p-8">
          <div className="flex items-center border-b border-slate-200 pb-4">
            <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => switchMode('sign_in')}
                className={`whitespace-nowrap shrink-0 rounded px-3.5 py-1.5 text-xs font-medium transition ${
                  mode === 'sign_in'
                    ? 'bg-white text-slate-950 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => switchMode('sign_up')}
                className={`whitespace-nowrap shrink-0 rounded px-3.5 py-1.5 text-xs font-medium transition ${
                  mode === 'sign_up'
                    ? 'bg-white text-slate-950 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create account
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={isAuthDisabled}
              onClick={() => void handleOAuth('google')}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Continue with Google</span>
            </button>
            <button
              type="button"
              disabled={isAuthDisabled}
              onClick={() => void handleOAuth('github')}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Continue with GitHub</span>
            </button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="font-mono text-[11px] text-slate-500 uppercase">
              Or email & password
            </span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <form onSubmit={(e) => void handleEmailSubmit(e)} noValidate className="space-y-4">
            {mode === 'sign_up' ? (
              <div>
                <label
                  htmlFor="auth-display-name"
                  className="block text-xs font-medium text-slate-700"
                >
                  Full name <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  id="auth-display-name"
                  type="text"
                  autoComplete="name"
                  maxLength={160}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={isAuthDisabled}
                  placeholder="Amina Rahman"
                  className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-50"
                />
              </div>
            ) : null}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700">
                Email address
              </label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isAuthDisabled}
                placeholder="student@example.edu"
                className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700">
                Password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isAuthDisabled}
                  placeholder={mode === 'sign_in' ? 'Enter your password' : 'Minimum 8 characters'}
                  className="block w-full rounded-md border border-slate-300 bg-white py-2 pr-10 pl-3 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 hover:text-slate-800"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {localValidationError ? (
              <p role="alert" className="text-xs font-medium text-red-700">
                {localValidationError}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => navigate(APP_ROUTES.home)}
                className="whitespace-nowrap shrink-0 text-xs font-medium text-slate-600 hover:text-slate-950"
              >
                Back to overview
              </button>
              <button
                type="submit"
                disabled={isAuthDisabled}
                className="inline-flex items-center gap-2 whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" />
                <span>
                  {isBusy
                    ? 'Verifying...'
                    : mode === 'sign_in'
                      ? 'Sign in with email'
                      : 'Create account'}
                </span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
