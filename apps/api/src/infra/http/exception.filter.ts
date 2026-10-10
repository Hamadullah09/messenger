import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ApiErrorBody, ApiErrorCode } from '@storeline/shared';
import type { Request, Response } from 'express';
import { ApiError } from './api-error';

const HTTP_CODE_MAP: Partial<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/**
 * Converts every error into the documented error envelope. Internal details (stack traces,
 * SQL, Prisma metadata) are logged server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = typeof request.id === 'string' ? request.id : undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody = {
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId },
    };

    if (exception instanceof ApiError) {
      status = exception.status;
      body = {
        error: {
          code: exception.code,
          message: exception.message,
          requestId,
          details: exception.details,
        },
      };
      for (const [name, value] of Object.entries(exception.headers ?? {}))
        response.setHeader(name, value);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = HTTP_CODE_MAP[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
      // Body-parser errors (e.g. "request entity too large") surface here as HttpExceptions.
      const message = status >= 500 ? body.error.message : exception.message;
      body = { error: { code, message, requestId } };
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002'
    ) {
      status = HttpStatus.CONFLICT;
      body = { error: { code: 'CONFLICT', message: 'This item already exists', requestId } };
    } else if (isBodyParserError(exception)) {
      status = exception.status;
      body = {
        error: {
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
          message: status === 413 ? 'Request is too large' : 'Malformed request body',
          requestId,
        },
      };
    }

    if (status >= 500) {
      this.logger.error({ err: exception, requestId }, 'Unhandled error');
    }
    response.status(status).json(body);
  }
}

function isBodyParserError(error: unknown): error is { status: number; type: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    (error as { status: number }).status < 500
  );
}
