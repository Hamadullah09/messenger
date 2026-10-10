import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { ALLOW_PASSWORD_CHANGE_PENDING, IS_PUBLIC, type Actor } from './actor';
import { SessionService } from './session.service';

export type AuthenticatedRequest = Request & { actor?: Actor; id?: string };

/** Global guard: every route requires a valid, unrevoked session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw ApiError.unauthenticated();

    const actor = await this.sessions.authenticate(header.slice('Bearer '.length).trim(), {
      requestId: typeof request.id === 'string' ? request.id : null,
      ipHash: request.ip ? this.crypto.keyedHash(request.ip) : null,
    });

    if (
      actor.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)
    ) {
      throw new ApiError('PASSWORD_CHANGE_REQUIRED', 'Please choose a new password to continue.');
    }
    request.actor = actor;
    return true;
  }
}
