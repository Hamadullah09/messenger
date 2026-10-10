import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
  DELIVERY_JOB_OPTIONS,
  DELIVERY_QUEUE,
  MEDIA_JOB_OPTIONS,
  MEDIA_QUEUE,
  PUSH_JOB_OPTIONS,
  PUSH_QUEUE,
  queueFor,
  type PushJobData,
  type DeliveryJobData,
  type OutboxEventPayloads,
  type OutboxEventType,
} from './outbox.types';

/** Upper bound for the post-commit fast path before falling back to the relay. */
const DISPATCH_TIMEOUT_MS = 2000;

export interface PendingOutboxEvent {
  readonly id: string;
  readonly type: OutboxEventType;
}

/**
 * Transactional outbox (ADR-0002). `add` must be called inside the same transaction as the
 * state change. `dispatch` is a post-commit, best-effort fast path; the worker relay is the
 * guaranteed path for anything that is still PENDING.
 */
@Injectable()
export class OutboxService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  readonly queue: Queue<DeliveryJobData>;
  readonly mediaQueue: Queue<DeliveryJobData>;
  readonly pushQueue: Queue<PushJobData>;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
  ) {
    const connection = redis.createConnection('outbox-producer', {
      forBullMq: true,
      failFast: true,
    });
    this.queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
      connection,
      defaultJobOptions: DELIVERY_JOB_OPTIONS,
    });
    this.mediaQueue = new Queue<DeliveryJobData>(MEDIA_QUEUE, {
      connection,
      defaultJobOptions: MEDIA_JOB_OPTIONS,
    });
    this.pushQueue = new Queue<PushJobData>(PUSH_QUEUE, {
      connection,
      defaultJobOptions: PUSH_JOB_OPTIONS,
    });
  }

  async add<T extends OutboxEventType>(
    tx: Tx,
    type: T,
    payload: OutboxEventPayloads[T],
    businessId: string | null,
  ): Promise<PendingOutboxEvent> {
    const row = await tx.outboxEvent.create({
      data: { type, payload: payload as Prisma.InputJsonValue, businessId },
      select: { id: true },
    });
    return { id: row.id, type };
  }

  /** Enqueue committed events. Never throws: failures are left for the relay. */
  async dispatch(events: readonly PendingOutboxEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      // Bounded: a slow or unreachable Redis must never hold up the caller (the relay retries).
      await Promise.race([
        this.enqueue(events),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('enqueue timed out')), DISPATCH_TIMEOUT_MS).unref(),
        ),
      ]);
      await this.prisma.outboxEvent.updateMany({
        where: { id: { in: events.map((e) => e.id) }, status: 'PENDING' },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, count: events.length },
        'Outbox fast-path dispatch failed; relay will retry',
      );
    }
  }

  /** jobId = outbox id, so concurrent enqueues of the same event are deduplicated by BullMQ. */
  async enqueue(events: readonly PendingOutboxEvent[]): Promise<void> {
    const toJob = (event: PendingOutboxEvent) => ({
      name: event.type,
      data: { outboxId: event.id },
      opts: { jobId: event.id },
    });
    const delivery = events.filter((e) => queueFor(e.type) === DELIVERY_QUEUE);
    const media = events.filter((e) => queueFor(e.type) === MEDIA_QUEUE);
    if (delivery.length > 0) await this.queue.addBulk(delivery.map(toJob));
    if (media.length > 0) await this.mediaQueue.addBulk(media.map(toJob));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.queue.close(), this.mediaQueue.close(), this.pushQueue.close()]);
  }
}
