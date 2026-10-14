'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { reportClientError } from '@/lib/error-reporter';

/** A screen crashed: say so plainly, report it, and offer to try again. */
export default function ScreenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <main
      id="main"
      className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-bold">Something went wrong on this screen</h1>
      <p className="max-w-md text-muted">
        The team has been told. Try again, and if it keeps happening, reload the page.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white hover:bg-brand-strong"
        >
          <RotateCcw className="size-5" aria-hidden /> Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-11 items-center rounded-xl border border-line-strong/60 px-4 font-semibold hover:bg-surface-2"
        >
          Reload the page
        </button>
      </div>
    </main>
  );
}
