import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { campaignAudienceSchema } from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { materializeSql, type CampaignScope } from './campaign-audience';
import { metrics } from '../../infra/metrics/metrics';

export interface DispatchResult {
  campaignId: string;
  sent: number;
  skipped: number;
  failed: number;
  completed: boolean;
}

interface LockedCampaign {
  id: string;
  businessId: string;
  createdById: string;
  body: string | null;
  mediaId: string | null;
  audience: unknown;
  expiresAt: Date | null;
  materializedAt: Date | null;
}

/**
 * Delivers campaigns in small, durable batches (docs/architecture/campaigns.md). Each batch is
 * one transaction under a campaign row lock (SKIP LOCKED, so several workers can run): it
 * writes each recipient's message into their announcements channel through the normal
 * MessageWriter + outbox path, and marks the recipient SENT. Nothing is delivered from an HTTP
 * request, and a crash mid-batch rolls back cleanly — the batch is simply picked up again.
 */
@Injectable()
export class CampaignDispatcher {
  private readonly logger = new Logger(CampaignDispatcher.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One scheduling round: start due scheduled campaigns, then serve each business with a
   * SENDING campaign once (least recently served first), within its per-minute quota.
   */
  async runOnce(now = new Date()): Promise<DispatchResult[]> {
    const due = await this.prisma.bulkCampaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
      select: { id: true, businessId: true },
      take: 100,
    });
    for (const c of due) {
      const { count } = await this.prisma.bulkCampaign.updateMany({
        where: { id: c.id, status: 'SCHEDULED' },
        data: { status: 'SENDING', startedAt: now },
      });
      if (count > 0)
        await this.audit.recordSafely(null, {
          action: 'campaign.started',
          businessId: c.businessId,
          targetType: 'BulkCampaign',
          targetId: c.id,
          metadata: { trigger: 'schedule' },
        });
    }

    const active = await this.prisma.bulkCampaign.findMany({
      where: { status: 'SENDING' },
      orderBy: [{ lastDispatchAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      select: { id: true, businessId: true, business: { select: { quota: true } } },
      take: 200,
    });
    const served = new Set<string>();
    const results: DispatchResult[] = [];
    for (const c of active) {
      if (served.has(c.businessId)) continue; // one batch per tenant per round: fairness
      served.add(c.businessId);
      const perMinute = c.business.quota?.messagesPerMinute ?? 3000;
      const budget = Math.max(
        1,
        Math.min(
          this.config.CAMPAIGN_BATCH_SIZE,
          Math.floor((perMinute * this.config.CAMPAIGN_DISPATCH_INTERVAL_MS) / 60_000),
        ),
      );
      try {
        const result = await this.dispatchBatch(c.id, budget, now);
        if (result) results.push(result);
      } catch (error) {
        this.logger.error({ err: error, campaignId: c.id }, 'Campaign batch failed');
      }
    }
    return results;
  }

  /** Processes up to `limit` recipients of one SENDING campaign. null if locked/not sending. */
  async dispatchBatch(
    campaignId: string,
    limit: number,
    now = new Date(),
  ): Promise<DispatchResult | null> {
    const picked: { userIds: string[] } = { userIds: [] };
    const batchTimer = metrics.campaignBatchDuration.startTimer();
    let result: { result: DispatchResult; events: PendingOutboxEvent[] } | null;
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          const campaign = await this.lock(tx, campaignId);
          if (!campaign) return null;
          if (!campaign.materializedAt) return this.materialize(tx, campaign, now);
          if (campaign.expiresAt && campaign.expiresAt <= now) {
            await tx.bulkCampaignRecipient.updateMany({
              where: { campaignId, state: 'PENDING' },
              data: { state: 'SKIPPED', reason: 'expired', processedAt: now },
            });
          }
          const batch = await tx.$queryRaw<Array<{ userId: string }>>`
            SELECT "userId" FROM "BulkCampaignRecipient"
             WHERE "campaignId" = ${campaignId}::uuid AND "state" = 'PENDING'
             ORDER BY "userId" LIMIT ${limit}`;
          picked.userIds = batch.map((r) => r.userId);
          return this.deliverTx(tx, campaign, picked.userIds, now);
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      // One bad recipient must not block everyone: retry the batch one recipient at a time.
      if (picked.userIds.length <= 1) throw error;
      this.logger.warn({ err: error, campaignId }, 'Campaign batch failed; retrying individually');
      result = await this.deliverIndividually(campaignId, picked.userIds, now);
    }
    if (!result) return null;
    metrics.campaignMessages.inc(result.result.sent);
    batchTimer();
    await this.outbox.dispatch(result.events);
    return result.result;
  }

  private async deliverIndividually(
    campaignId: string,
    userIds: string[],
    now: Date,
  ): Promise<{ result: DispatchResult; events: PendingOutboxEvent[] } | null> {
    const total: DispatchResult = { campaignId, sent: 0, skipped: 0, failed: 0, completed: false };
    const events: PendingOutboxEvent[] = [];
    for (const userId of userIds) {
      try {
        const one = await this.prisma.$transaction(async (tx) => {
          const campaign = await this.lock(tx, campaignId);
          return campaign ? this.deliverTx(tx, campaign, [userId], now) : null;
        });
        if (!one) return null;
        total.sent += one.result.sent;
        total.skipped += one.result.skipped;
        total.completed = one.result.completed;
        events.push(...one.events);
      } catch (error) {
        this.logger.error({ err: error, campaignId, userId }, 'Campaign recipient failed');
        await this.prisma.bulkCampaignRecipient.updateMany({
          where: { campaignId, userId, state: 'PENDING' },
          data: { state: 'FAILED', reason: 'write_failed', processedAt: now },
        });
        total.failed += 1;
      }
    }
    total.completed = await this.completeIfDone(this.prisma, campaignId, now);
    return { result: total, events };
  }

  private async lock(tx: Tx, campaignId: string): Promise<LockedCampaign | null> {
    const rows = await tx.$queryRaw<LockedCampaign[]>`
      SELECT "id", "businessId", "createdById", "body", "mediaId", "audience", "expiresAt", "materializedAt"
        FROM "BulkCampaign"
       WHERE "id" = ${campaignId}::uuid AND "status" = 'SENDING'
       FOR UPDATE SKIP LOCKED`;
    return rows[0] ?? null;
  }

  /** Resolves the audience once, when sending starts, into recipient rows. */
  private async materialize(
    tx: Tx,
    campaign: LockedCampaign,
    now: Date,
  ): Promise<{ result: DispatchResult; events: PendingOutboxEvent[] }> {
    const audience = campaignAudienceSchema.parse(campaign.audience);
    const scope = await this.creatorScope(tx, campaign);
    await tx.$executeRaw(materializeSql(campaign.id, audience, scope, campaign.createdById));
    const totalRecipients = await tx.bulkCampaignRecipient.count({
      where: { campaignId: campaign.id },
    });
    await tx.bulkCampaign.update({
      where: { id: campaign.id },
      data: { materializedAt: now, totalRecipients, lastDispatchAt: now },
    });
    const completed = await this.completeIfDone(tx, campaign.id, now);
    return {
      result: { campaignId: campaign.id, sent: 0, skipped: 0, failed: 0, completed },
      events: [],
    };
  }

  /** The sender's current reach: business-wide, or only their stores. */
  private async creatorScope(tx: Tx, campaign: LockedCampaign): Promise<CampaignScope> {
    const grants = await tx.roleAssignment.findMany({
      where: {
        userId: campaign.createdById,
        revokedAt: null,
        businessId: campaign.businessId,
        role: { permissions: { some: { permission: 'bulk_message.send' } } },
      },
      select: { scopeType: true, storeId: true },
    });
    return {
      businessId: campaign.businessId,
      businessWide: grants.some((g) => g.scopeType === 'BUSINESS'),
      storeIds: grants.flatMap((g) => (g.storeId ? [g.storeId] : [])),
    };
  }

  private async deliverTx(
    tx: Tx,
    campaign: LockedCampaign,
    userIds: string[],
    now: Date,
  ): Promise<{ result: DispatchResult; events: PendingOutboxEvent[] }> {
    const result: DispatchResult = {
      campaignId: campaign.id,
      sent: 0,
      skipped: 0,
      failed: 0,
      completed: false,
    };
    const events: PendingOutboxEvent[] = [];
    if (userIds.length > 0) {
      // Re-check at send time: people deactivated, removed or suppressed since the snapshot.
      const [eligible, suppressed, business, media] = await Promise.all([
        tx.user.findMany({
          where: {
            id: { in: userIds },
            status: 'ACTIVE',
            businessMemberships: { some: { businessId: campaign.businessId, status: 'ACTIVE' } },
          },
          select: { id: true },
        }),
        tx.campaignSuppression.findMany({
          where: { businessId: campaign.businessId, userId: { in: userIds } },
          select: { userId: true },
        }),
        tx.business.findUniqueOrThrow({
          where: { id: campaign.businessId },
          select: { name: true },
        }),
        campaign.mediaId
          ? tx.mediaAsset.findUnique({
              where: { id: campaign.mediaId },
              select: { id: true, kind: true, status: true },
            })
          : null,
      ]);
      const ok = new Set(eligible.map((u) => u.id));
      const blocked = new Set(suppressed.map((s) => s.userId));
      const skip = (reason: string, ids: string[]) =>
        ids.length
          ? tx.bulkCampaignRecipient.updateMany({
              where: { campaignId: campaign.id, userId: { in: ids }, state: 'PENDING' },
              data: { state: 'SKIPPED', reason, processedAt: now },
            })
          : null;
      const ineligible = userIds.filter((id) => !ok.has(id));
      const optedOut = userIds.filter((id) => ok.has(id) && blocked.has(id));
      await skip('no_longer_eligible', ineligible);
      await skip('suppressed', optedOut);
      result.skipped = ineligible.length + optedOut.length;

      const targets = userIds.filter((id) => ok.has(id) && !blocked.has(id));
      if (media && media.status !== 'READY') {
        // The attachment was removed or quarantined after scheduling: never send without it.
        await tx.bulkCampaignRecipient.updateMany({
          where: { campaignId: campaign.id, userId: { in: targets }, state: 'PENDING' },
          data: { state: 'FAILED', reason: 'attachment_unavailable', processedAt: now },
        });
        result.failed = targets.length;
      } else if (targets.length > 0) {
        const channels = await this.ensureChannels(
          tx,
          campaign,
          `Announcements · ${business.name}`,
          targets,
        );
        events.push(...channels.events);
        events.push(
          ...(await this.writeMessagesTx(tx, campaign, targets, channels.byUser, media, now)),
        );
        result.sent = targets.length;
      }
    }
    await tx.bulkCampaign.update({
      where: { id: campaign.id },
      data: { lastDispatchAt: now },
    });
    result.completed = await this.completeIfDone(tx, campaign.id, now);
    return { result, events };
  }

  /** One read-only BROADCAST channel per recipient and business, created on first use. */
  private async ensureChannels(
    tx: Tx,
    campaign: LockedCampaign,
    title: string,
    userIds: string[],
  ): Promise<{ byUser: Map<string, string>; events: PendingOutboxEvent[] }> {
    const keyOf = (userId: string) => `${campaign.businessId}:${userId}`;
    const existing = await tx.conversation.findMany({
      where: { channelKey: { in: userIds.map(keyOf) } },
      select: {
        id: true,
        channelKey: true,
        lastSeq: true,
        members: { select: { userId: true, leftAt: true } },
      },
    });
    const byUser = new Map<string, string>();
    const events: PendingOutboxEvent[] = [];
    for (const channel of existing) {
      const userId = channel.channelKey!.split(':')[1]!;
      byUser.set(userId, channel.id);
      const member = channel.members.find((m) => m.userId === userId);
      if (!member || member.leftAt) {
        // Re-joined the business: they see announcements from now on, not the old ones.
        await tx.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: channel.id, userId } },
          create: { conversationId: channel.id, userId, historyFromSeq: channel.lastSeq },
          update: { leftAt: null, historyFromSeq: channel.lastSeq, joinedAt: new Date() },
        });
        await tx.conversation.update({
          where: { id: channel.id },
          data: { memberCount: { increment: 1 } },
        });
      }
    }
    const missing = userIds
      .filter((id) => !byUser.has(id))
      .map((userId) => ({ userId, id: randomUUID(), outboxId: randomUUID() }));
    if (missing.length > 0) {
      await tx.conversation.createMany({
        data: missing.map((c) => ({
          id: c.id,
          businessId: campaign.businessId,
          type: 'BROADCAST' as const,
          channelKey: keyOf(c.userId),
          title: title.slice(0, 100),
          description: 'Announcements from your organisation. Replies are turned off.',
          postingPolicy: 'ADMINS_ONLY' as const,
          fileSharingPolicy: 'ADMINS_ONLY' as const,
          createdById: campaign.createdById,
          memberCount: 1,
        })),
      });
      await tx.conversationMember.createMany({
        data: missing.map((c) => ({
          conversationId: c.id,
          userId: c.userId,
          role: 'MEMBER' as const,
          addedById: campaign.createdById,
        })),
      });
      await tx.outboxEvent.createMany({
        data: missing.map((c) => ({
          id: c.outboxId,
          type: 'conversation.updated',
          payload: { conversationId: c.id },
          businessId: campaign.businessId,
        })),
      });
      for (const c of missing) {
        byUser.set(c.userId, c.id);
        events.push({ id: c.outboxId, type: 'conversation.updated' });
      }
    }
    return { byUser, events };
  }

  /**
   * Set-based equivalent of MessageWriter.create for one message per channel: allocates each
   * channel's next seq with a row-locking UPDATE (seq order = commit order, ADR-0003), then
   * inserts messages, attachments and outbox events and marks recipients SENT — a constant
   * number of statements per batch instead of several round trips per recipient.
   */
  private async writeMessagesTx(
    tx: Tx,
    campaign: LockedCampaign,
    userIds: string[],
    byUser: Map<string, string>,
    media: { id: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT' } | null,
    now: Date,
  ): Promise<PendingOutboxEvent[]> {
    const channelIds = userIds.map((u) => byUser.get(u)!);
    const seqs = await tx.$queryRaw<Array<{ id: string; lastSeq: number }>>`
      UPDATE "Conversation"
         SET "lastSeq" = "lastSeq" + 1, "lastActivityAt" = ${now}, "updatedAt" = ${now}
       WHERE "id" = ANY(${channelIds}::uuid[])
      RETURNING "id", "lastSeq"`;
    const seqOf = new Map(seqs.map((r) => [r.id, r.lastSeq]));
    const rows = userIds.map((userId) => {
      const conversationId = byUser.get(userId)!;
      return {
        userId,
        conversationId,
        seq: seqOf.get(conversationId)!,
        messageId: randomUUID(),
        outboxId: randomUUID(),
      };
    });
    await tx.message.createMany({
      data: rows.map((r) => ({
        id: r.messageId,
        conversationId: r.conversationId,
        seq: r.seq,
        senderId: campaign.createdById,
        clientMessageId: randomUUID(),
        kind: media ? media.kind : ('TEXT' as const),
        body: campaign.body,
        createdAt: now,
      })),
    });
    if (media) {
      await tx.messageAttachment.createMany({
        data: rows.map((r) => ({ messageId: r.messageId, mediaId: media.id, position: 0 })),
      });
    }
    const conversationIds = rows.map((r) => r.conversationId);
    const messageIds = rows.map((r) => r.messageId);
    await tx.$executeRaw`
      UPDATE "Conversation" c SET "lastMessageId" = v."mid"
        FROM unnest(${conversationIds}::uuid[], ${messageIds}::uuid[]) AS v("cid", "mid")
       WHERE c."id" = v."cid"`;
    await tx.outboxEvent.createMany({
      data: rows.map((r) => ({
        id: r.outboxId,
        type: 'message.created',
        payload: { messageId: r.messageId },
        businessId: campaign.businessId,
      })),
    });
    const recipientIds = rows.map((r) => r.userId);
    await tx.$executeRaw`
      UPDATE "BulkCampaignRecipient" r
         SET "state" = 'SENT', "messageId" = v."mid", "processedAt" = ${now}, "reason" = NULL
        FROM unnest(${recipientIds}::uuid[], ${messageIds}::uuid[]) AS v("uid", "mid")
       WHERE r."campaignId" = ${campaign.id}::uuid AND r."userId" = v."uid" AND r."state" = 'PENDING'`;
    return rows.map((r) => ({ id: r.outboxId, type: 'message.created' as const }));
  }

  private async completeIfDone(tx: Tx | PrismaService, campaignId: string, now: Date) {
    const pending = await tx.bulkCampaignRecipient.count({
      where: { campaignId, state: 'PENDING' },
    });
    if (pending > 0) return false;
    const { count } = await tx.bulkCampaign.updateMany({
      where: { id: campaignId, status: 'SENDING', materializedAt: { not: null } },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (count > 0) {
      const campaign = await tx.bulkCampaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { businessId: true, totalRecipients: true },
      });
      await tx.auditLog.create({
        data: {
          action: 'campaign.completed',
          businessId: campaign.businessId,
          targetType: 'BulkCampaign',
          targetId: campaignId,
          metadata: { totalRecipients: campaign.totalRecipients },
        },
      });
    }
    return true;
  }
}
