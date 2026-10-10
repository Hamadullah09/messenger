import type { ApiErrorCode } from '@storeline/shared';

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Domain error with a stable, client-visible code. Messages must be safe to show to users. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }

  static notFound(what = 'Resource'): ApiError {
    return new ApiError('NOT_FOUND', `${what} not found`);
  }

  static forbidden(message = 'You do not have permission to do this'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }

  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message);
  }

  static validation(message: string, path = ''): ApiError {
    return new ApiError('VALIDATION_FAILED', message, [{ path, message }]);
  }

  static unauthenticated(message = 'Please sign in again'): ApiError {
    return new ApiError('UNAUTHENTICATED', message);
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      'RATE_LIMITED',
      'Too many attempts. Please wait and try again.',
      undefined,
      {
        'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
      },
    );
  }
}
