import { Injectable, Logger } from '@nestjs/common';
import { resolveBusinessPolicy, type PresenceDto } from '@storeline/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { RealtimeEmitter } from './realtime-emitter.service';

const PRESENCE_TTL_SECONDS = 90;
const key = (userId: string): string => `presence:${userId}`;

/**
 * Ephemeral presence in Redis: a set of live socket ids per user with a TTL refreshed by
 * heartbeats, so a crashed node's sockets expire on their own. Presence is a UX hint only
 * and is visible solely to people who share a direct conversation with the user (docs D8).
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async connected(userId: string, socketId: string): Promise<void> {
    const [[, added], , [, size]] = (await this.redis.client
      .multi()
      .sadd(key(userId), socketId)
      .expire(key(userId), PRESENCE_TTL_SECONDS)
      .scard(key(userId))
      .exec()) as [[null, number], [null, number], [null, number]];
    if (added === 1 && size === 1) await this.broadcast(userId, true, null);
  }

  async disconnected(userId: string, socketId: string): Promise<void> {
    const [, [, size]] = (await this.redis.client
      .multi()
      .srem(key(userId), socketId)
      .scard(key(userId))
      .exec()) as [[null, number], [null, number]];
    if (size === 0) {
      const now = new Date();
      await this.prisma.user
        .update({ where: { id: userId }, data: { lastActiveAt: now } })
        .catch(() => undefined);
      await this.broadcast(userId, false, now);
    }
  }

  /** Called periodically for every socket connected to this node. */
  async heartbeat(entries: Array<{ userId: string; socketId: string }>): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const { userId, socketId } of entries) {
      pipeline.sadd(key(userId), socketId).expire(key(userId), PRESENCE_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  /** Presence of users who share a direct conversation with the viewer; others are omitted. */
  async lookup(viewerId: string, userIds: string[]): Promise<PresenceDto[]> {
    const allowed = await this.prisma.conversationMember.findMany({
      where: {
        userId: { in: userIds },
        leftAt: null,
        conversation: {
          type: 'DIRECT',
          members: { some: { userId: viewerId, leftAt: null } },
          business: { status: 'ACTIVE' },
        },
      },
      select: {
        userId: true,
        user: { select: { lastActiveAt: true } },
        conversation: { select: { business: { select: { policy: true } } } },
      },
    });
    const visible = new Map<string, Date | null>();
    for (const row of allowed) {
      if (resolveBusinessPolicy(row.conversation.business.policy).presenceEnabled) {
        visible.set(row.userId, row.user.lastActiveAt);
      }
    }
    const ids = [...visible.keys()];
    if (ids.length === 0) return [];
    const pipeline = this.redis.client.pipeline();
    ids.forEach((id) => pipeline.scard(key(id)));
    const results = (await pipeline.exec()) ?? [];
    return ids.map((id, i) => {
      const online = Number(results[i]?.[1] ?? 0) > 0;
      return {
        userId: id,
        online,
        lastSeenAt: online ? null : (visible.get(id)?.toISOString() ?? null),
      };
    });
  }

  private async broadcast(userId: string, online: boolean, lastSeenAt: Date | null): Promise<void> {
    try {
      const counterparts = await this.prisma.conversationMember.findMany({
        where: {
          userId: { not: userId },
          leftAt: null,
          conversation: { type: 'DIRECT', members: { some: { userId, leftAt: null } } },
        },
        select: { userId: true },
        take: 2000,
      });
      this.realtime.toUsers(
        counterparts.map((c) => c.userId),
        'presence.changed',
        { userId, online, lastSeenAt: lastSeenAt?.toISOString() ?? null },
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Presence broadcast failed');
    }
  }
}
