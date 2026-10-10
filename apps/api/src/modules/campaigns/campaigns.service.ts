import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  campaignAudienceSchema,
  LARGE_CAMPAIGN_THRESHOLD,
  resolveBusinessPolicy,
  type CampaignAudience,
  type CampaignCountsDto,
  type CampaignDeliveryBucket,
  type CampaignDto,
  type CampaignPreviewDto,
  type CampaignRecipientDto,
  type CampaignSuppressionDto,
  type CreateCampaignRequest,
  type ListCampaignRecipientsQuery,
  type Page,
  type PaginationQuery,
  type ScheduleCampaignRequest,
  type SendCampaignRequest,
  type UpdateCampaignRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { mediaAssetSelect, toMediaAssetDto } from '../media/media.mapper';
import { OutboxService } from '../outbox/outbox.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { bucketSql, previewSql, recipientJoinsSql, type CampaignScope } from './campaign-audience';

const campaignInclude = {
  createdBy: { select: publicUserSelect },
  media: { select: mediaAssetSelect },
  business: { select: { policy: true, status: true } },
} as const satisfies Prisma.BulkCampaignInclude;

type CampaignRow = Prisma.BulkCampaignGetPayload<{ include: typeof campaignInclude }>;

const EDITABLE = ['DRAFT'] as const;
const CANCELLABLE = ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'] as const;
const EXPORT_CHUNK = 5000;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Bulk campaigns (docs/architecture/campaigns.md). This service only manages state; delivery
 * happens in the worker (CampaignDispatcher). Audiences are resolved on the server and never
 * leave the business; previews return counts, not people.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ───────────────────────────── Authorization ─────────────────────────────

  /**
   * Where the actor may run campaigns in this business. Platform-wide grants are ignored:
   * campaigns are tenant operations. MFA is enforced through authz.require.
   */
  async scope(actor: Actor, businessId: string): Promise<CampaignScope> {
    const coverage = await this.authz.coverage(actor, 'bulk_message.send');
    const businessWide = !coverage.all && coverage.businessIds.has(businessId);
    const storeIds = coverage.all
      ? []
      : [...coverage.stores.entries()].filter(([, b]) => b === businessId).map(([s]) => s);
    if (!businessWide && storeIds.length === 0) throw ApiError.notFound('Business');
    await this.authz.require(
      actor,
      'bulk_message.send',
      businessWide ? { businessId } : { businessId, storeId: storeIds[0]! },
    );
    return { businessId, businessWide, storeIds };
  }

  /** Business-wide managers see every campaign; store-scoped ones only their own. */
  private async requireCampaign(actor: Actor, campaignId: string) {
    const row = await this.prisma.bulkCampaign.findUnique({
      where: { id: campaignId },
      include: campaignInclude,
    });
    if (!row || row.business.status !== 'ACTIVE') throw ApiError.notFound('Campaign');
    let scope: CampaignScope;
    try {
      scope = await this.scope(actor, row.businessId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND')
        throw ApiError.notFound('Campaign');
      throw error;
    }
    if (!scope.businessWide && row.createdById !== actor.userId)
      throw ApiError.notFound('Campaign');
    return { row, scope };
  }

  /** Store-scoped senders may only target their own stores and groups in them. */
  private async validateAudience(audience: CampaignAudience, scope: CampaignScope) {
    const { businessId } = scope;
    if (audience.storeIds.length) {
      const stores = await this.prisma.store.count({
        where: { id: { in: audience.storeIds }, businessId, status: 'ACTIVE' },
      });
      if (stores !== audience.storeIds.length)
        throw ApiError.validation('One of the stores was not found.', 'audience.storeIds');
    }
    if (audience.groupIds.length) {
      const groups = await this.prisma.conversation.findMany({
        where: { id: { in: audience.groupIds }, businessId, type: 'GROUP', archivedAt: null },
        select: { storeId: true },
      });
      if (groups.length !== audience.groupIds.length)
        throw ApiError.validation('One of the groups was not found.', 'audience.groupIds');
      if (
        !scope.businessWide &&
        groups.some((g) => !g.storeId || !scope.storeIds.includes(g.storeId))
      )
        throw ApiError.forbidden('You can only message groups in your stores.');
    }
    if (!scope.businessWide) {
      if (audience.everyone)
        throw ApiError.forbidden('You can only send campaigns to your own stores.');
      if (audience.storeIds.some((id) => !scope.storeIds.includes(id)))
        throw ApiError.forbidden('You can only send campaigns to your own stores.');
    }
  }

  private async validateMedia(
    campaignId: string | null,
    mediaId: string | null | undefined,
    requireReady: boolean,
  ) {
    if (!mediaId) return;
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { campaignId: true, status: true },
    });
    if (!media || !campaignId || media.campaignId !== campaignId)
      throw ApiError.validation('Attach a file uploaded to this campaign.', 'mediaId');
    if (requireReady && media.status !== 'READY')
      throw ApiError.conflict(
        media.status === 'VERIFYING' || media.status === 'PENDING_UPLOAD'
          ? 'The attachment is still being checked. Try again in a moment.'
          : 'The attachment could not be used. Remove it or upload another file.',
      );
    if (['QUARANTINED', 'REJECTED', 'FAILED'].includes(media.status))
      throw ApiError.validation('The attachment could not be used.', 'mediaId');
  }

  // ───────────────────────────── CRUD ─────────────────────────────

  async create(actor: Actor, request: CreateCampaignRequest): Promise<CampaignDto> {
    const existing = await this.prisma.bulkCampaign.findUnique({
      where: {
        createdById_clientCampaignId: {
          createdById: actor.userId,
          clientCampaignId: request.clientCampaignId,
        },
      },
      select: { id: true },
    });
    if (existing) return this.get(actor, existing.id);
    const business = await this.prisma.business.findUnique({
      where: { id: request.businessId },
      select: { status: true },
    });
    if (!business) throw ApiError.notFound('Business');
    const scope = await this.scope(actor, request.businessId);
    if (business.status !== 'ACTIVE') throw ApiError.conflict('This business is not active.');
    if (request.mediaId)
      throw ApiError.validation('Save the campaign first, then attach a file.', 'mediaId');
    await this.validateAudience(request.audience, scope);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.bulkCampaign.create({
          data: {
            businessId: request.businessId,
            createdById: actor.userId,
            clientCampaignId: request.clientCampaignId,
            name: request.name,
            description: request.description ?? null,
            body: request.body ?? null,
            audience: request.audience as Prisma.InputJsonValue,
            expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
          },
          select: { id: true },
        });
        await this.audit.record(
          actor,
          {
            action: 'campaign.created',
            businessId: request.businessId,
            targetType: 'BulkCampaign',
            targetId: row.id,
          },
          tx,
        );
        return row;
      });
      return this.get(actor, created.id);
    } catch (error) {
      if (isUniqueViolation(error)) return this.create(actor, request);
      throw error;
    }
  }

  async update(
    actor: Actor,
    campaignId: string,
    request: UpdateCampaignRequest,
  ): Promise<CampaignDto> {
    const { row, scope } = await this.requireCampaign(actor, campaignId);
    if (!(EDITABLE as readonly string[]).includes(row.status))
      throw ApiError.conflict('Only draft campaigns can be edited.');
    if (request.audience) await this.validateAudience(request.audience, scope);
    await this.validateMedia(campaignId, request.mediaId, false);
    const body = request.body === undefined ? row.body : request.body;
    const mediaId = request.mediaId === undefined ? row.mediaId : request.mediaId;
    if (!body && !mediaId) throw ApiError.validation('Write a message or attach a file.', 'body');
    const { count } = await this.prisma.bulkCampaign.updateMany({
      where: { id: campaignId, status: 'DRAFT' },
      data: {
        name: request.name,
        description: request.description,
        body: request.body,
        mediaId: request.mediaId,
        audience: request.audience ? (request.audience as Prisma.InputJsonValue) : undefined,
        expiresAt:
          request.expiresAt === undefined
            ? undefined
            : request.expiresAt
              ? new Date(request.expiresAt)
              : null,
      },
    });
    if (count === 0) throw ApiError.conflict('Only draft campaigns can be edited.');
    await this.audit.record(actor, {
      action: 'campaign.updated',
      businessId: row.businessId,
      targetType: 'BulkCampaign',
      targetId: campaignId,
    });
    return this.get(actor, campaignId);
  }

  async list(actor: Actor, businessId: string, query: PaginationQuery): Promise<Page<CampaignDto>> {
    const scope = await this.scope(actor, businessId);
    const rows = await this.prisma.bulkCampaign.findMany({
      where: { businessId, ...(scope.businessWide ? {} : { createdById: actor.userId }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
      include: campaignInclude,
    });
    const page = rows.slice(0, query.limit);
    const items = await Promise.all(page.map((row) => this.toDto(row)));
    return { items, nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null };
  }

  async get(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    return this.toDto(row);
  }

  async preview(actor: Actor, campaignId: string): Promise<CampaignPreviewDto> {
    const { row, scope } = await this.requireCampaign(actor, campaignId);
    return this.previewFor(row, scope);
  }

  private async previewFor(row: CampaignRow, scope: CampaignScope): Promise<CampaignPreviewDto> {
    const audience = campaignAudienceSchema.parse(row.audience);
    const [counts, quota] = await Promise.all([
      this.prisma.$queryRaw<Array<{ recipients: number; suppressed: number }>>(
        previewSql(audience, scope, row.createdById),
      ),
      this.prisma.tenantQuota.findUnique({
        where: { businessId: row.businessId },
        select: { maxCampaignSize: true },
      }),
    ]);
    const recipients = counts[0]?.recipients ?? 0;
    return {
      recipients,
      suppressed: counts[0]?.suppressed ?? 0,
      requiresConfirmation: recipients > LARGE_CAMPAIGN_THRESHOLD,
      maxRecipients: quota?.maxCampaignSize ?? 100_000,
    };
  }

  // ───────────────────────────── State machine ─────────────────────────────

  /** Checks content, quota and (for large audiences) the sender's confirmation. */
  private async readyToSend(actor: Actor, campaignId: string, request: SendCampaignRequest) {
    const { row, scope } = await this.requireCampaign(actor, campaignId);
    if (!row.body && !row.mediaId)
      throw ApiError.validation('Write a message or attach a file.', 'body');
    await this.validateMedia(campaignId, row.mediaId, true);
    await this.validateAudience(campaignAudienceSchema.parse(row.audience), scope);
    const preview = await this.previewFor(row, scope);
    if (preview.recipients === 0) throw ApiError.conflict('No one matches this audience.');
    if (preview.recipients > preview.maxRecipients)
      throw ApiError.conflict(
        `This campaign would reach ${preview.recipients} people; your limit is ${preview.maxRecipients}.`,
      );
    if (preview.requiresConfirmation && request.confirmRecipientCount !== preview.recipients)
      throw new ApiError(
        'CONFLICT',
        `This campaign will reach ${preview.recipients} people. Confirm the number to continue.`,
        [{ path: 'confirmRecipientCount', message: String(preview.recipients) }],
      );
    return { row, preview };
  }

  async send(actor: Actor, campaignId: string, request: SendCampaignRequest): Promise<CampaignDto> {
    const { row, preview } = await this.readyToSend(actor, campaignId, request);
    await this.transition(
      actor,
      row,
      ['DRAFT', 'SCHEDULED'],
      'campaign.started',
      {
        status: 'SENDING',
        startedAt: new Date(),
        scheduledAt: null,
        confirmedCount: preview.requiresConfirmation ? preview.recipients : null,
      },
      { recipients: preview.recipients, trigger: 'manual' },
    );
    return this.get(actor, campaignId);
  }

  async schedule(
    actor: Actor,
    campaignId: string,
    request: ScheduleCampaignRequest,
  ): Promise<CampaignDto> {
    const at = new Date(request.scheduledAt);
    if (at.getTime() < Date.now() + 60_000)
      throw ApiError.validation('Schedule at least one minute ahead, or send now.', 'scheduledAt');
    const { row, preview } = await this.readyToSend(actor, campaignId, request);
    await this.transition(
      actor,
      row,
      ['DRAFT'],
      'campaign.scheduled',
      {
        status: 'SCHEDULED',
        scheduledAt: at,
        confirmedCount: preview.requiresConfirmation ? preview.recipients : null,
      },
      { scheduledAt: at.toISOString(), recipients: preview.recipients },
    );
    return this.get(actor, campaignId);
  }

  async unschedule(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    await this.transition(actor, row, ['SCHEDULED'], 'campaign.unscheduled', {
      status: 'DRAFT',
      scheduledAt: null,
    });
    return this.get(actor, campaignId);
  }

  async pause(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    await this.transition(actor, row, ['SENDING'], 'campaign.paused', {
      status: 'PAUSED',
      pausedAt: new Date(),
    });
    return this.get(actor, campaignId);
  }

  async resume(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    await this.transition(actor, row, ['PAUSED'], 'campaign.resumed', {
      status: 'SENDING',
      pausedAt: null,
    });
    return this.get(actor, campaignId);
  }

  /** Stops anything not yet sent. Messages already delivered stay in recipients' channels. */
  async cancel(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.bulkCampaign.updateMany({
        where: { id: campaignId, status: { in: [...CANCELLABLE] } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (count === 0)
        throw ApiError.conflict(`A ${row.status.toLowerCase()} campaign cannot be cancelled.`);
      const cancelled = await tx.bulkCampaignRecipient.updateMany({
        where: { campaignId, state: 'PENDING' },
        data: { state: 'CANCELLED', processedAt: new Date() },
      });
      await this.audit.record(
        actor,
        {
          action: 'campaign.cancelled',
          businessId: row.businessId,
          targetType: 'BulkCampaign',
          targetId: campaignId,
          metadata: { from: row.status, cancelledRecipients: cancelled.count },
        },
        tx,
      );
    });
    return this.get(actor, campaignId);
  }

  /**
   * Retries failures without duplicates: failed writes go back to the queue; dead-lettered
   * deliveries are replayed from their original outbox event (same message id).
   */
  async retryFailed(actor: Actor, campaignId: string): Promise<CampaignDto> {
    const { row } = await this.requireCampaign(actor, campaignId);
    if (!['SENDING', 'PAUSED', 'COMPLETED'].includes(row.status))
      throw ApiError.conflict('Only started campaigns can retry failures.');
    const replay = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o."id" FROM "OutboxEvent" o
        JOIN "Message" m ON m."id" = (o."payload"->>'messageId')::uuid
        JOIN "BulkCampaignRecipient" r ON r."messageId" = m."id"
       WHERE r."campaignId" = ${campaignId}::uuid AND m."state" = 'FAILED'
         AND o."type" = 'message.created' AND o."status" = 'FAILED'`;
    // The dead-lettered BullMQ job keeps its id; remove it so the relay can enqueue again.
    for (const { id } of replay) await (await this.outbox.queue.getJob(id))?.remove();
    const result = await this.prisma.$transaction(async (tx) => {
      const requeued = await tx.bulkCampaignRecipient.updateMany({
        where: { campaignId, state: 'FAILED', NOT: { reason: 'attachment_unavailable' } },
        data: { state: 'PENDING', reason: null, processedAt: null },
      });
      if (replay.length) {
        const ids = replay.map((r) => r.id);
        await tx.outboxEvent.updateMany({
          where: { id: { in: ids }, status: 'FAILED' },
          data: { status: 'PENDING', attempts: 0, availableAt: new Date(), lastError: null },
        });
        await tx.$executeRaw`
          UPDATE "Message" SET "state" = 'ACCEPTED', "failureReason" = NULL
           WHERE "id" IN (SELECT (o."payload"->>'messageId')::uuid FROM "OutboxEvent" o WHERE o."id" = ANY(${ids}::uuid[]))`;
      }
      if (requeued.count > 0 && row.status === 'COMPLETED') {
        await tx.bulkCampaign.update({
          where: { id: campaignId },
          data: { status: 'SENDING', completedAt: null },
        });
      }
      await this.audit.record(
        actor,
        {
          action: 'campaign.retried',
          businessId: row.businessId,
          targetType: 'BulkCampaign',
          targetId: campaignId,
          metadata: { requeued: requeued.count, replayed: replay.length },
        },
        tx,
      );
      return requeued.count + replay.length;
    });
    if (result === 0) throw ApiError.conflict('There are no failures that can be retried.');
    return this.get(actor, campaignId);
  }

  private async transition(
    actor: Actor,
    row: CampaignRow,
    from: Array<CampaignRow['status']>,
    action: string,
    data: Prisma.BulkCampaignUpdateManyMutationInput,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.bulkCampaign.updateMany({
        where: { id: row.id, status: { in: from } },
        data,
      });
      if (count === 0)
        throw ApiError.conflict(
          `This campaign is ${row.status.toLowerCase()}; that is not possible now.`,
        );
      await this.audit.record(
        actor,
        {
          action,
          businessId: row.businessId,
          targetType: 'BulkCampaign',
          targetId: row.id,
          metadata,
        },
        tx,
      );
    });
  }

  // ───────────────────────────── Reporting ─────────────────────────────

  async counts(row: { id: string; business: { policy: unknown } }): Promise<CampaignCountsDto> {
    const readReceipts = resolveBusinessPolicy(row.business.policy).readReceiptsEnabled;
    const rows = await this.prisma.$queryRaw<Array<{ bucket: CampaignDeliveryBucket; n: number }>>`
      SELECT ${bucketSql(readReceipts)} AS "bucket", count(*)::int AS "n"
        ${recipientJoinsSql}
       WHERE r."campaignId" = ${row.id}::uuid
       GROUP BY 1`;
    const counts: CampaignCountsDto = {
      total: 0,
      readReceipts,
      QUEUED: 0,
      ACCEPTED: 0,
      SENT_TO_GATEWAY: 0,
      DELIVERED: 0,
      READ: 0,
      FAILED: 0,
      SKIPPED: 0,
      CANCELLED: 0,
    };
    for (const { bucket, n } of rows) {
      counts[bucket] = n;
      counts.total += n;
    }
    return counts;
  }

  async recipients(
    actor: Actor,
    campaignId: string,
    query: ListCampaignRecipientsQuery,
  ): Promise<Page<CampaignRecipientDto>> {
    const { row } = await this.requireCampaign(actor, campaignId);
    const items = await this.recipientRows(
      row,
      query.status ?? null,
      query.cursor ?? null,
      query.limit,
    );
    return {
      items: items.slice(0, query.limit),
      nextCursor: items.length > query.limit ? items[query.limit - 1]!.user.id : null,
    };
  }

  private async recipientRows(
    row: CampaignRow,
    status: CampaignDeliveryBucket | null,
    after: string | null,
    limit: number,
  ): Promise<CampaignRecipientDto[]> {
    const readReceipts = resolveBusinessPolicy(row.business.policy).readReceiptsEnabled;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        username: string;
        displayName: string;
        kind: 'INTERNAL' | 'EXTERNAL';
        status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
        bucket: CampaignDeliveryBucket;
        reason: string | null;
        processedAt: Date | null;
      }>
    >`
      SELECT * FROM (
        SELECT u."id", u."username", u."displayName", u."kind"::text AS "kind", u."status"::text AS "status",
               ${bucketSql(readReceipts)} AS "bucket", r."reason", r."processedAt"
          ${recipientJoinsSql}
          JOIN "User" u ON u."id" = r."userId"
         WHERE r."campaignId" = ${row.id}::uuid
           AND (${after}::uuid IS NULL OR r."userId" > ${after}::uuid)
      ) x
      WHERE (${status}::text IS NULL OR x."bucket" = ${status}::text)
      ORDER BY x."id"
      LIMIT ${limit + 1}`;
    return rows.map((r) => ({
      user: toPublicUser({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        kind: r.kind,
        status: r.status,
      }),
      status: r.bucket,
      reason: r.reason,
      processedAt: iso(r.processedAt),
    }));
  }

  /** CSV delivery report, streamed in chunks. Needs report.export; every export is audited. */
  async exportCsv(
    actor: Actor,
    campaignId: string,
    write: (chunk: string) => void,
  ): Promise<string> {
    const { row } = await this.requireCampaign(actor, campaignId);
    await this.authz.require(actor, 'report.export', { businessId: row.businessId });
    write('username,display_name,status,reason,processed_at\r\n');
    let after: string | null = null;
    let total = 0;
    for (;;) {
      const chunk = await this.recipientRows(row, null, after, EXPORT_CHUNK);
      const page = chunk.slice(0, EXPORT_CHUNK);
      write(
        page
          .map((r) =>
            [r.user.username, r.user.displayName, r.status, r.reason ?? '', r.processedAt ?? '']
              .map(csvCell)
              .join(','),
          )
          .map((line) => line + '\r\n')
          .join(''),
      );
      total += page.length;
      if (chunk.length <= EXPORT_CHUNK) break;
      after = page[page.length - 1]!.user.id;
    }
    await this.audit.record(actor, {
      action: 'campaign.report.exported',
      businessId: row.businessId,
      targetType: 'BulkCampaign',
      targetId: campaignId,
      metadata: { rows: total },
    });
    return `campaign-${row.name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'report'}.csv`;
  }

  private async toDto(row: CampaignRow): Promise<CampaignDto> {
    const started = !['DRAFT', 'SCHEDULED'].includes(row.status) || row.materializedAt !== null;
    return {
      id: row.id,
      businessId: row.businessId,
      name: row.name,
      description: row.description,
      body: row.body,
      media: row.media ? toMediaAssetDto(row.media) : null,
      audience: campaignAudienceSchema.parse(row.audience),
      status: row.status,
      scheduledAt: iso(row.scheduledAt),
      expiresAt: iso(row.expiresAt),
      startedAt: iso(row.startedAt),
      pausedAt: iso(row.pausedAt),
      completedAt: iso(row.completedAt),
      cancelledAt: iso(row.cancelledAt),
      createdBy: toPublicUser(row.createdBy),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      totalRecipients: row.totalRecipients,
      counts: started ? await this.counts(row) : null,
    };
  }

  // ───────────────────────────── Suppression and opt-out ─────────────────────────────

  async listSuppressions(actor: Actor, businessId: string): Promise<CampaignSuppressionDto[]> {
    await this.requireBusinessWide(actor, businessId);
    const rows = await this.prisma.campaignSuppression.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { reason: true, createdAt: true, user: { select: publicUserSelect } },
    });
    return rows.map((r) => ({
      user: toPublicUser(r.user),
      reason: r.reason as CampaignSuppressionDto['reason'],
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async suppress(actor: Actor, businessId: string, userId: string): Promise<void> {
    await this.requireBusinessWide(actor, businessId);
    const member = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { id: true },
    });
    if (!member) throw ApiError.notFound('User');
    await this.prisma.campaignSuppression.upsert({
      where: { businessId_userId: { businessId, userId } },
      create: { businessId, userId, reason: 'ADMIN', createdById: actor.userId },
      update: {},
    });
    await this.audit.record(actor, {
      action: 'campaign.suppression.added',
      businessId,
      targetType: 'User',
      targetId: userId,
    });
  }

  async unsuppress(actor: Actor, businessId: string, userId: string): Promise<void> {
    await this.requireBusinessWide(actor, businessId);
    // A person's own opt-out can only be withdrawn by them.
    const { count } = await this.prisma.campaignSuppression.deleteMany({
      where: { businessId, userId, reason: 'ADMIN' },
    });
    if (count === 0) throw ApiError.notFound('Suppression');
    await this.audit.record(actor, {
      action: 'campaign.suppression.removed',
      businessId,
      targetType: 'User',
      targetId: userId,
    });
  }

  private async requireBusinessWide(actor: Actor, businessId: string): Promise<void> {
    const scope = await this.scope(actor, businessId);
    if (!scope.businessWide)
      throw ApiError.forbidden('Only business-wide campaign managers can do this.');
  }

  /** Customers (external users) can stop announcements from a business; staff cannot. */
  async optOutStatus(
    actor: Actor,
    businessId: string,
  ): Promise<{ optedOut: boolean; canOptOut: boolean }> {
    await this.requireMembership(actor, businessId);
    const row = await this.prisma.campaignSuppression.findUnique({
      where: { businessId_userId: { businessId, userId: actor.userId } },
      select: { reason: true },
    });
    return { optedOut: !!row, canOptOut: actor.kind === 'EXTERNAL' };
  }

  async setOptOut(
    actor: Actor,
    businessId: string,
    optOut: boolean,
  ): Promise<{ optedOut: boolean; canOptOut: boolean }> {
    await this.requireMembership(actor, businessId);
    if (actor.kind !== 'EXTERNAL')
      throw ApiError.forbidden('Staff announcements cannot be turned off. Ask your administrator.');
    if (optOut) {
      await this.prisma.campaignSuppression.upsert({
        where: { businessId_userId: { businessId, userId: actor.userId } },
        create: {
          businessId,
          userId: actor.userId,
          reason: 'SELF_OPT_OUT',
          createdById: actor.userId,
        },
        update: {},
      });
    } else {
      await this.prisma.campaignSuppression.deleteMany({
        where: { businessId, userId: actor.userId, reason: 'SELF_OPT_OUT' },
      });
    }
    await this.audit.record(actor, {
      action: optOut ? 'campaign.opt_out' : 'campaign.opt_in',
      businessId,
      targetType: 'User',
      targetId: actor.userId,
    });
    return this.optOutStatus(actor, businessId);
  }

  private async requireMembership(actor: Actor, businessId: string): Promise<void> {
    const member = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId: actor.userId } },
      select: { status: true },
    });
    if (member?.status !== 'ACTIVE') throw ApiError.notFound('Business');
  }
}

/** RFC 4180 quoting, plus a leading quote on formula-like cells (spreadsheet injection). */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
