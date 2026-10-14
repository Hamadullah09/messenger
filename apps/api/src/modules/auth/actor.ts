import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthorizationContext } from '@storeline/shared';

/** The authenticated principal for one request or socket. */
export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly kind: 'INTERNAL' | 'EXTERNAL';
  readonly mfaVerified: boolean;
  readonly mustChangePassword: boolean;
  readonly requestId: string | null;
  readonly ipHash: string | null;
  /**
   * The business the client is working in (X-Business-Id header). Only a hint: every service
   * still checks the actor's rights in that business.
   */
  readonly businessHint?: string | null;
  /** Lazily loaded and memoised by AuthorizationService for the lifetime of the request. */
  authz?: Promise<AuthorizationContext>;
}

export const IS_PUBLIC = 'storeline:isPublic';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'storeline:allowPasswordChangePending';

/** Route does not require authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Route stays usable while the user still has to replace an initial password. */
export const AllowPasswordChangePending = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<{ actor?: Actor }>();
  if (!request.actor) throw new Error('CurrentActor used on a public route');
  return request.actor;
});
