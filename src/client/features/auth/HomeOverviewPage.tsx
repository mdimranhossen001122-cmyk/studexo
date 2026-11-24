import { ArrowRight, Briefcase, GraduationCap, Shield, ShieldCheck } from 'lucide-react';
import { AuthStatusBanner } from '@/features/auth/AuthStatusBanner';
import { useAuth } from '@/features/auth/authContext';
import { APP_ROUTES, getDefaultRouteForRole } from '@/features/auth/authModel';
import { useNavigate } from '@/lib/navigation';

export function HomeOverviewPage() {
  const { status, user, failure } = useAuth();
  const navigate = useNavigate();

  const isAuthenticated = status === 'authenticated' && user && user.status === 'active';

  return (
    <div className="space-y-8">
      {failure ? <AuthStatusBanner failure={failure} /> : null}

      <section className="rounded-lg border border-slate-200 bg-white p-8 sm:p-10">
        <p className="font-mono text-xs font-medium tracking-wide text-blue-700 uppercase">
          Global Higher-Education Admissions & Guidance
        </p>
        <h1 className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          Studexo Unified Admissions Workspace
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          Verified identity onboarding and role-isolated portals for students, admissions
          counselors, and platform administrators across Bangladesh and India.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {isAuthenticated ? (
            <>
              <button
                type="button"
                onClick={() => navigate(getDefaultRouteForRole(user.role))}
                className="inline-flex items-center gap-2 whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-800"
              >
                <span>Continue to {user.role} workspace</span>
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => navigate(APP_ROUTES.workspace)}
                className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Session details
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={status === 'unconfigured'}
              onClick={() => navigate(APP_ROUTES.login)}
              className="inline-flex items-center gap-2 whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Sign in or create account</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <GraduationCap className="h-5 w-5 text-blue-700" />
          <h2 className="mt-3 text-sm font-semibold text-slate-950">Student Portal</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Admissions readiness tracking and verified profile settings provisioned automatically
            after email confirmation or PKCE OAuth sign-in.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <Briefcase className="h-5 w-5 text-blue-700" />
          <h2 className="mt-3 text-sm font-semibold text-slate-950">Counselor Console</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Protected advisory workflows authorized solely from PostgreSQL role assignments.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <Shield className="h-5 w-5 text-blue-700" />
          <h2 className="mt-3 text-sm font-semibold text-slate-950">Admin Governance</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Fail-closed RBAC boundaries, account suspension checks, and purge-lock protections
            enforced server-side on every request.
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-700" />
          <div className="space-y-1 text-xs leading-relaxed text-slate-600">
            <p className="font-semibold text-slate-900">Authentication & Hydration Boundary</p>
            <p>
              Sign-in uses Supabase PKCE OAuth (Google, GitHub) and verified email credentials.
              Client routes strictly mirror PostgreSQL-hydrated identity from{' '}
              <span className="font-mono text-slate-800">POST /api/auth/sync</span> and{' '}
              <span className="font-mono text-slate-800">GET /api/auth/me</span>, while backend
              endpoints remain authoritatively enforced by Express RBAC middleware.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
