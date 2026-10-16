import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { resolveBusinessPolicy, type PushPayload } from '@storeline/shared';
import { Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { metrics } from '../../infra/metrics/metrics';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { PUSH_QUEUE, type PushJobData } from '../outbox/outbox.types';
import { PushGateway } from './push-gateway';
import { callDeclineToken } from '../calls/call-tokens';
import { kindPreview } from '../messaging/mappers';

const PREVIEW_MAX = 120;
const CATEGORY_LABEL = {
  MEDICAL: 'Medical emergency',
  SECURITY: 'Security emergency',
  FIRE: 'Fire or hazard',
  THEFT: 'Theft or robbery',
  VIOLENCE: 'Threat or violence',
  ACCIDENT: 'Accident or injury',
  GAS_LEAK: 'Gas leak or chemical spill',
  POWER_FAILURE: 'Power or building failure',
  NATURAL_DISASTER: 'Earthquake, flood or storm',
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
    if (data.kind === 'call') return this.call(data.callId, data.userIds, data.event);
    if (data.kind === 'notice')
      return this.deliver(
        data.userIds,
        false,
        (): PushPayload => ({
          type: 'reminder',
          title: data.title,
          body: data.body,
          url: data.url,
          tag: data.tag,
        }),
        { urgency: 'high', ttlSeconds: 24 * 3600 },
      );
    return data.kind === 'message'
      ? this.message(data.messageId, data.userIds)
      : this.emergency(data.incidentId, data.userIds);
  }

  /**
   * Calls: "X is calling" with Answer / Decline to people whose app is closed (an open app
   * rings by itself), then "Missed call" or a silent clear when the call is over.
   */
  private async call(callId: string, userIds: string[], event: 'ring' | 'missed' | 'ended') {
    const raw = await this.redis.client.get(`call:${callId}`);
    if (!raw) return { sent: 0, skipped: 0 };
    const call = JSON.parse(raw) as {
      id: string;
      media: 'audio' | 'video';
      group: boolean;
      title: string | null;
      caller: { displayName: string };
      state: string;
    };
    if (event === 'ring' && call.state === 'ended') return { sent: 0, skipped: 0 };
    // Ringing only where the app is closed (an open app rings by itself); missed and clears go
    // everywhere, so a phone that rang stops ringing.
    const targets = event === 'ring' ? await this.offline(userIds) : userIds;
    const kind = call.media === 'video' ? 'video' : 'voice';
    const who = call.group
      ? `${call.caller.displayName} · ${call.title ?? 'Group'}`
      : call.caller.displayName;
    const tag = `call-${callId.slice(0, 8)}`;
    return this.deliver(
      targets,
      false,
      (preview, userId): PushPayload => {
        const named = preview !== 'NONE';
        if (event === 'ring')
          return {
            type: 'call',
            title: named ? who : 'SMA call',
            body: `Incoming ${call.group ? 'group ' : ''}${kind} call`,
            url: `/chats?call=${callId}`,
            callId,
            declineToken: call.group
              ? undefined
              : callDeclineToken(this.config.JWT_ACCESS_SECRET, callId, userId),
            userId: call.group ? undefined : userId,
            tag,
          };
        if (event === 'missed')
          return {
            type: 'message',
            title: 'Missed call',
            body: named ? `${who} · ${kind} call` : `Missed ${kind} call`,
            url: '/calls',
            tag,
          };
        return { type: 'call-ended', title: 'Call ended', body: '', url: '/calls', callId, tag };
      },
      // A ring is useless once the phone would have stopped ringing.
      event === 'ring'
        ? { urgency: 'high', ttlSeconds: 60 }
        : { urgency: 'high', ttlSeconds: 3600 },
    );
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
    // Calls notify through their own ring / missed-call notifications.
    if (!message || message.deletedAt || message.kind === 'SYSTEM' || message.kind === 'CALL')
      return { sent: 0, skipped: 0 };
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
    const text = kindPreview(message.kind, message.body) ?? '';

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

  /**
   * A reminder (e.g. a meeting with a lead in 15 minutes) to all of a person's devices, online
   * or not: it is about time, not about unread messages. Respects their push preferences.
   */
  reminder(
    userIds: string[],
    build: (preview: 'NONE' | 'SENDER' | 'CONTENT') => PushPayload,
  ): Promise<{ sent: number; skipped: number }> {
    // Useless once the meeting has started: dropped by the push service after 15 minutes.
    return this.deliver(userIds, false, build, { urgency: 'high', ttlSeconds: 15 * 60 });
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
    build: (preview: 'NONE' | 'SENDER' | 'CONTENT', userId: string) => PushPayload,
    options?: { urgency: 'normal' | 'high'; ttlSeconds: number },
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
        userId: true,
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
      const payload = build(device.user.notificationPrefs?.preview ?? 'NONE', device.userId);
      try {
        const outcome = await this.gateway.send(
          {
            provider: device.pushProvider,
            token: this.crypto.decrypt(device.pushTokenEnc!, pushTokenAad(device.id)),
          },
          payload,
          options ?? {
            urgency: emergency ? 'high' : 'normal',
            ttlSeconds: emergency ? 3600 : 24 * 3600,
          },
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
