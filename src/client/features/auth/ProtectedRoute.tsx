import { Lock, ShieldOff } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { AuthStatusBanner } from '@/features/auth/AuthStatusBanner';
import { useAuth } from '@/features/auth/authContext';
import {
  APP_ROUTES,
  canRoleAccessRoute,
  getDefaultRouteForRole,
  type StudexoRole,
} from '@/features/auth/authModel';
import { useLocation, useNavigate } from '@/lib/navigation';

interface ProtectedRouteProps {
  allowedRoles?: StudexoRole[];
  children: ReactNode;
}

export function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { status, user, failure } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const isLoading = status === 'initializing' || status === 'authenticating';
  const currentTarget = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (status === 'unauthenticated') {
      const encodedNext = encodeURIComponent(currentTarget);
      navigate(`${APP_ROUTES.login}?next=${encodedNext}`, { replace: true });
    }
  }, [currentTarget, navigate, status]);

  if (isLoading) {
    return (
      <section
        aria-busy="true"
        aria-label="Verifying session"
        className="rounded-lg border border-slate-200 bg-white p-8"
      >
        <div className="space-y-4">
          <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-80 max-w-full animate-pulse rounded bg-slate-100" />
          <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
            <div className="h-20 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
            <div className="h-20 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
            <div className="h-20 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
          </div>
        </div>
      </section>
    );
  }

  if (status === 'unconfigured' || status === 'error') {
    return (
      <div className="space-y-4">
        {failure ? <AuthStatusBanner failure={failure} /> : null}
      </div>
    );
  }

  if (!user || status !== 'authenticated') {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <Lock className="mx-auto h-6 w-6 text-slate-500" />
        <h1 className="mt-3 text-base font-semibold text-slate-900">Sign in required</h1>
        <p className="mt-1 text-sm text-slate-600">
          Redirecting you to authenticate before accessing this workspace.
        </p>
        <button
          type="button"
          onClick={() => navigate(`${APP_ROUTES.login}?next=${encodeURIComponent(currentTarget)}`)}
          className="mt-4 inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
        >
          Go to sign in
        </button>
      </section>
    );
  }

  if (user.status !== 'active') {
    const restrictedFailure =
      user.status === 'suspended'
        ? {
            category: 'account_suspended' as const,
            code: 'AUTH_USER_SUSPENDED',
            title: 'Account suspended',
            summary: 'Your account status is suspended and cannot access protected workspaces.',
            guidance: 'Sign out or contact support.',
            recoveryActions: ['sign_out' as const],
            tone: 'danger' as const,
          }
        : {
            category: 'pending_deletion' as const,
            code: 'AUTH_USER_PENDING_DELETION',
            title: 'Account pending deletion',
            summary: 'Your account is scheduled for deletion and protected views are disabled.',
            guidance: 'Sign out to return to the public portal.',
            recoveryActions: ['sign_out' as const],
            tone: 'danger' as const,
          };

    return <AuthStatusBanner failure={restrictedFailure} />;
  }

  const roleMatches =
    (!allowedRoles || allowedRoles.includes(user.role)) &&
    canRoleAccessRoute(user.role, location.pathname);

  if (!roleMatches) {
    const defaultRoute = getDefaultRouteForRole(user.role);
    return (
      <section className="rounded-lg border border-red-200 bg-white p-8">
        <div className="flex items-start gap-3.5">
          <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold text-slate-950">
                Workspace restricted to authorized role
              </h1>
              <span className="rounded border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-xs font-medium text-red-800">
                403 AUTH_FORBIDDEN
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Your database-verified Studexo role is{' '}
              <span className="font-mono font-medium text-slate-900">{user.role}</span>, which does
              not grant access to{' '}
              <span className="font-mono text-slate-900">{location.pathname}</span>.
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => navigate(defaultRoute)}
                className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
              >
                Open my {user.role} workspace
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return <>{children}</>;
}
