import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { metrics } from '../../infra/metrics/metrics';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { PushGateway } from '../devices/push-gateway';
import { EmergencyQueryService } from '../emergency/emergency-query.service';
import { ConversationQueryService } from '../messaging/conversation-query.service';
import { messageInclude, toMessageDto } from '../messaging/mappers';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import {
  DELIVERY_JOB_OPTIONS,
  DELIVERY_QUEUE,
  type DeliveryJobData,
  type OutboxEventPayloads,
  type OutboxEventType,
  type PushJobData,
} from './outbox.types';
import { OutboxService } from './outbox.service';

const CONCURRENCY = 16;

/** Thrown for events that can never succeed; they are failed immediately instead of retried. */
class PermanentDeliveryError extends Error {}

/**
 * Consumes outbox events and pushes them to connected devices. Recipients are resolved from
 * the database at delivery time (current active members only, ADR-0004). Handlers are
 * idempotent: a re-run re-emits the same ids, which clients de-duplicate.
 */
@Injectable()
export class DeliveryProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryProcessor.name);
  private worker: Worker<DeliveryJobData> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeEmitter,
    private readonly conversations: ConversationQueryService,
    private readonly emergency: EmergencyQueryService,
    private readonly outbox: OutboxService,
    private readonly push: PushGateway,
  ) {}

  /** Hands a notification to the push queue (best effort; never fails the delivery job). */
  private async enqueuePush(data: PushJobData, jobId: string): Promise<void> {
    if (data.userIds.length === 0 || !this.push.enabled('WEB_PUSH')) return;
    try {
      await this.outbox.pushQueue.add(data.kind, data, { jobId });
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not enqueue push notification');
    }
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker<DeliveryJobData>(DELIVERY_QUEUE, (job) => this.process(job), {
      connection: this.redis.createConnection('delivery-worker', { forBullMq: true }),
      concurrency: CONCURRENCY,
    });
    this.worker.on('failed', (job, error) => void this.onFailed(job, error));
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'Delivery worker error'));
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful: waits for in-flight jobs to finish.
    await this.worker?.close();
  }

  async process(job: Pick<Job<DeliveryJobData>, 'data' | 'name'>): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: job.data.outboxId },
      select: { type: true, payload: true, createdAt: true },
    });
    if (!event) throw new PermanentDeliveryError(`Outbox event ${job.data.outboxId} not found`);
    await this.handle(event);
    metrics.deliveryJobs.inc({ type: event.type, outcome: 'success' });
    metrics.deliveryLatency.observe(
      { type: event.type },
      (Date.now() - event.createdAt.getTime()) / 1000,
    );
  }

  private async handle(event: { type: string; payload: unknown }): Promise<void> {
    const type = event.type as OutboxEventType;
    switch (type) {
      case 'message.created':
        return this.messageCreated(event.payload as OutboxEventPayloads['message.created']);
      case 'message.updated':
        return this.messageUpdated(event.payload as OutboxEventPayloads['message.updated']);
      case 'conversation.updated':
        return this.conversationUpdated(
          event.payload as OutboxEventPayloads['conversation.updated'],
        );
      case 'conversation.removed':
        return this.conversationRemoved(
          event.payload as OutboxEventPayloads['conversation.removed'],
        );
      case 'session.revoked': {
        const payload = event.payload as OutboxEventPayloads['session.revoked'];
        this.realtime.disconnectSessions(payload.sessionIds, payload.reason);
        return;
      }
      case 'emergency.notify':
        return this.emergencyNotify(event.payload as OutboxEventPayloads['emergency.notify']);
      case 'emergency.updated':
        return this.emergencyUpdated(event.payload as OutboxEventPayloads['emergency.updated']);
      default:
        throw new PermanentDeliveryError(`Unknown outbox event type ${String(type)}`);
    }
  }

  private async messageCreated({
    messageId,
  }: OutboxEventPayloads['message.created']): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: messageInclude,
    });
    if (!message) throw new PermanentDeliveryError(`Message ${messageId} not found`);
    const recipients = await this.activeMemberIds(message.conversationId, message.seq);
    // Emit the persisted message first, then record that it reached the gateway.
    this.realtime.toUsers(recipients, 'message.created', toMessageDto(message));
    if (message.kind !== 'SYSTEM')
      await this.enqueuePush(
        {
          kind: 'message',
          messageId,
          userIds: recipients.filter((id) => id !== message.senderId),
        },
        `push-m-${messageId}`,
      );
    const { count } = await this.prisma.message.updateMany({
      where: { id: messageId, state: { in: ['ACCEPTED', 'FAILED'] } },
      data: { state: 'DISPATCHED', failureReason: null },
    });
    if (count > 0 && message.kind !== 'SYSTEM') {
      this.realtime.toUsers([message.senderId], 'message.status_changed', {
        conversationId: message.conversationId,
        messageId,
        seq: message.seq,
        state: 'DISPATCHED',
      });
    }
  }

  private async messageUpdated({
    messageId,
  }: OutboxEventPayloads['message.updated']): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: messageInclude,
    });
    if (!message) throw new PermanentDeliveryError(`Message ${messageId} not found`);
    const recipients = await this.activeMemberIds(message.conversationId, message.seq);
    this.realtime.toUsers(recipients, 'message.updated', toMessageDto(message));
  }

  private async conversationUpdated({
    conversationId,
  }: OutboxEventPayloads['conversation.updated']): Promise<void> {
    const summaries = await this.conversations.summariesForAllMembers(conversationId);
    for (const { userId, summary } of summaries) {
      this.realtime.toUsers([userId], 'conversation.updated', summary);
    }
  }

  private async conversationRemoved({
    conversationId,
    userIds,
  }: OutboxEventPayloads['conversation.removed']): Promise<void> {
    // Only notify users who are (still) not members — they may have been re-added since.
    const stillMembers = await this.prisma.conversationMember.findMany({
      where: { conversationId, userId: { in: userIds }, leftAt: null },
      select: { userId: true },
    });
    const active = new Set(stillMembers.map((m) => m.userId));
    this.realtime.toUsers(
      userIds.filter((id) => !active.has(id)),
      'conversation.removed',
      { conversationId },
    );
  }

  /**
   * Pushes the alert to the people being alerted, then records SENT_TO_GATEWAY. Delivery to a
   * device is only recorded when that device confirms it (POST /emergency/incidents/:id/receipt).
   */
  private async emergencyNotify({
    incidentId,
    userIds,
  }: OutboxEventPayloads['emergency.notify']): Promise<void> {
    const incident = await this.emergency.incidentDto(incidentId);
    if (!incident) throw new PermanentDeliveryError(`Incident ${incidentId} not found`);
    // Closed before the alert went out: nothing to alert about any more.
    if (incident.status === 'RESOLVED' || incident.status === 'CANCELLED') return;
    const pending = await this.prisma.emergencyIncidentRecipient.findMany({
      where: { incidentId, userId: { in: userIds }, state: { in: ['QUEUED', 'FAILED'] } },
      select: { userId: true },
    });
    if (pending.length === 0) return;
    const recipients = pending.map((r) => r.userId);
    this.realtime.toUsers(recipients, 'emergency.alert_created', incident);
    await this.enqueuePush(
      { kind: 'emergency', incidentId, userIds: recipients },
      `push-e-${incidentId}-${incident.level}`,
    );
    const { count } = await this.prisma.emergencyIncidentRecipient.updateMany({
      where: { incidentId, userId: { in: recipients }, state: { in: ['QUEUED', 'FAILED'] } },
      data: { state: 'SENT_TO_GATEWAY', sentAt: new Date(), failedAt: null, failureReason: null },
    });
    if (count > 0) await this.emergencyUpdated({ incidentId });
  }

  private async emergencyUpdated({
    incidentId,
  }: OutboxEventPayloads['emergency.updated']): Promise<void> {
    const row = await this.prisma.emergencyIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, businessId: true, storeId: true, reporterId: true },
    });
    if (!row) throw new PermanentDeliveryError(`Incident ${incidentId} not found`);
    const [incident, audience] = await Promise.all([
      this.emergency.incidentDto(incidentId),
      this.emergency.audience(row),
    ]);
    if (incident) this.realtime.toUsers(audience, 'emergency.incident_updated', incident);
  }

  /** Members allowed to see a message with this seq right now. */
  private async activeMemberIds(conversationId: string, seq: number): Promise<string[]> {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, leftAt: null, historyFromSeq: { lt: seq } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /** Dead-letter handling: after the final attempt the outbox row and message are marked FAILED. */
  private async onFailed(job: Job<DeliveryJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const permanent = error instanceof PermanentDeliveryError;
    if (permanent) await job.discard();
    const finalAttempt =
      permanent || job.attemptsMade >= (job.opts.attempts ?? DELIVERY_JOB_OPTIONS.attempts);
    metrics.deliveryJobs.inc({ type: job.name, outcome: finalAttempt ? 'dead_letter' : 'retry' });
    this.logger.error(
      {
        err: error,
        outboxId: job.data.outboxId,
        type: job.name,
        attempt: job.attemptsMade,
        final: finalAttempt,
      },
      'Delivery job failed',
    );
    if (!finalAttempt) return;
    try {
      const event = await this.prisma.outboxEvent.update({
        where: { id: job.data.outboxId },
        data: { status: 'FAILED', lastError: error.message.slice(0, 500) },
        select: { type: true, payload: true },
      });
      if (event.type === 'message.created') {
        const { messageId } = event.payload as OutboxEventPayloads['message.created'];
        const message = await this.prisma.message.update({
          where: { id: messageId },
          data: { state: 'FAILED', failureReason: 'delivery_failed' },
          select: { senderId: true, conversationId: true, seq: true },
        });
        this.realtime.toUsers([message.senderId], 'message.status_changed', {
          conversationId: message.conversationId,
          messageId,
          seq: message.seq,
          state: 'FAILED',
        });
      } else if (event.type === 'emergency.notify') {
        // Escalation continues regardless (the sweeper is DB-driven); record the failure honestly.
        const { incidentId, level, userIds } =
          event.payload as OutboxEventPayloads['emergency.notify'];
        await this.prisma.emergencyIncidentRecipient.updateMany({
          where: { incidentId, userId: { in: userIds }, state: 'QUEUED' },
          data: { state: 'FAILED', failedAt: new Date(), failureReason: 'gateway_unavailable' },
        });
        await this.prisma.emergencyIncidentEvent.create({
          data: { incidentId, type: 'NOTIFY_FAILED', level, userIds },
        });
      }
    } catch (dlqError) {
      this.logger.error(
        { err: dlqError, outboxId: job.data.outboxId },
        'Failed to record dead-lettered event',
      );
    }
  }
}
