import { ErrorBoundary } from '@/components/ErrorBoundary';
import { RootLayout } from '@/layouts/RootLayout';

export default function App() {
  return (
    <ErrorBoundary>
      <RootLayout>
        <section className="rounded-xl border border-neutral-200 bg-white p-8 shadow-xs">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-950">
            Studexo
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-600">
            Global higher-education admissions and guidance platform foundation. Core application
            modules are scheduled for subsequent implementation phases.
          </p>
        </section>
      </RootLayout>
    </ErrorBoundary>
  );
}
