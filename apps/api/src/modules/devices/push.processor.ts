import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { resolveBusinessPolicy, type PushPayload } from '@storeline/shared';
import { Worker } from 'bullmq';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { metrics } from '../../infra/metrics/metrics';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { PUSH_QUEUE, type PushJobData } from '../outbox/outbox.types';
import { PushGateway } from './push-gateway';

const PREVIEW_MAX = 120;
const CATEGORY_LABEL = {
  MEDICAL: 'Medical emergency',
  SECURITY: 'Security emergency',
  FIRE: 'Fire or hazard',
  OTHER: 'Emergency',
} as const;

export const pushTokenAad = (deviceId: string) => `push:${deviceId}`;

/**
 * Sends push notifications to people who are not connected (worker). Messages respect the
 * user's preferences, conversation mutes and the business's lock-screen policy: by default no
 * message content leaves the server. Emergency alerts always notify registered devices.
 */
@Injectable()
export class PushProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PushProcessor.name);
  private worker: Worker<PushJobData> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly gateway: PushGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<PushJobData>(PUSH_QUEUE, (job) => this.process(job.data), {
      connection: this.redis.createConnection('push-worker', { forBullMq: true }),
      concurrency: 8,
    });
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'Push worker error'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async process(data: PushJobData): Promise<{ sent: number; skipped: number }> {
    return data.kind === 'message'
      ? this.message(data.messageId, data.userIds)
      : this.emergency(data.incidentId, data.userIds);
  }

  private async message(messageId: string, userIds: string[]) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        seq: true,
        kind: true,
        body: true,
        deletedAt: true,
        conversationId: true,
        sender: { select: { displayName: true } },
        conversation: {
          select: {
            type: true,
            title: true,
            business: { select: { policy: true } },
            members: {
              where: { userId: { in: userIds }, leftAt: null },
              select: { userId: true, mutedUntil: true, historyFromSeq: true, lastReadSeq: true },
            },
          },
        },
      },
    });
    if (!message || message.deletedAt || message.kind === 'SYSTEM') return { sent: 0, skipped: 0 };
    const now = new Date();
    const eligible = message.conversation.members
      .filter(
        (m) =>
          m.historyFromSeq < message.seq &&
          m.lastReadSeq < message.seq &&
          !(m.mutedUntil && m.mutedUntil > now),
      )
      .map((m) => m.userId);
    const offline = await this.offline(eligible);
    const contentAllowed = resolveBusinessPolicy(
      message.conversation.business.policy,
    ).pushContentAllowed;
    const title =
      message.conversation.type === 'DIRECT'
        ? message.sender.displayName
        : `${message.sender.displayName} · ${message.conversation.title ?? 'Group'}`;
    const text =
      message.kind === 'TEXT'
        ? (message.body ?? '')
        : `${message.kind === 'IMAGE' ? 'Photo' : message.kind === 'VIDEO' ? 'Video' : 'Document'}${message.body ? `: ${message.body}` : ''}`;

    return this.deliver(offline, false, (preview): PushPayload => {
      const effective = preview === 'CONTENT' && !contentAllowed ? 'SENDER' : preview;
      return {
        type: 'message',
        title: effective === 'NONE' ? 'SMA' : title,
        body:
          effective === 'CONTENT'
            ? text.length > PREVIEW_MAX
              ? `${text.slice(0, PREVIEW_MAX - 1)}…`
              : text
            : 'New message',
        url: `/chats?c=${message.conversationId}`,
        conversationId: message.conversationId,
        tag: `c-${message.conversationId.slice(0, 8)}`,
      };
    });
  }

  private async emergency(incidentId: string, userIds: string[]) {
    const incident = await this.prisma.emergencyIncident.findUnique({
      where: { id: incidentId },
      select: { status: true, category: true, level: true, store: { select: { name: true } } },
    });
    if (!incident || !['OPEN', 'ESCALATED'].includes(incident.status))
      return { sent: 0, skipped: 0 };
    // Everyone alerted, online or not: a phone in a pocket must ring too.
    return this.deliver(userIds, true, () => ({
      type: 'emergency',
      title: incident.level > 1 ? 'Emergency — escalated to you' : 'Emergency alert',
      body: `${CATEGORY_LABEL[incident.category]} at ${incident.store.name}`,
      url: `/emergency?id=${incidentId}`,
      incidentId,
      tag: `e-${incidentId.slice(0, 8)}`,
    }));
  }

  /** Users with no live socket on any API instance (presence is advisory, not a guarantee). */
  private async offline(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    try {
      const pipeline = this.redis.client.pipeline();
      for (const id of userIds) pipeline.scard(`presence:${id}`);
      const counts = (await pipeline.exec()) ?? [];
      return userIds.filter((_, i) => Number(counts[i]?.[1] ?? 0) === 0);
    } catch {
      return userIds; // Presence unknown: better a duplicate notification than a missed one.
    }
  }

  private async deliver(
    userIds: string[],
    emergency: boolean,
    build: (preview: 'NONE' | 'SENDER' | 'CONTENT') => PushPayload,
  ): Promise<{ sent: number; skipped: number }> {
    if (userIds.length === 0) return { sent: 0, skipped: 0 };
    const devices = await this.prisma.device.findMany({
      where: {
        userId: { in: userIds },
        pushTokenEnc: { not: null },
        session: { revokedAt: null, expiresAt: { gt: new Date() } },
        user: {
          status: 'ACTIVE',
          ...(emergency
            ? {}
            : { OR: [{ notificationPrefs: null }, { notificationPrefs: { pushEnabled: true } }] }),
        },
      },
      select: {
        id: true,
        pushProvider: true,
        pushTokenEnc: true,
        user: { select: { notificationPrefs: { select: { preview: true } } } },
      },
    });
    let sent = 0;
    let skipped = 0;
    for (const device of devices) {
      if (!device.pushProvider || !this.gateway.enabled(device.pushProvider)) {
        skipped += 1;
        continue;
      }
      const payload = build(device.user.notificationPrefs?.preview ?? 'NONE');
      try {
        const outcome = await this.gateway.send(
          {
            provider: device.pushProvider,
            token: this.crypto.decrypt(device.pushTokenEnc!, pushTokenAad(device.id)),
          },
          payload,
          { urgency: emergency ? 'high' : 'normal', ttlSeconds: emergency ? 3600 : 24 * 3600 },
        );
        if (outcome === 'gone') {
          await this.prisma.device.update({
            where: { id: device.id },
            data: {
              pushProvider: null,
              pushTokenEnc: null,
              pushTokenHash: null,
              lastPushError: 'subscription_gone',
            },
          });
          metrics.pushNotifications.inc({ provider: device.pushProvider, outcome: 'gone' });
          continue;
        }
        await this.prisma.device.update({
          where: { id: device.id },
          data: { lastPushAt: new Date(), lastPushError: null },
        });
        metrics.pushNotifications.inc({ provider: device.pushProvider, outcome: 'sent' });
        sent += 1;
      } catch (error) {
        // One unreachable device must not block the others; the error is recorded per device.
        metrics.pushNotifications.inc({ provider: device.pushProvider, outcome: 'failed' });
        await this.prisma.device
          .update({
            where: { id: device.id },
            data: { lastPushError: String((error as Error).message ?? error).slice(0, 120) },
          })
          .catch(() => undefined);
      }
    }
    return { sent, skipped };
  }
}
