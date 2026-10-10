import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import type { Actor } from './actor';

interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

interface MfaClaims {
  sub: string;
  typ: 'mfa';
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly outbox: OutboxService,
  ) {}

  async create(
    userId: string,
    options: { mfaVerified: boolean; userAgent: string | null; ipHash: string | null },
  ): Promise<IssuedSession> {
    const now = Date.now();
    const refreshToken = this.crypto.randomToken();
    const refreshTokenExpiresAt = new Date(now + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS);
    const session = await this.prisma.session.create({
      data: {
        userId,
        expiresAt: new Date(now + this.config.SESSION_ABSOLUTE_TTL_DAYS * DAY_MS),
        mfaVerifiedAt: options.mfaVerified ? new Date(now) : null,
        userAgent: options.userAgent?.slice(0, 256) ?? null,
        ipHash: options.ipHash,
        refreshTokens: {
          create: { tokenHash: this.crypto.sha256(refreshToken), expiresAt: refreshTokenExpiresAt },
        },
      },
      select: { id: true, expiresAt: true },
    });
    const access = await this.issueAccessToken(userId, session.id);
    return {
      sessionId: session.id,
      ...access,
      refreshToken,
      refreshTokenExpiresAt: minDate(refreshTokenExpiresAt, session.expiresAt),
    };
  }

  async issueAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
    const claims: AccessClaims = { sub: userId, sid: sessionId, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000),
    };
  }

  /**
   * Rotates a refresh token. Presenting a token that was already used means it was copied:
   * the whole session (token family) is revoked.
   */
  async rotate(rawToken: string): Promise<IssuedSession & { userId: string }> {
    const tokenHash = this.crypto.sha256(rawToken);
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: { select: { id: true, status: true } } } } },
    });
    if (!token) throw ApiError.unauthenticated();
    const { session } = token;
    const now = new Date();

    if (token.usedAt) {
      await this.revokeSessions([session.id], 'refresh_token_reuse');
      throw ApiError.unauthenticated(
        'Your session ended for security reasons. Please sign in again.',
      );
    }
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      token.expiresAt <= now ||
      session.user.status !== 'ACTIVE'
    ) {
      throw ApiError.unauthenticated();
    }

    const refreshToken = this.crypto.randomToken();
    const refreshTokenExpiresAt = minDate(
      new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      session.expiresAt,
    );
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent refreshes with the same token cannot both win.
      const consumed = await tx.refreshToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          sessionId: session.id,
          tokenHash: this.crypto.sha256(refreshToken),
          expiresAt: refreshTokenExpiresAt,
        },
      });
      await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: now } });
      return true;
    });
    if (!rotated) {
      await this.revokeSessions([session.id], 'refresh_token_reuse');
      throw ApiError.unauthenticated(
        'Your session ended for security reasons. Please sign in again.',
      );
    }

    const access = await this.issueAccessToken(session.userId, session.id);
    return {
      userId: session.userId,
      sessionId: session.id,
      ...access,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  /** Authenticates an access token against the live session and user state. */
  async authenticate(
    accessToken: string,
    context: { requestId: string | null; ipHash: string | null },
  ): Promise<Actor> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(accessToken, { algorithms: ['HS256'] });
    } catch {
      throw ApiError.unauthenticated();
    }
    if (claims.typ !== 'access' || !claims.sid || !claims.sub) throw ApiError.unauthenticated();

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
        mfaVerifiedAt: true,
        user: { select: { status: true, kind: true, mustChangePassword: true } },
      },
    });
    const now = new Date();
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE'
    ) {
      throw ApiError.unauthenticated();
    }

    if (now.getTime() - session.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      // Best-effort activity tracking; never fails the request.
      void this.prisma.session
        .update({ where: { id: claims.sid }, data: { lastUsedAt: now } })
        .catch(() => undefined);
      void this.prisma.user
        .update({ where: { id: claims.sub }, data: { lastActiveAt: now } })
        .catch(() => undefined);
    }

    return {
      userId: claims.sub,
      sessionId: claims.sid,
      kind: session.user.kind,
      mfaVerified: !this.config.MFA_REQUIRED_FOR_PRIVILEGED || session.mfaVerifiedAt !== null,
      mustChangePassword: session.user.mustChangePassword,
      requestId: context.requestId,
      ipHash: context.ipHash,
    };
  }

  async markMfaVerified(sessionId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).session.update({
      where: { id: sessionId },
      data: { mfaVerifiedAt: new Date() },
    });
  }

  async issueMfaToken(userId: string): Promise<string> {
    const claims: MfaClaims = { sub: userId, typ: 'mfa' };
    // A unique id per sign-in attempt, so each attempt has its own token and guess budget.
    return this.jwt.signAsync(claims, {
      expiresIn: 300,
      jwtid: this.crypto.randomToken().slice(0, 22),
    });
  }

  async verifyMfaToken(token: string): Promise<string> {
    try {
      const claims = await this.jwt.verifyAsync<MfaClaims>(token, { algorithms: ['HS256'] });
      if (claims.typ !== 'mfa') throw new Error('wrong token type');
      return claims.sub;
    } catch {
      throw ApiError.unauthenticated('Your sign-in attempt expired. Please start again.');
    }
  }

  /** Revokes sessions and disconnects their sockets (via the outbox). */
  async revokeSessions(sessionIds: string[], reason: string): Promise<void> {
    if (sessionIds.length === 0) return;
    const event = await this.prisma.$transaction((tx) =>
      this.revokeSessionsTx(tx, sessionIds, reason),
    );
    if (event) await this.outbox.dispatch([event]);
  }

  async revokeSessionsTx(
    tx: Tx,
    sessionIds: string[],
    reason: string,
  ): Promise<PendingOutboxEvent | null> {
    if (sessionIds.length === 0) return null;
    await tx.session.updateMany({
      where: { id: { in: sessionIds }, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason.slice(0, 64) },
    });
    // A signed-out device must stop receiving notifications immediately.
    await tx.device.updateMany({
      where: { sessionId: { in: sessionIds } },
      data: { pushProvider: null, pushTokenEnc: null, pushTokenHash: null },
    });
    return this.outbox.add(tx, 'session.revoked', { sessionIds, reason }, null);
  }

  /** Revoke every active session of a user, optionally keeping one (e.g. after password change). */
  async revokeAllForUserTx(
    tx: Tx,
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<PendingOutboxEvent | null> {
    const sessions = await tx.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true },
    });
    return this.revokeSessionsTx(
      tx,
      sessions.map((s) => s.id),
      reason,
    );
  }
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
