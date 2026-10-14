import { Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { reportError } from '../../infra/error-reporting';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { Public } from '../auth/actor';

const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(4000).optional(),
  /** The page path only (no query string: it may carry tokens). */
  path: z
    .string()
    .max(300)
    .transform((v) => v.split('?')[0]!.split('#')[0]!)
    .optional(),
  /** A build identifier of the web app, to tell versions apart. */
  release: z.string().max(80).optional(),
});
type ClientError = z.infer<typeof clientErrorSchema>;

const LIMIT = { name: 'client-errors', limit: 20, windowSeconds: 600 } as const;

/** A token-free page path: quote/pay links and ids are masked. */
function maskPath(path: string | undefined): string | undefined {
  return path
    ?.replace(/\/(quote|pay)\/[^/]+/g, '/$1/:token')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}

/**
 * Crashes in the browser (uncaught errors in the web app), so they reach the team before a
 * user reports them: logged, and forwarded to error tracking when it is set up. No sign-in
 * needed (the login page can crash too); rate-limited per IP.
 */
@ApiTags('health')
@Controller({ path: 'client-errors', version: '1' })
export class ClientErrorsController {
  private readonly logger = new Logger('ClientErrors');

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly crypto: CryptoService,
  ) {}

  @Public()
  @Post()
  @HttpCode(204)
  @ApiZodBody(clientErrorSchema)
  async report(
    @Req() req: Request,
    @Body(new ZodPipe(clientErrorSchema)) body: ClientError,
  ): Promise<void> {
    await this.rateLimiter.consume(LIMIT, this.crypto.keyedHash(req.ip ?? 'unknown'));
    const path = maskPath(body.path);
    this.logger.warn({ message: body.message, path, release: body.release }, 'Web app error');
    const error = new Error(body.message);
    error.name = 'WebAppError';
    if (body.stack) error.stack = `WebAppError: ${body.message}\n${body.stack}`;
    reportError(error, { source: 'web', path, release: body.release });
  }
}
