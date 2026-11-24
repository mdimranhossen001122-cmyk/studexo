import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/features/auth/authContext';
import { APP_ROUTES, getDefaultRouteForRole } from '@/features/auth/authModel';
import { useLocation, useNavigate } from '@/lib/navigation';

interface RootLayoutProps {
  children: ReactNode;
}

export function RootLayout({ children }: RootLayoutProps) {
  const { status, user, isBusy, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const isAuthenticated = status === 'authenticated' && user && user.status === 'active';
  const roleWorkspaceRoute = user ? getDefaultRouteForRole(user.role) : APP_ROUTES.workspace;

  const handleSignOut = async () => {
    await signOut();
    navigate(APP_ROUTES.login, { replace: true });
  };

  const navLinkClass = (path: string) =>
    `whitespace-nowrap shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition ${
      location.pathname === path
        ? 'bg-slate-900 text-white'
        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
    }`;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => navigate(APP_ROUTES.home)}
              className="whitespace-nowrap shrink-0 text-base font-semibold tracking-tight text-slate-950"
            >
              Studexo
            </button>

            <nav aria-label="Primary navigation" className="hidden items-center gap-1.5 sm:flex">
              <button
                type="button"
                onClick={() => navigate(APP_ROUTES.home)}
                className={navLinkClass(APP_ROUTES.home)}
              >
                Overview
              </button>
              {isAuthenticated ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate(APP_ROUTES.workspace)}
                    className={navLinkClass(APP_ROUTES.workspace)}
                  >
                    Session Hub
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(roleWorkspaceRoute)}
                    className={navLinkClass(roleWorkspaceRoute)}
                  >
                    {user.role === 'student'
                      ? 'Student Portal'
                      : user.role === 'counselor'
                        ? 'Counselor Console'
                        : 'Admin Console'}
                  </button>
                </>
              ) : null}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                <div className="hidden items-center gap-2 md:flex">
                  <span className="max-w-48 truncate font-mono text-xs text-slate-700">
                    {user.primaryEmail}
                  </span>
                  <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-800">
                    {user.role}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-60"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign out</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={status === 'unconfigured'}
                onClick={() => navigate(APP_ROUTES.login)}
                className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
