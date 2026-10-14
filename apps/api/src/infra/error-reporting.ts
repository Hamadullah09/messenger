import * as Sentry from '@sentry/node';

let enabled = false;

/**
 * Crash and error reports to Sentry (or a Sentry-compatible service such as self-hosted
 * GlitchTip) when SENTRY_DSN is set; otherwise nothing is sent. No request bodies, cookies,
 * auth headers or user details leave the server: errors only, with the request id to find the
 * full log line.
 */
export function startErrorReporting(service: 'sma-api' | 'sma-worker'): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || enabled) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.APP_VERSION,
    serverName: service,
    // Collect nothing personal: no user, cookies, bodies, query strings or database values.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'x-request-id'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
    },
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (event.request.headers) {
          const { 'user-agent': userAgent, 'x-request-id': requestId } = event.request.headers;
          event.request.headers = {
            ...(userAgent ? { 'user-agent': userAgent } : {}),
            ...(requestId ? { 'x-request-id': requestId } : {}),
          };
        }
      }
      delete event.user;
      return event;
    },
  });
  enabled = true;
}

/** Sends one error (with a few searchable tags) when reporting is on. */
export function reportError(error: unknown, tags: Record<string, string | undefined> = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) if (value) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

/** Flushes pending reports before the process exits. */
export async function flushErrorReports(): Promise<void> {
  if (enabled) await Sentry.flush(2000);
}
