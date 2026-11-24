import { AlertTriangle, CheckCircle2, Info, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/features/auth/authContext';
import {
  APP_ROUTES,
  getDefaultRouteForRole,
  type AuthRecoveryAction,
  type AuthUiFailure,
} from '@/features/auth/authModel';
import { useNavigate } from '@/lib/navigation';

interface AuthStatusBannerProps {
  failure: AuthUiFailure;
  onDismiss?: () => void;
}

export function AuthStatusBanner({ failure, onDismiss }: AuthStatusBannerProps) {
  const { user, resendVerificationEmail, resyncAccount, signOut, isBusy } = useAuth();
  const navigate = useNavigate();
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const isDanger = failure.tone === 'danger';
  const containerClasses = isDanger
    ? 'border-red-300 bg-red-50 text-red-950'
    : 'border-amber-300 bg-amber-50 text-amber-950';
  const iconClasses = isDanger ? 'text-red-700' : 'text-amber-700';

  const handleAction = async (action: AuthRecoveryAction) => {
    setResendMessage(null);

    switch (action) {
      case 'resend_verification': {
        if (!failure.email) return;
        const result = await resendVerificationEmail(failure.email);
        if (result.ok) {
          setResendMessage(`Verification link sent to ${failure.email}. Check your inbox.`);
        }
        return;
      }
      case 'retry_sync': {
        await resyncAccount();
        return;
      }
      case 'reauthenticate': {
        onDismiss?.();
        navigate(APP_ROUTES.login);
        return;
      }
      case 'sign_out': {
        await signOut();
        navigate(APP_ROUTES.login, { replace: true });
        return;
      }
      case 'go_home': {
        onDismiss?.();
        navigate(user ? getDefaultRouteForRole(user.role) : APP_ROUTES.home);
        return;
      }
    }
  };

  const renderActionLabel = (action: AuthRecoveryAction): string => {
    switch (action) {
      case 'resend_verification':
        return 'Resend verification email';
      case 'retry_sync':
        return 'Retry verification';
      case 'reauthenticate':
        return 'Return to sign in';
      case 'sign_out':
        return 'Sign out & switch account';
      case 'go_home':
        return user ? 'Go to my workspace' : 'Go to overview';
    }
  };

  return (
    <section
      role="alert"
      aria-live="polite"
      className={`rounded-lg border p-5 ${containerClasses}`}
      data-auth-error-code={failure.code}
      data-auth-error-category={failure.category}
    >
      <div className="flex items-start gap-3.5">
        <div className={`mt-0.5 shrink-0 ${iconClasses}`}>
          {isDanger ? <ShieldAlert className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight">{failure.title}</h2>
            <span className="rounded border border-current/25 px-2 py-0.5 font-mono text-[11px] font-medium opacity-80">
              {failure.code}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed opacity-95">{failure.summary}</p>
          <p className="mt-1 text-xs leading-relaxed opacity-85">{failure.guidance}</p>

          {failure.requestId ? (
            <p className="mt-2 font-mono text-[11px] opacity-75">
              Request ID: {failure.requestId}
            </p>
          ) : null}

          {resendMessage ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
              <span>{resendMessage}</span>
            </div>
          ) : null}

          {failure.recoveryActions.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {failure.recoveryActions.map((action, index) => (
                <button
                  key={action}
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleAction(action)}
                  className={
                    index === 0
                      ? 'inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md bg-slate-900 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60'
                      : 'inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md border border-current/30 bg-white/80 px-3.5 py-2 text-xs font-medium transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60'
                  }
                >
                  {action === 'retry_sync' ? (
                    <RefreshCw className="h-3.5 w-3.5" />
                  ) : action === 'sign_out' ? (
                    <LogOut className="h-3.5 w-3.5" />
                  ) : (
                    <Info className="h-3.5 w-3.5" />
                  )}
                  <span>{renderActionLabel(action)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
