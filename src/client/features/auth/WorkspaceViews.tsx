import {
  Briefcase,
  CheckCircle2,
  GraduationCap,
  LogOut,
  RefreshCw,
  Shield,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';
import { AuthStatusBanner } from '@/features/auth/AuthStatusBanner';
import { useAuth } from '@/features/auth/authContext';
import { APP_ROUTES, getDefaultRouteForRole } from '@/features/auth/authModel';
import { StudentProfilePanel } from '@/features/student/StudentProfilePanel';
import { useNavigate } from '@/lib/navigation';

function AccountHydrationSummary() {
  const {
    user,
    identities,
    settings,
    hydratedVia,
    failure,
    isBusy,
    refreshMe,
    resyncAccount,
    signOut,
  } = useAuth();
  const navigate = useNavigate();
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  if (!user) {
    return null;
  }

  const handleRefreshMe = async () => {
    setActionNotice(null);
    const result = await refreshMe();
    if (result.ok) {
      setActionNotice('Hydrated latest profile from GET /api/auth/me.');
    }
  };

  const handleResync = async () => {
    setActionNotice(null);
    const result = await resyncAccount();
    if (result.ok) {
      setActionNotice('Verified authoritative session via POST /api/auth/sync.');
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate(APP_ROUTES.login, { replace: true });
  };

  return (
    <div className="space-y-4">
      {failure ? <AuthStatusBanner failure={failure} /> : null}

      {actionNotice ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
          <span>{actionNotice}</span>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-blue-700" />
            <div>
              <h2 className="text-sm font-semibold text-slate-950">
                Hydrated Studexo Account
              </h2>
              <p className="text-xs text-slate-500">
                Database-verified identity context
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleRefreshMe()}
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh /me</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleResync()}
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            >
              <UserCheck className="h-3.5 w-3.5" />
              <span>Sync session</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleSignOut()}
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>

        <dl className="grid grid-cols-1 divide-y divide-slate-200 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
          <div className="p-5">
            <dt className="text-xs font-medium text-slate-500">Display name</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">
              {user.displayName ?? 'Not set'}
            </dd>
          </div>
          <div className="p-5">
            <dt className="text-xs font-medium text-slate-500">Primary email</dt>
            <dd className="mt-1 font-mono text-xs text-slate-900">{user.primaryEmail}</dd>
          </div>
          <div className="p-5">
            <dt className="text-xs font-medium text-slate-500">DB Role & Status</dt>
            <dd className="mt-1 flex items-center gap-2">
              <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-xs font-medium text-blue-900">
                {user.role}
              </span>
              <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-xs font-medium text-emerald-900">
                {user.status}
              </span>
            </dd>
          </div>
        </dl>

        <div className="grid grid-cols-1 gap-4 border-t border-slate-200 bg-slate-50/70 px-6 py-4 text-xs sm:grid-cols-3">
          <div>
            <span className="font-medium text-slate-500">Internal user ID</span>
            <p className="mt-0.5 truncate font-mono text-slate-800">{user.id}</p>
          </div>
          <div>
            <span className="font-medium text-slate-500">Hydration source</span>
            <p className="mt-0.5 font-mono text-slate-800">
              {hydratedVia === 'sync' ? 'POST /api/auth/sync' : 'GET /api/auth/me'}
            </p>
          </div>
          <div>
            <span className="font-medium text-slate-500">Linked verified providers</span>
            <p className="mt-0.5 font-mono text-slate-800">
              {identities && identities.length > 0
                ? identities
                    .map((i) => `${i.provider}${i.emailVerified ? ' (verified)' : ''}`)
                    .join(', ')
                : 'Available after /sync'}
            </p>
          </div>
        </div>

        {settings ? (
          <div className="grid grid-cols-1 gap-4 border-t border-slate-200 px-6 py-3.5 text-xs text-slate-600 sm:grid-cols-3">
            <div>
              Locale: <span className="font-mono text-slate-900">{settings.preferredLocale}</span>
            </div>
            <div>
              Currency:{' '}
              <span className="font-mono text-slate-900">{settings.preferredCurrency}</span>
            </div>
            <div>
              Timezone: <span className="font-mono text-slate-900">{settings.timezone}</span>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function WorkspaceHubPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;
  const roleRoute = getDefaultRouteForRole(user.role);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono text-xs font-medium text-blue-700 uppercase">
              Authenticated Session Hub
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Welcome to Studexo, {user.displayName ?? user.primaryEmail}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Your database-verified role grants access to the{' '}
              <span className="font-mono font-medium text-slate-900">{user.role}</span> workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(roleRoute)}
            className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"
          >
            Open {user.role} workspace
          </button>
        </div>
      </section>

      <AccountHydrationSummary />
    </div>
  );
}

export function StudentWorkspacePage() {
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3.5">
          <GraduationCap className="mt-0.5 h-6 w-6 shrink-0 text-blue-700" />
          <div>
            <p className="font-mono text-xs font-medium text-blue-700 uppercase">
              Student Admissions Workspace
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Admissions & Academic Readiness Portal
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">
              Manage your study goals, SSC and HSC board qualifications, and IELTS readiness under
              your verified Studexo student identity.
            </p>
          </div>
        </div>
      </section>

      <StudentProfilePanel />

      <AccountHydrationSummary />
    </div>
  );
}

export function CounselorWorkspacePage() {
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3.5">
          <Briefcase className="mt-0.5 h-6 w-6 shrink-0 text-blue-700" />
          <div>
            <p className="font-mono text-xs font-medium text-blue-700 uppercase">
              Counselor Advisory Workspace
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Student Guidance & Review Console
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">
              Protected counselor workspace accessible strictly when PostgreSQL{' '}
              <span className="font-mono text-slate-900">studexo.users.role</span> equals{' '}
              <span className="font-mono text-slate-900">counselor</span>.
            </p>
          </div>
        </div>
      </section>

      <AccountHydrationSummary />
    </div>
  );
}

export function AdminWorkspacePage() {
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3.5">
          <Shield className="mt-0.5 h-6 w-6 shrink-0 text-blue-700" />
          <div>
            <p className="font-mono text-xs font-medium text-blue-700 uppercase">
              Platform Administration Workspace
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Governance & Lifecycle Operations
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">
              Restricted administrative console authorized exclusively from authoritative
              database role records. Client-side navigation never grants server privileges.
            </p>
          </div>
        </div>
      </section>

      <AccountHydrationSummary />
    </div>
  );
}
