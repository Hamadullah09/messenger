'use client';

import type { ApiErrorBody, ApiErrorCode, LoginResponseDto } from '@storeline/shared';
import { useAuth } from './auth-store';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Internal: prevents infinite refresh loops. */
  retried?: boolean;
}

/**
 * 'invalid' means the session is over (sign in again); 'unavailable' means the server could
 * not be reached or failed, which must not sign the user out.
 */
export type RefreshResult = 'ok' | 'invalid' | 'unavailable';

let refreshInFlight: Promise<RefreshResult> | null = null;

/**
 * Rotates the refresh cookie and stores the new access token. Serialised across tabs with
 * the Web Locks API: two tabs refreshing with the same cookie would look like token theft
 * to the server and end the session.
 */
export function refreshSession(): Promise<RefreshResult> {
  refreshInFlight ??= (async () => {
    const run = async (): Promise<RefreshResult> => {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Storeline-CSRF': '1' },
      });
      if (res.status === 401 || res.status === 403) return 'invalid';
      if (!res.ok) return 'unavailable';
      const body = (await res.json()) as LoginResponseDto;
      if (body.mfaRequired) return 'invalid';
      useAuth.getState().setSession(body.accessToken, body.accessTokenExpiresAt, body.me);
      return 'ok';
    };
    try {
      if (typeof navigator !== 'undefined' && 'locks' in navigator) {
        return await navigator.locks.request('storeline-refresh', run);
      }
      return await run();
    } catch {
      return 'unavailable';
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken, accessTokenExpiresAt } = useAuth.getState();
  // Refresh proactively shortly before expiry.
  if (
    accessToken &&
    accessTokenExpiresAt &&
    accessTokenExpiresAt - Date.now() < 30_000 &&
    !options.retried
  ) {
    await refreshSession();
  }
  const token = useAuth.getState().accessToken;
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...businessHeader(),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && !options.retried && token) {
    const refreshed = await refreshSession();
    if (refreshed === 'ok') return api<T>(path, { ...options, retried: true });
    if (refreshed === 'invalid') useAuth.getState().clear();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const error = (data as ApiErrorBody | undefined)?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? 'INTERNAL',
      error?.message ?? 'Something went wrong. Please try again.',
      error?.details,
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof TypeError)
    return 'Cannot reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

export async function login(username: string, password: string): Promise<LoginResponseDto> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as LoginResponseDto | ApiErrorBody;
  if (!res.ok) {
    const error = (body as ApiErrorBody).error;
    throw new ApiRequestError(res.status, error.code, error.message, error.details);
  }
  return body as LoginResponseDto;
}

export async function verifyMfa(mfaToken: string, code: string): Promise<LoginResponseDto> {
  const res = await fetch('/api/v1/auth/mfa/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mfaToken, code }),
  });
  const body = (await res.json()) as LoginResponseDto | ApiErrorBody;
  if (!res.ok) {
    const error = (body as ApiErrorBody).error;
    throw new ApiRequestError(res.status, error.code, error.message, error.details);
  }
  return body as LoginResponseDto;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    useAuth.getState().clear();
  }
}

/** Downloads an authenticated file (e.g. a CSV report) and saves it with the server's name. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      credentials: 'same-origin',
      headers: {
        Authorization: `Bearer ${useAuth.getState().accessToken ?? ''}`,
        ...businessHeader(),
      },
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession()) === 'ok') res = await send();
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiRequestError(
      res.status,
      body?.error.code ?? 'INTERNAL',
      body?.error.message ?? 'The file could not be downloaded.',
    );
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The business the user is working in; the server checks their rights there (e.g. whose CRM). */
function businessHeader(): Record<string, string> {
  const id = useAuth.getState().activeBusinessId;
  return id ? { 'X-Business-Id': id } : {};
}

/** Sends a file as the raw request body (e.g. a logo image). */
export async function uploadBody<T>(path: string, file: Blob, method = 'PUT'): Promise<T> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type,
        Authorization: `Bearer ${useAuth.getState().accessToken ?? ''}`,
      },
      body: file,
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession()) === 'ok') res = await send();
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = (data as ApiErrorBody | undefined)?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? 'INTERNAL',
      res.status === 413
        ? 'This image is too large. Use one under 2 MB.'
        : (error?.message ?? 'The file could not be uploaded.'),
      error?.details,
    );
  }
  return data as T;
}
