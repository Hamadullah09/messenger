import { ApiError } from './api-error';

/** Opaque cursors: base64url-encoded JSON. Clients must treat them as opaque strings. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string | undefined,
  validate: (value: Record<string, unknown>) => value is T,
): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      validate(parsed as Record<string, unknown>)
    ) {
      return parsed as T;
    }
  } catch {
    // fall through
  }
  throw ApiError.validation('Invalid cursor', 'cursor');
}

export const isIdCursor = (v: Record<string, unknown>): v is { id: string } =>
  typeof v.id === 'string';
