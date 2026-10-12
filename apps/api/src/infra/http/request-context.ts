import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface RequestContext {
  /** Host name the browser used to reach the app (e.g. 192.168.18.41), when known. */
  hostname: string | null;
  /** The page's origin (scheme, host and port), e.g. http://192.168.18.41:3000. */
  origin: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

function urlOf(value: string | undefined, proto = 'http'): URL | null {
  if (!value) return null;
  const first = value.split(',')[0]!.trim();
  try {
    return new URL(first.includes('://') ? first : `${proto}://${first}`);
  } catch {
    return null;
  }
}

/**
 * Remembers which address the browser used (behind the web app's proxy: X-Forwarded-Host, else
 * Origin, else Referer). Storage uses it in development so links work from phones on the LAN.
 */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const proto = header('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
  const page =
    urlOf(header('x-forwarded-host'), proto) ??
    urlOf(header('origin')) ??
    urlOf(header('referer')) ??
    urlOf(header('host'));
  requestContext.run({ hostname: page?.hostname ?? null, origin: page?.origin ?? null }, next);
}
