import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  mfaEnableRequestSchema,
  mfaVerifyRequestSchema,
  updateMeRequestSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponseDto,
  type MeDto,
  type MfaEnableRequest,
  type MfaSetupDto,
  type MfaVerifyRequest,
  type SessionDto,
  type UpdateMeRequest,
  NATIVE_CLIENT_HEADER,
  NATIVE_CLIENT_VALUE,
  nativeRefreshRequestSchema,
} from '@storeline/shared';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AllowPasswordChangePending, CurrentActor, Public, type Actor } from './actor';
import { AuthService, type ClientContext } from './auth.service';
import type { IssuedSession } from './session.service';

export const REFRESH_COOKIE = 'sl_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/** Native (desktop/mobile) clients opt into body-based refresh tokens with this header. */
function isNative(req: Request): boolean {
  return req.headers[NATIVE_CLIENT_HEADER] === NATIVE_CLIENT_VALUE;
}

/** Custom header required on cookie-authenticated endpoints (CSRF defence with SameSite=Strict). */
export const CSRF_HEADER = 'x-storeline-csrf';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly crypto: CryptoService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiZodBody(loginRequestSchema)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const outcome = await this.auth.login(body, this.client(req));
    if (outcome.mfaRequired) return { mfaRequired: true, mfaToken: outcome.mfaToken };
    return this.completeSignIn(outcome.session, outcome.userId, res, isNative(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiZodBody(mfaVerifyRequestSchema)
  async verifyMfa(
    @Body(new ZodPipe(mfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { session, userId } = await this.auth.verifyMfa(
      body.mfaToken,
      body.code,
      this.client(req),
    );
    return this.completeSignIn(session, userId, res, isNative(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<LoginResponseDto> {
    if (isNative(req)) {
      // Native clients: token from the request body (no cookie, so no CSRF exposure).
      const parsed = nativeRefreshRequestSchema.safeParse(body);
      if (!parsed.success) throw ApiError.unauthenticated();
      const rotated = await this.auth.refresh(parsed.data.refreshToken, this.client(req));
      return this.completeSignIn(rotated, rotated.userId, res, true);
    }
    this.assertCsrfSafe(req);
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || token.length < 20 || token.length > 200)
      throw ApiError.unauthenticated();
    try {
      const rotated = await this.auth.refresh(token, this.client(req));
      return await this.completeSignIn(rotated, rotated.userId, res, false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') this.clearCookie(res);
      throw error;
    }
  }

  @ApiBearerAuth()
  @AllowPasswordChangePending()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(actor);
    this.clearCookie(res);
  }

  @ApiBearerAuth()
  @AllowPasswordChangePending()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentActor() actor: Actor): Promise<MfaSetupDto> {
    return this.auth.setupMfa(actor);
  }

  @ApiBearerAuth()
  @AllowPasswordChangePending()
  @Post('mfa/enable')
  @HttpCode(204)
  @ApiZodBody(mfaEnableRequestSchema)
  async enableMfa(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(mfaEnableRequestSchema)) body: MfaEnableRequest,
  ): Promise<void> {
    await this.auth.enableMfa(actor, body.code);
  }

  @ApiBearerAuth()
  @AllowPasswordChangePending()
  @Post('password')
  @HttpCode(204)
  @ApiZodBody(changePasswordRequestSchema)
  async changePassword(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
  ): Promise<void> {
    await this.auth.changePassword(actor, body);
  }

  private async completeSignIn(
    session: IssuedSession,
    userId: string,
    res: Response,
    native: boolean,
  ): Promise<LoginResponseDto> {
    if (!native) {
      res.cookie(
        REFRESH_COOKIE,
        session.refreshToken,
        this.cookieOptions(session.refreshTokenExpiresAt),
      );
    }
    const me = await this.auth.meForSession(userId, session.sessionId);
    return {
      mfaRequired: false,
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      ...(native
        ? {
            refreshToken: session.refreshToken,
            refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
          }
        : {}),
      me,
    };
  }

  private cookieOptions(expires: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires,
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieOptions(new Date(0)), expires: undefined });
  }

  /** Cookie-authenticated endpoint: require the custom header and an allowed Origin. */
  private assertCsrfSafe(req: Request): void {
    if (req.headers[CSRF_HEADER] !== '1') throw ApiError.forbidden('Missing request header');
    const origin = req.headers.origin;
    if (origin && !this.config.CORS_ORIGINS.includes(origin))
      throw ApiError.forbidden('Origin not allowed');
  }

  private client(req: Request): ClientContext {
    const ip = req.ip ?? 'unknown';
    const userAgent = req.headers['user-agent'];
    return {
      ip,
      ipHash: this.crypto.keyedHash(ip),
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      requestId:
        typeof (req as { id?: unknown }).id === 'string'
          ? ((req as { id?: string }).id ?? null)
          : null,
    };
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @AllowPasswordChangePending()
  @Get()
  me(@CurrentActor() actor: Actor): Promise<MeDto> {
    return this.auth.me(actor);
  }

  @Patch()
  @ApiZodBody(updateMeRequestSchema)
  async update(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(updateMeRequestSchema)) body: UpdateMeRequest,
  ): Promise<MeDto> {
    if (body.displayName !== undefined) {
      await this.prisma.user.update({
        where: { id: actor.userId },
        data: { displayName: body.displayName },
      });
    }
    return this.auth.me(actor);
  }

  @AllowPasswordChangePending()
  @Get('sessions')
  sessions(@CurrentActor() actor: Actor): Promise<SessionDto[]> {
    return this.auth.listSessions(actor);
  }

  /** Signs out every other device of the caller. */
  @AllowPasswordChangePending()
  @Delete('sessions')
  async revokeOtherSessions(@CurrentActor() actor: Actor): Promise<{ revoked: number }> {
    return { revoked: await this.auth.revokeOtherSessions(actor) };
  }

  @AllowPasswordChangePending()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.auth.revokeOwnSession(actor, id);
  }
}
