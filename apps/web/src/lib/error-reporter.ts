/**
 * Sends browser crashes to the server (POST /api/v1/client-errors), which logs them and
 * forwards them to error tracking. At most a few per page load, each message once; only the
 * page path is sent (never the query string, which may hold a token).
 */
const MAX_PER_PAGE = 8;
const seen = new Set<string>();

export function reportClientError(error: unknown): void {
  if (typeof window === 'undefined' || seen.size >= MAX_PER_PAGE) return;
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
  const message = (err.message || err.name || 'Unknown error').slice(0, 500);
  // Network failures and aborted requests are not bugs in the app.
  if (/Failed to fetch|NetworkError|Load failed|AbortError|ResizeObserver loop/i.test(message))
    return;
  if (seen.has(message)) return;
  seen.add(message);
  void fetch('/api/v1/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      message,
      ...(err.stack ? { stack: err.stack.slice(0, 4000) } : {}),
      path: window.location.pathname.slice(0, 300),
      ...(process.env.NEXT_PUBLIC_APP_VERSION
        ? { release: process.env.NEXT_PUBLIC_APP_VERSION }
        : {}),
    }),
  }).catch(() => undefined);
}

/** Uncaught errors and promise rejections anywhere in the app. Returns the cleanup. */
export function listenForCrashes(): () => void {
  const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
