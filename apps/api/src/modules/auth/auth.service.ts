import { Inject, Injectable } from '@nestjs/common';
import type {
  ChangePasswordRequest,
  LoginRequest,
  MeDto,
  MfaSetupDto,
  SessionDto,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { OutboxService } from '../outbox/outbox.service';
import { toPublicUser, publicUserSelect } from '../users/user.mapper';
import type { Actor } from './actor';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';
import { metrics } from '../../infra/metrics/metrics';

/** Durable backstop if Redis rate limiting is unavailable (fails open). */
const LOCKOUT_THRESHOLD = 20;
const LOCKOUT_MINUTES = 30;
const INVALID_CREDENTIALS = 'Incorrect username or password';

export interface ClientContext {
  ip: string;
  ipHash: string;
  userAgent: string | null;
  requestId: string | null;
}

export type LoginOutcome =
  | { mfaRequired: false; session: IssuedSession; userId: string }
  | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
  ) {}

  async login(request: LoginRequest, client: ClientContext): Promise<LoginOutcome> {
    await this.rateLimiter.consume(RATE_LIMITS.loginPerIp, client.ipHash);
    // Applied to every username, existing or not, so limits do not reveal which accounts exist.
    await this.rateLimiter.consume(RATE_LIMITS.loginPerUsername, request.username);

    const user = await this.prisma.user.findUnique({
      where: { username: request.username },
      select: {
        id: true,
        status: true,
        passwordHash: true,
        lockedUntil: true,
        failedLoginCount: true,
        mfaEnabledAt: true,
      },
    });
    const actorStub = { requestId: client.requestId, ipHash: client.ipHash } as const;

    if (!user) {
      await this.passwords.verifyDummy(request.password);
      metrics.authLoginFailures.inc({ step: 'password' });
      throw ApiError.unauthenticated(INVALID_CREDENTIALS);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.verifyDummy(request.password);
      throw ApiError.rateLimited((user.lockedUntil.getTime() - Date.now()) / 1000);
    }

    const valid = await this.passwords.verify(user.passwordHash, request.password);
    if (!valid) {
      const failures = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failures,
          lockedUntil:
            failures >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      await this.audit.recordSafely(
        { userId: user.id, ...actorStub },
        {
          action: 'auth.login',
          outcome: 'FAILURE',
          targetType: 'User',
          targetId: user.id,
          metadata: { reason: 'bad_password' },
        },
      );
      metrics.authLoginFailures.inc({ step: 'password' });
      throw ApiError.unauthenticated(INVALID_CREDENTIALS);
    }
    if (user.status !== 'ACTIVE') {
      // Same message as a wrong password: do not reveal account state to the caller.
      throw ApiError.unauthenticated(INVALID_CREDENTIALS);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(this.passwords.needsRehash(user.passwordHash)
          ? { passwordHash: await this.passwords.hash(request.password) }
          : {}),
      },
    });
    await this.rateLimiter.reset(RATE_LIMITS.loginPerUsername, request.username);

    if (user.mfaEnabledAt) {
      return { mfaRequired: true, mfaToken: await this.sessions.issueMfaToken(user.id) };
    }
    const session = await this.sessions.create(user.id, {
      mfaVerified: false,
      userAgent: client.userAgent,
      ipHash: client.ipHash,
    });
    await this.audit.record(
      { userId: user.id, sessionId: session.sessionId, ...actorStub },
      { action: 'auth.login', targetType: 'User', targetId: user.id, metadata: { mfa: false } },
    );
    return { mfaRequired: false, session, userId: user.id };
  }

  async verifyMfa(
    mfaToken: string,
    code: string,
    client: ClientContext,
  ): Promise<{ session: IssuedSession; userId: string }> {
    await this.rateLimiter.consume(RATE_LIMITS.mfaPerIp, client.ipHash);
    await this.rateLimiter.consume(RATE_LIMITS.mfaPerToken, this.crypto.keyedHash(mfaToken));
    const userId = await this.sessions.verifyMfaToken(mfaToken);
    const blocked = await this.rateLimiter.exceeded(RATE_LIMITS.mfaFailuresPerUser, userId);
    if (blocked.limited) throw ApiError.rateLimited(blocked.retryAfterSeconds);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, mfaSecretEnc: true, mfaLastUsedStep: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.mfaSecretEnc) throw ApiError.unauthenticated();

    const step = this.mfa.verify(
      this.mfa.decryptSecret(userId, user.mfaSecretEnc),
      code,
      user.mfaLastUsedStep,
    );
    if (step === null) {
      await this.audit.recordSafely(
        { userId, requestId: client.requestId, ipHash: client.ipHash },
        { action: 'auth.mfa_verify', outcome: 'FAILURE', targetType: 'User', targetId: userId },
      );
      await this.rateLimiter.hit(RATE_LIMITS.mfaFailuresPerUser, userId);
      metrics.authLoginFailures.inc({ step: 'mfa' });
      throw ApiError.validation(
        'That code did not work. Check your authenticator app and try again.',
        'code',
      );
    }
    // Conditional update prevents two concurrent requests from using the same step.
    const updated = await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }],
      },
      data: { mfaLastUsedStep: step },
    });
    if (updated.count !== 1)
      throw ApiError.validation('That code was already used. Wait for a new one.', 'code');

    const session = await this.sessions.create(userId, {
      mfaVerified: true,
      userAgent: client.userAgent,
      ipHash: client.ipHash,
    });
    await this.audit.record(
      { userId, sessionId: session.sessionId, requestId: client.requestId, ipHash: client.ipHash },
      { action: 'auth.login', targetType: 'User', targetId: userId, metadata: { mfa: true } },
    );
    return { session, userId };
  }

  async refresh(
    refreshToken: string,
    client: ClientContext,
  ): Promise<IssuedSession & { userId: string }> {
    await this.rateLimiter.consume(RATE_LIMITS.refreshPerIp, client.ipHash);
    return this.sessions.rotate(refreshToken);
  }

  async logout(actor: Actor): Promise<void> {
    await this.sessions.revokeSessions([actor.sessionId], 'logout');
    await this.audit.recordSafely(actor, {
      action: 'auth.logout',
      targetType: 'Session',
      targetId: actor.sessionId,
    });
  }

  /** Builds MeDto for a freshly issued session (no request actor exists yet). */
  async meForSession(userId: string, sessionId: string): Promise<MeDto> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { mfaVerifiedAt: true, user: { select: { kind: true, mustChangePassword: true } } },
    });
    return this.me({
      userId,
      sessionId,
      kind: session.user.kind,
      mfaVerified: !this.config.MFA_REQUIRED_FOR_PRIVILEGED || session.mfaVerifiedAt !== null,
      mustChangePassword: session.user.mustChangePassword,
      requestId: null,
      ipHash: null,
    });
  }

  async me(actor: Actor): Promise<MeDto> {
    const [user, memberships, grants] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { ...publicUserSelect, mustChangePassword: true, mfaEnabledAt: true },
      }),
      this.prisma.businessMembership.findMany({
        where: { userId: actor.userId, status: 'ACTIVE' },
        select: {
          business: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
              stores: {
                where: {
                  status: 'ACTIVE',
                  memberships: { some: { userId: actor.userId, status: 'ACTIVE' } },
                },
                select: { id: true, name: true, code: true },
                orderBy: { name: 'asc' },
              },
            },
          },
        },
        orderBy: { business: { name: 'asc' } },
      }),
      this.authz.loadGrants(actor.userId),
    ]);
    return {
      user: toPublicUser(user),
      mustChangePassword: user.mustChangePassword,
      mfaEnabled: user.mfaEnabledAt !== null,
      session: { id: actor.sessionId, mfaVerified: actor.mfaVerified },
      businesses: memberships
        .map((m) => m.business)
        .filter((b) => b.status !== 'ARCHIVED')
        .map((b) => ({ id: b.id, name: b.name, slug: b.slug, status: b.status, stores: b.stores })),
      grants: grants.dtos,
    };
  }

  async setupMfa(actor: Actor): Promise<MfaSetupDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { username: true, mfaEnabledAt: true },
    });
    if (user.mfaEnabledAt) throw ApiError.conflict('Two-step verification is already turned on.');
    const secret = this.mfa.createSecret();
    await this.prisma.user.update({
      where: { id: actor.userId },
      data: { mfaPendingSecretEnc: this.mfa.encryptSecret(actor.userId, secret) },
    });
    const { otpauthUrl, qrCodeDataUrl } = await this.mfa.describe(secret, user.username);
    return { otpauthUrl, qrCodeDataUrl, secret };
  }

  async enableMfa(actor: Actor, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { mfaPendingSecretEnc: true, mfaEnabledAt: true },
    });
    if (user.mfaEnabledAt) throw ApiError.conflict('Two-step verification is already turned on.');
    if (!user.mfaPendingSecretEnc)
      throw ApiError.validation('Start the setup again to get a new code.');
    const secret = this.mfa.decryptSecret(actor.userId, user.mfaPendingSecretEnc);
    const step = this.mfa.verify(secret, code, null);
    if (step === null)
      throw ApiError.validation(
        'That code did not work. Check your authenticator app and try again.',
        'code',
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: actor.userId },
        data: {
          mfaSecretEnc: user.mfaPendingSecretEnc,
          mfaPendingSecretEnc: null,
          mfaEnabledAt: new Date(),
          mfaLastUsedStep: step,
        },
      });
      await this.sessions.markMfaVerified(actor.sessionId, tx);
      await this.audit.record(
        actor,
        { action: 'auth.mfa_enabled', targetType: 'User', targetId: actor.userId },
        tx,
      );
    });
  }

  async changePassword(actor: Actor, request: ChangePasswordRequest): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { passwordHash: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, request.currentPassword))) {
      throw ApiError.validation('Your current password is not correct.', 'currentPassword');
    }
    const passwordHash = await this.passwords.hash(request.newPassword);
    const event = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: actor.userId },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      await this.audit.record(
        actor,
        { action: 'auth.password_changed', targetType: 'User', targetId: actor.userId },
        tx,
      );
      // Sign out every other device.
      return this.sessions.revokeAllForUserTx(
        tx,
        actor.userId,
        'password_changed',
        actor.sessionId,
      );
    });
    if (event) await this.outbox.dispatch([event]);
  }

  async listSessions(actor: Actor): Promise<SessionDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        userAgent: true,
        mfaVerifiedAt: true,
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
      mfaVerified: s.mfaVerifiedAt !== null,
      current: s.id === actor.sessionId,
    }));
  }

  /** "Sign out everywhere else": every other session of the caller (and their devices). */
  async revokeOtherSessions(actor: Actor): Promise<number> {
    const others = await this.prisma.session.findMany({
      where: { userId: actor.userId, revokedAt: null, id: { not: actor.sessionId } },
      select: { id: true },
    });
    await this.sessions.revokeSessions(
      others.map((s) => s.id),
      'user_signed_out_other_devices',
    );
    await this.audit.recordSafely(actor, {
      action: 'auth.sessions_revoked_others',
      targetType: 'User',
      targetId: actor.userId,
      metadata: { count: others.length },
    });
    return others.length;
  }

  async revokeOwnSession(actor: Actor, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: actor.userId },
      select: { id: true },
    });
    if (!session) throw ApiError.notFound('Session');
    await this.sessions.revokeSessions([session.id], 'user_signed_out_device');
    await this.audit.recordSafely(actor, {
      action: 'auth.session_revoked',
      targetType: 'Session',
      targetId: session.id,
    });
  }
}
