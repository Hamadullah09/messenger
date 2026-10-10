import { Injectable } from '@nestjs/common';
import type {
  DeviceDto,
  NotificationConfigDto,
  NotificationPreferences,
  RegisterDeviceRequest,
  RegisterPushRequest,
} from '@storeline/shared';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { SessionService } from '../auth/session.service';
import { PushGateway } from './push-gateway';
import { pushTokenAad } from './push.processor';

/**
 * Devices are the client side of a session (docs/architecture/clients.md): one device per
 * session, owned by the session's user. Push tokens are encrypted at rest and bound to the
 * device; signing out (or any session revocation) removes them.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly gateway: PushGateway,
  ) {}

  config(): NotificationConfigDto {
    return {
      providers: {
        WEB_PUSH: this.gateway.enabled('WEB_PUSH'),
        FCM: this.gateway.enabled('FCM'),
        APNS: this.gateway.enabled('APNS'),
      },
      webPushPublicKey: this.gateway.webPushPublicKey,
    };
  }

  /** Registers (or updates) the device behind the caller's current session. Idempotent. */
  async register(actor: Actor, request: RegisterDeviceRequest): Promise<DeviceDto> {
    await this.prisma.device.upsert({
      where: { sessionId: actor.sessionId },
      create: {
        userId: actor.userId,
        sessionId: actor.sessionId,
        platform: request.platform,
        name: request.name,
        appVersion: request.appVersion ?? null,
      },
      update: {
        platform: request.platform,
        name: request.name,
        appVersion: request.appVersion ?? null,
      },
    });
    return this.current(actor);
  }

  async list(actor: Actor): Promise<DeviceDto[]> {
    const rows = await this.prisma.device.findMany({
      where: { userId: actor.userId, session: { revokedAt: null, expiresAt: { gt: new Date() } } },
      include: { session: { select: { lastUsedAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((d) => this.toDto(d, actor));
  }

  /** Signs the device out: revokes its session, closes its sockets and drops its push token. */
  async revoke(actor: Actor, deviceId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId: actor.userId },
      select: { sessionId: true },
    });
    if (!device) throw ApiError.notFound('Device');
    await this.sessions.revokeSessions([device.sessionId], 'user_signed_out_device');
    await this.audit.recordSafely(actor, {
      action: 'device.revoked',
      targetType: 'Device',
      targetId: deviceId,
    });
  }

  async registerPush(actor: Actor, request: RegisterPushRequest): Promise<DeviceDto> {
    const device = await this.prisma.device.findUnique({
      where: { sessionId: actor.sessionId },
      select: { id: true },
    });
    if (!device) throw ApiError.conflict('Register this device first (POST /devices).');
    if (!this.gateway.enabled(request.provider))
      throw ApiError.conflict('This server cannot send notifications to that kind of device yet.');

    let token: string;
    let identity: string;
    if (request.provider === 'WEB_PUSH') {
      try {
        this.gateway.assertAllowedEndpoint(request.subscription.endpoint);
      } catch {
        throw ApiError.validation('This push service is not allowed.', 'subscription.endpoint');
      }
      token = JSON.stringify(request.subscription);
      identity = request.subscription.endpoint;
    } else {
      token = request.token;
      identity = request.token;
    }
    const hash = this.crypto.keyedHash(`${request.provider}:${identity}`);
    await this.prisma.$transaction(async (tx) => {
      // The same browser/app may re-register under a new session: keep one registration.
      await tx.device.updateMany({
        where: { pushTokenHash: hash, id: { not: device.id } },
        data: { pushProvider: null, pushTokenEnc: null, pushTokenHash: null },
      });
      await tx.device.update({
        where: { id: device.id },
        data: {
          pushProvider: request.provider,
          pushTokenEnc: this.crypto.encrypt(token, pushTokenAad(device.id)),
          pushTokenHash: hash,
          pushUpdatedAt: new Date(),
          lastPushError: null,
        },
      });
    });
    await this.audit.recordSafely(actor, {
      action: 'device.push_registered',
      targetType: 'Device',
      targetId: device.id,
      metadata: { provider: request.provider },
    });
    return this.current(actor);
  }

  async clearPush(actor: Actor): Promise<void> {
    await this.prisma.device.updateMany({
      where: { sessionId: actor.sessionId, userId: actor.userId },
      data: { pushProvider: null, pushTokenEnc: null, pushTokenHash: null },
    });
  }

  async preferences(actor: Actor): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId: actor.userId },
      select: { pushEnabled: true, preview: true },
    });
    return row ?? { pushEnabled: true, preview: 'NONE' };
  }

  async updatePreferences(
    actor: Actor,
    request: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId: actor.userId },
      create: { userId: actor.userId, ...request },
      update: request,
      select: { pushEnabled: true, preview: true },
    });
    return row;
  }

  private async current(actor: Actor): Promise<DeviceDto> {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { sessionId: actor.sessionId },
      include: { session: { select: { lastUsedAt: true } } },
    });
    return this.toDto(device, actor);
  }

  private toDto(
    d: {
      id: string;
      platform: DeviceDto['platform'];
      name: string;
      appVersion: string | null;
      pushProvider: 'WEB_PUSH' | 'FCM' | 'APNS' | null;
      pushUpdatedAt: Date | null;
      sessionId: string;
      createdAt: Date;
      session: { lastUsedAt: Date };
    },
    actor: Actor,
  ): DeviceDto {
    return {
      id: d.id,
      platform: d.platform,
      name: d.name,
      appVersion: d.appVersion,
      push: d.pushProvider
        ? { provider: d.pushProvider, updatedAt: d.pushUpdatedAt?.toISOString() ?? null }
        : null,
      sessionId: d.sessionId,
      lastUsedAt: d.session.lastUsedAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      current: d.sessionId === actor.sessionId,
    };
  }
}
