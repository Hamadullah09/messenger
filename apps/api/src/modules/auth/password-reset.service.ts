import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import type { ClientContext } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

const BRAND_NAME = 'SMA';
const INVALID_LINK = 'This reset link is invalid or has expired. Ask for a new one.';

/**
 * "Forgot password" by email. Requests always get the same answer and the work happens
 * after the response, so neither the reply nor its timing reveals whether an account exists.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async request(identifier: string, client: ClientContext): Promise<{ emailEnabled: boolean }> {
    await this.rateLimiter.consume(RATE_LIMITS.passwordResetPerIp, client.ipHash);
    await this.rateLimiter.consume(
      RATE_LIMITS.passwordResetPerIdentifier,
      this.crypto.keyedHash(identifier),
    );
    if (this.mail.enabled) {
      void this.issue(identifier, client).catch((error: unknown) =>
        this.logger.error(`Password reset request failed: ${(error as Error).message}`),
      );
    }
    return { emailEnabled: this.mail.enabled };
  }

  private async issue(identifier: string, client: ClientContext): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: identifier.includes('@')
        ? { contact: { email: identifier } }
        : { username: identifier },
      select: { id: true, status: true, displayName: true, contact: { select: { email: true } } },
    });
    const email = user?.contact?.email;
    if (!user || user.status !== 'ACTIVE' || !email) return;

    const token = this.crypto.randomToken(32);
    const ttl = this.config.PASSWORD_RESET_TTL_MINUTES;
    await this.prisma.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.crypto.sha256(token),
          expiresAt: new Date(Date.now() + ttl * 60_000),
          requestedIp: client.ipHash,
        },
      });
      await this.audit.record(
        { userId: null, requestId: client.requestId, ipHash: client.ipHash },
        { action: 'auth.password_reset_requested', targetType: 'User', targetId: user.id },
        tx,
      );
    });

    // The token travels in the URL fragment, which browsers never send to servers or in Referer.
    const link = `${this.config.WEB_APP_URL.replace(/\/$/, '')}/reset-password#token=${token}`;
    const name = escapeHtml(user.displayName);
    await this.mail.send({
      to: email,
      subject: `Reset your ${BRAND_NAME} password`,
      text: [
        `Hello ${user.displayName},`,
        '',
        `Someone asked to reset the password of your ${BRAND_NAME} account.`,
        `Open this link within ${ttl} minutes to choose a new password:`,
        link,
        '',
        'If this was not you, ignore this email. Your password stays the same.',
      ].join('\n'),
      html: `<p>Hello ${name},</p>
<p>Someone asked to reset the password of your ${BRAND_NAME} account.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#c2410c;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p>The link works once and expires in ${ttl} minutes.</p>
<p>If this was not you, ignore this email. Your password stays the same.</p>`,
    });
  }

  async reset(token: string, newPassword: string, client: ClientContext): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.passwordResetConfirmPerIp, client.ipHash);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.crypto.sha256(token) },
      select: {
        id: true,
        userId: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { status: true } },
      },
    });
    if (!row || row.usedAt || row.expiresAt <= new Date() || row.user.status !== 'ACTIVE') {
      throw ApiError.validation(INVALID_LINK, 'token');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    const event = await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent submissions cannot both use the link.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw ApiError.validation(INVALID_LINK, 'token');
      await tx.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.user.update({
        where: { id: row.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      // Opening the emailed link proves the address works.
      await tx.userContact.updateMany({
        where: { userId: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      await this.audit.record(
        { userId: row.userId, requestId: client.requestId, ipHash: client.ipHash },
        { action: 'auth.password_reset', targetType: 'User', targetId: row.userId },
        tx,
      );
      return this.sessions.revokeAllForUserTx(tx, row.userId, 'password_reset');
    });
    if (event) await this.outbox.dispatch([event]);
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
