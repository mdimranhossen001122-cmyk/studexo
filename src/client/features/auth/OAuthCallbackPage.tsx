import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { AuthStatusBanner } from '@/features/auth/AuthStatusBanner';
import { useAuth } from '@/features/auth/authContext';
import {
  APP_ROUTES,
  getDefaultRouteForRole,
  sanitizeRedirectTarget,
} from '@/features/auth/authModel';
import { useLocation, useNavigate } from '@/lib/navigation';

export function OAuthCallbackPage() {
  const { status, user, failure } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const searchParams = new URLSearchParams(location.search);
  const nextTarget = sanitizeRedirectTarget(searchParams.get('next'));

  useEffect(() => {
    if (status === 'authenticated' && user && user.status === 'active') {
      const destination = nextTarget ?? getDefaultRouteForRole(user.role);
      navigate(destination, { replace: true });
    }
  }, [navigate, nextTarget, status, user]);

  if (status === 'initializing' || status === 'authenticating') {
    return (
      <section className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-8">
        <div className="flex items-start gap-3.5">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-blue-700" />
          <div className="space-y-1.5">
            <h1 className="text-base font-semibold text-slate-950">
              Completing secure sign-in
            </h1>
            <p className="text-sm leading-relaxed text-slate-600">
              Exchanging PKCE authorization code, verifying your provider identity with Supabase,
              and hydrating your Studexo database profile.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (status === 'authenticated' && user) {
    return (
      <section className="mx-auto max-w-lg rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-emerald-950">
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700" />
          <span>Sign-in verified. Redirecting to your workspace...</span>
        </div>
      </section>
    );
  }

  if (status === 'error' || status === 'unconfigured') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {failure ? <AuthStatusBanner failure={failure} /> : null}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => navigate(APP_ROUTES.login, { replace: true })}
            className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-900 hover:bg-slate-50"
          >
            Return to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-8">
      <h1 className="text-base font-semibold text-slate-950">No active callback session</h1>
      <p className="mt-1.5 text-sm text-slate-600">
        This callback route did not detect an active authorization code or session. Start a fresh
        sign-in attempt below.
      </p>
      <div className="mt-4">
        <button
          type="button"
          onClick={() => navigate(APP_ROUTES.login, { replace: true })}
          className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"
        >
          Go to sign in
        </button>
      </div>
    </section>
  );
}
