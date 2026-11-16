import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
  };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled client render error:', error, info.componentStack);
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center p-6">
          <section className="max-w-md rounded-lg border border-neutral-200 bg-white p-6 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-neutral-900">Something went wrong</h1>
            <p className="mt-2 text-sm text-neutral-600">
              Please reload the page to restore the application.
            </p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
