import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthPage } from '@/features/auth/AuthPage';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { APP_ROUTES } from '@/features/auth/authModel';
import { HomeOverviewPage } from '@/features/auth/HomeOverviewPage';
import { OAuthCallbackPage } from '@/features/auth/OAuthCallbackPage';
import { ProtectedRoute } from '@/features/auth/ProtectedRoute';
import {
  AdminWorkspacePage,
  CounselorWorkspacePage,
  StudentWorkspacePage,
  WorkspaceHubPage,
} from '@/features/auth/WorkspaceViews';
import { RootLayout } from '@/layouts/RootLayout';
import { useLocation, useNavigate } from '@/lib/navigation';

function AppRoutes() {
  const location = useLocation();
  const navigate = useNavigate();

  switch (location.pathname) {
    case APP_ROUTES.home:
      return <HomeOverviewPage />;
    case APP_ROUTES.login:
      return <AuthPage />;
    case APP_ROUTES.callback:
      return <OAuthCallbackPage />;
    case APP_ROUTES.workspace:
      return (
        <ProtectedRoute>
          <WorkspaceHubPage />
        </ProtectedRoute>
      );
    case APP_ROUTES.student:
      return (
        <ProtectedRoute allowedRoles={['student']}>
          <StudentWorkspacePage />
        </ProtectedRoute>
      );
    case APP_ROUTES.counselor:
      return (
        <ProtectedRoute allowedRoles={['counselor']}>
          <CounselorWorkspacePage />
        </ProtectedRoute>
      );
    case APP_ROUTES.admin:
      return (
        <ProtectedRoute allowedRoles={['admin']}>
          <AdminWorkspacePage />
        </ProtectedRoute>
      );
    default:
      return (
        <section className="rounded-lg border border-slate-200 bg-white p-8">
          <h1 className="text-lg font-semibold text-slate-950">Page not found</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            The route <span className="font-mono text-slate-900">{location.pathname}</span> does
            not exist.
          </p>
          <button
            type="button"
            onClick={() => navigate(APP_ROUTES.home)}
            className="mt-4 inline-flex items-center whitespace-nowrap shrink-0 rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
          >
            Return to overview
          </button>
        </section>
      );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RootLayout>
          <AppRoutes />
        </RootLayout>
      </AuthProvider>
    </ErrorBoundary>
  );
}
