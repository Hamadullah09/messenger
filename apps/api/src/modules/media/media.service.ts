import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  resolveBusinessPolicy,
  type CreateUploadRequest,
  type MediaAssetDto,
  type MediaMimeType,
  type MediaUrlDto,
  type UploadPartsDto,
  type UploadSessionDto,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { StorageService } from '../../infra/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { ConversationAccessService } from '../messaging/conversation-access.service';
import { canShareFiles } from '../messaging/mappers';
import { OutboxService } from '../outbox/outbox.service';
import {
  mediaAssetSelect,
  mediaKindOf,
  objectHeaders,
  sanitizeFileName,
  storageKeys,
  toMediaAssetDto,
} from './media.mapper';
import { metrics } from '../../infra/metrics/metrics';
import { visibleStatusWhere } from '../status/status-audience';

const MB = 1024 * 1024;
const UPLOAD_RATE_LIMIT = { name: 'media:upload', limit: 30, windowSeconds: 60 } as const;
const ACTIVE_STATUSES = ['PENDING_UPLOAD', 'VERIFYING', 'READY'] as const;
/** Conversations where every download is written to the audit log. */
const SENSITIVE_CATEGORIES = new Set(['SECURITY', 'EMERGENCY_RESPONSE']);

const KIND_LABEL = {
  IMAGE: 'Photos',
  VIDEO: 'Videos',
  DOCUMENT: 'Documents',
  AUDIO: 'Audio files',
} as const;

/**
 * Secure upload sessions and authorized downloads (docs/architecture/media.md). Bytes go
 * straight between the browser and private object storage; this service only issues
 * short-lived, size-bound URLs and enforces every rule server-side.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: ConversationAccessService,
    private readonly authz: AuthorizationService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async createUpload(actor: Actor, request: CreateUploadRequest): Promise<UploadSessionDto> {
    await this.rateLimiter.consume(UPLOAD_RATE_LIMIT, actor.userId);
    const context = await this.uploadContext(actor, request);

    const mimeType = request.mimeType as MediaMimeType;
    const kind = mediaKindOf(mimeType);
    const policy = resolveBusinessPolicy(context.policy);
    const policyMb = {
      IMAGE: policy.maxImageMb,
      VIDEO: policy.maxVideoMb,
      DOCUMENT: policy.maxDocumentMb,
      AUDIO: policy.maxVideoMb,
    }[kind];
    const maxMb = Math.min(policyMb, this.config.MEDIA_PLATFORM_MAX_MB);
    if (request.sizeBytes > maxMb * MB) {
      throw ApiError.validation(`${KIND_LABEL[kind]} can be at most ${maxMb} MB.`, 'sizeBytes');
    }

    const id = randomUUID();
    const fileName = sanitizeFileName(request.fileName);
    const incomingKey = storageKeys.incoming(context.businessId, id);
    const multipart = request.sizeBytes > this.config.MEDIA_MULTIPART_THRESHOLD_MB * MB;
    const partSize = this.config.MEDIA_PART_SIZE_MB * MB;
    const partCount = multipart ? Math.ceil(request.sizeBytes / partSize) : null;
    const uploadExpiresAt = new Date(Date.now() + this.config.MEDIA_UPLOAD_EXPIRY_HOURS * 3600_000);

    await this.prisma.$transaction(async (tx) => {
      // Serialise quota checks per business so concurrent uploads cannot overshoot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.businessId}, 0))`;
      const [quota, used] = await Promise.all([
        tx.tenantQuota.findUnique({
          where: { businessId: context.businessId },
          select: { maxStorageBytes: true },
        }),
        tx.mediaAsset.aggregate({
          where: { businessId: context.businessId, status: { in: [...ACTIVE_STATUSES] } },
          _sum: { sizeBytes: true },
        }),
      ]);
      const usedBytes = used._sum.sizeBytes ?? 0n;
      if (quota && usedBytes + BigInt(request.sizeBytes) > quota.maxStorageBytes) {
        throw ApiError.conflict(
          'Your business has used all of its file storage. Ask an administrator for more space.',
        );
      }
      await tx.mediaAsset.create({
        data: {
          id,
          businessId: context.businessId,
          conversationId: context.conversationId,
          campaignId: context.campaignId,
          forStatus: context.forStatus,
          forOps: context.forOps ?? false,
          uploaderId: actor.userId,
          kind,
          fileName,
          mimeType,
          sizeBytes: BigInt(request.sizeBytes),
          incomingKey,
          partSize: multipart ? partSize : null,
          partCount,
          uploadExpiresAt,
        },
      });
    });

    const headers = objectHeaders({ fileName, mimeType, kind });
    const ttl = this.config.MEDIA_UPLOAD_URL_TTL_SECONDS;
    const urlsExpireAt = new Date(Date.now() + ttl * 1000).toISOString();
    try {
      if (!multipart) {
        const url = await this.storage.presignPut(incomingKey, request.sizeBytes, headers, ttl);
        return {
          media: await this.dto(id),
          upload: {
            method: 'PUT',
            url,
            headers: {
              'Content-Type': headers.contentType,
              'Content-Disposition': headers.contentDisposition,
            },
          },
          urlsExpireAt,
        };
      }
      const uploadId = await this.storage.createMultipartUpload(incomingKey, headers);
      await this.prisma.mediaAsset.update({ where: { id }, data: { multipartUploadId: uploadId } });
      const numbers = Array.from({ length: partCount! }, (_, i) => i + 1);
      return {
        media: await this.dto(id),
        upload: {
          method: 'MULTIPART',
          partSize,
          partCount: partCount!,
          parts: await this.signParts(incomingKey, uploadId, numbers, request.sizeBytes, partSize),
        },
        urlsExpireAt,
      };
    } catch (error) {
      await this.prisma.mediaAsset.update({
        where: { id },
        data: { status: 'FAILED', failureReason: 'processing_failed' },
      });
      this.logger.error({ err: error, mediaId: id }, 'Could not start upload');
      throw new ApiError('INTERNAL', 'The upload could not be started. Please try again.');
    }
  }

  /** Fresh part URLs for a multipart upload — used to resume after a network drop or URL expiry. */
  async requestParts(
    actor: Actor,
    mediaId: string,
    partNumbers?: number[],
  ): Promise<UploadPartsDto> {
    const media = await this.pendingUpload(actor, mediaId);
    if (!media.multipartUploadId || !media.partSize || !media.partCount) {
      throw ApiError.validation('This upload is a single request; start a new upload instead.');
    }
    const uploaded = await this.storage.listParts(media.incomingKey, media.multipartUploadId);
    const done = new Set(uploaded.map((p) => p.PartNumber!));
    const wanted = (partNumbers ?? Array.from({ length: media.partCount }, (_, i) => i + 1)).filter(
      (n) => n >= 1 && n <= media.partCount! && (partNumbers ? true : !done.has(n)),
    );
    const ttl = this.config.MEDIA_UPLOAD_URL_TTL_SECONDS;
    return {
      uploadedPartNumbers: [...done].sort((a, b) => a - b),
      parts: await this.signParts(
        media.incomingKey,
        media.multipartUploadId,
        wanted,
        Number(media.sizeBytes),
        media.partSize,
      ),
      urlsExpireAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  /**
   * Finalises an upload: assembles multipart parts, verifies the stored size equals the
   * declared size, then queues verification (signature + malware scan) via the outbox.
   */
  async complete(actor: Actor, mediaId: string): Promise<MediaAssetDto> {
    const existing = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaId, uploaderId: actor.userId },
      select: { status: true },
    });
    if (!existing) throw ApiError.notFound('Upload');
    if (existing.status !== 'PENDING_UPLOAD') return this.dto(mediaId); // idempotent
    const media = await this.pendingUpload(actor, mediaId);

    if (media.multipartUploadId) {
      const parts = (await this.storage.listParts(media.incomingKey, media.multipartUploadId)).sort(
        (a, b) => a.PartNumber! - b.PartNumber!,
      );
      const total = Number(media.sizeBytes);
      const expectedParts = media.partCount!;
      const valid =
        parts.length === expectedParts &&
        parts.every((p, i) => {
          const expectedSize =
            i === expectedParts - 1
              ? total - media.partSize! * (expectedParts - 1)
              : media.partSize!;
          return p.PartNumber === i + 1 && p.Size === expectedSize;
        });
      if (!valid) {
        throw ApiError.validation(
          'Some parts of the file are missing. Resume the upload and try again.',
        );
      }
      await this.storage.completeMultipartUpload(media.incomingKey, media.multipartUploadId, parts);
    }

    const storedSize = await this.storage.objectSize(media.incomingKey);
    if (storedSize === null) throw ApiError.validation('The file has not been uploaded yet.');
    if (storedSize !== Number(media.sizeBytes)) {
      await this.storage.delete(media.incomingKey).catch(() => undefined);
      await this.prisma.mediaAsset.update({
        where: { id: mediaId },
        data: { status: 'FAILED', failureReason: 'size_mismatch' },
      });
      throw ApiError.validation(
        'The uploaded file does not match the expected size. Please try again.',
      );
    }

    const event = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.mediaAsset.updateMany({
        where: { id: mediaId, status: 'PENDING_UPLOAD' },
        data: { status: 'VERIFYING', multipartUploadId: null },
      });
      if (moved.count === 0) return null;
      return this.outbox.add(tx, 'media.uploaded', { mediaId }, media.businessId);
    });
    if (event) await this.outbox.dispatch([event]);
    return this.dto(mediaId);
  }

  async cancel(actor: Actor, mediaId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaId, uploaderId: actor.userId },
      select: { status: true, incomingKey: true, multipartUploadId: true },
    });
    if (!media) throw ApiError.notFound('Upload');
    if (media.status !== 'PENDING_UPLOAD') return;
    await this.discardIncoming(media);
    await this.prisma.mediaAsset.updateMany({
      where: { id: mediaId, status: 'PENDING_UPLOAD' },
      data: { status: 'FAILED', failureReason: 'cancelled', multipartUploadId: null },
    });
  }

  async get(actor: Actor, mediaId: string): Promise<MediaAssetDto> {
    await this.requireAccess(actor, mediaId, { allowUnverifiedForUploader: true });
    return this.dto(mediaId);
  }

  /** Short-lived URL, issued only after re-checking access. Sensitive conversations are audited. */
  async downloadUrl(
    actor: Actor,
    mediaId: string,
    variant: 'original' | 'thumbnail',
  ): Promise<MediaUrlDto> {
    const { media, sensitiveConversationId } = await this.requireAccess(actor, mediaId, {
      allowUnverifiedForUploader: false,
    });
    const key = variant === 'thumbnail' ? media.thumbnailKey : media.objectKey;
    if (!key) throw ApiError.notFound(variant === 'thumbnail' ? 'Preview' : 'File');
    const headers =
      variant === 'thumbnail'
        ? { contentType: 'image/webp', contentDisposition: 'inline' }
        : objectHeaders({ fileName: media.fileName, mimeType: media.mimeType, kind: media.kind });
    const ttl = this.config.MEDIA_DOWNLOAD_URL_TTL_SECONDS;
    const url = await this.storage.presignGet(key, headers, ttl);
    metrics.mediaDownloads.inc({ variant });
    if (sensitiveConversationId && variant === 'original') {
      await this.audit.record(actor, {
        action: 'media.downloaded',
        businessId: media.businessId,
        targetType: 'MediaAsset',
        targetId: media.id,
        metadata: { conversationId: sensitiveConversationId, kind: media.kind },
      });
    }
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /**
   * Access rule: the business is active, the actor holds media.download in it, and either
   * (a) they uploaded it and still belong to its conversation, or (b) it is attached to a
   * non-deleted message they can currently read. Everyone else gets 404.
   */
  private async requireAccess(
    actor: Actor,
    mediaId: string,
    options: { allowUnverifiedForUploader: boolean },
  ) {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        businessId: true,
        conversationId: true,
        campaignId: true,
        forStatus: true,
        forOps: true,
        uploaderId: true,
        status: true,
        kind: true,
        fileName: true,
        mimeType: true,
        objectKey: true,
        thumbnailKey: true,
        business: { select: { status: true } },
      },
    });
    const notFound = ApiError.notFound('File');
    if (!media || media.business.status !== 'ACTIVE') throw notFound;
    if (
      media.status !== 'READY' &&
      !(options.allowUnverifiedForUploader && media.uploaderId === actor.userId)
    )
      throw notFound;
    if (!(await this.hasPermissionInBusiness(actor, 'media.download', media.businessId)))
      throw notFound;

    let sensitiveConversationId: string | null = null;
    // Campaign attachments: the uploader and the business's campaign managers (preview).
    if (
      media.campaignId &&
      (media.uploaderId === actor.userId ||
        (await this.hasPermissionInBusiness(actor, 'bulk_message.send', media.businessId)))
    )
      return { media, sensitiveConversationId };
    // Status photos and videos: the uploader, and whoever can currently see the status.
    if (media.forStatus) {
      if (media.uploaderId === actor.userId) return { media, sensitiveConversationId };
      const visible = await this.prisma.statusPost.count({
        where: { AND: [{ mediaId }, visibleStatusWhere(actor.userId)] },
      });
      if (visible > 0) return { media, sensitiveConversationId };
      throw notFound;
    }
    // Checklist photos: the uploader, and the store's staff and managers.
    if (media.forOps) {
      if (media.uploaderId === actor.userId) return { media, sensitiveConversationId };
      const runs = await this.prisma.checklistRunItem.findMany({
        where: { mediaId },
        select: { run: { select: { businessId: true, storeId: true } } },
        take: 5,
      });
      for (const { run } of runs) {
        const scope = { businessId: run.businessId, storeId: run.storeId };
        if (
          (await this.authz.can(actor, 'task.work', scope)) ||
          (await this.authz.can(actor, 'task.manage', scope))
        )
          return { media, sensitiveConversationId };
      }
      throw notFound;
    }
    if (media.uploaderId === actor.userId && media.conversationId) {
      const member = await this.prisma.conversationMember.findFirst({
        where: { conversationId: media.conversationId, userId: actor.userId, leftAt: null },
        select: { conversation: { select: { id: true, type: true, category: true } } },
      });
      if (member) {
        const c = member.conversation;
        if (c.type === 'EMERGENCY' || (c.category && SENSITIVE_CATEGORIES.has(c.category)))
          sensitiveConversationId = c.id;
        return { media, sensitiveConversationId };
      }
    }
    const attachments = await this.prisma.messageAttachment.findMany({
      where: {
        mediaId,
        message: {
          deletedAt: null,
          conversation: {
            business: { status: 'ACTIVE' },
            members: { some: { userId: actor.userId, leftAt: null } },
          },
        },
      },
      take: 20,
      select: {
        message: {
          select: {
            seq: true,
            conversation: {
              select: {
                id: true,
                type: true,
                category: true,
                members: {
                  where: { userId: actor.userId, leftAt: null },
                  select: { historyFromSeq: true },
                },
              },
            },
          },
        },
      },
    });
    const visible = attachments.find((a) => {
      const member = a.message.conversation.members[0];
      return member !== undefined && a.message.seq > member.historyFromSeq;
    });
    if (!visible) throw notFound;
    const c = visible.message.conversation;
    if (c.type === 'EMERGENCY' || (c.category && SENSITIVE_CATEGORIES.has(c.category)))
      sensitiveConversationId = c.id;
    return { media, sensitiveConversationId };
  }

  private async pendingUpload(actor: Actor, mediaId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaId, uploaderId: actor.userId },
      select: {
        id: true,
        businessId: true,
        conversationId: true,
        campaignId: true,
        forStatus: true,
        forOps: true,
        status: true,
        incomingKey: true,
        multipartUploadId: true,
        partSize: true,
        partCount: true,
        sizeBytes: true,
        uploadExpiresAt: true,
      },
    });
    if (!media) throw ApiError.notFound('Upload');
    if (media.status !== 'PENDING_UPLOAD')
      throw ApiError.conflict('This upload is already finished.');
    if (media.uploadExpiresAt <= new Date())
      throw ApiError.conflict('This upload has expired. Please start again.');
    // The uploader must still be allowed to post in the conversation / manage the campaign.
    if (media.conversationId) await this.access.requireMember(media.conversationId, actor.userId);
    else if (media.forStatus) await this.statusUploadContext(actor, media.businessId);
    else if (media.forOps) {
      // The store is checked again when the photo is attached to a checklist.
      await this.requirePermission(actor, 'media.upload', media.businessId);
    } else await this.campaignUploadContext(actor, media.campaignId!);
    return media;
  }

  private async uploadContext(
    actor: Actor,
    request: CreateUploadRequest,
  ): Promise<{
    businessId: string;
    policy: unknown;
    conversationId: string | null;
    campaignId: string | null;
    forStatus: boolean;
    forOps?: boolean;
  }> {
    if (request.campaignId) return this.campaignUploadContext(actor, request.campaignId);
    if (request.opsStoreId) return this.opsUploadContext(actor, request.opsStoreId);
    if (request.statusBusinessId) return this.statusUploadContext(actor, request.statusBusinessId);
    const { conversation, member } = await this.access.requireMember(
      request.conversationId!,
      actor.userId,
    );
    await this.requirePermission(actor, 'media.upload', conversation.businessId);
    if (!canShareFiles(conversation, member)) {
      throw ApiError.forbidden(
        conversation.fileSharingPolicy === 'DISABLED'
          ? 'Sharing files is turned off in this chat.'
          : 'Only group admins can share files in this chat.',
      );
    }
    return {
      businessId: conversation.businessId,
      policy: conversation.business.policy,
      conversationId: conversation.id,
      campaignId: null,
      forStatus: false,
    };
  }

  /** Checklist photo proof: people who work at the store. */
  private async opsUploadContext(actor: Actor, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, deletedAt: null, status: 'ACTIVE', business: { status: 'ACTIVE' } },
      select: { businessId: true, business: { select: { policy: true } } },
    });
    if (
      !store ||
      !(await this.authz.can(actor, 'task.work', { businessId: store.businessId, storeId }))
    )
      throw ApiError.notFound('Store');
    await this.requirePermission(actor, 'media.upload', store.businessId);
    return {
      businessId: store.businessId,
      policy: store.business.policy,
      conversationId: null,
      campaignId: null,
      forStatus: false,
      forOps: true,
    };
  }

  /** Status photos and videos: people who may post a status in the business. */
  private async statusUploadContext(actor: Actor, businessId: string) {
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, status: 'ACTIVE', deletedAt: null },
      select: { id: true, policy: true },
    });
    if (!business || !(await this.authz.can(actor, 'status.post', { businessId })))
      throw ApiError.notFound('Business');
    await this.requirePermission(actor, 'media.upload', businessId);
    return {
      businessId,
      policy: business.policy,
      conversationId: null,
      campaignId: null,
      forStatus: true,
    };
  }

  /** Campaign attachments: draft campaigns, managed by holders of bulk_message.send in the business. */
  private async campaignUploadContext(actor: Actor, campaignId: string) {
    const campaign = await this.prisma.bulkCampaign.findUnique({
      where: { id: campaignId },
      select: {
        businessId: true,
        status: true,
        business: { select: { status: true, policy: true } },
      },
    });
    if (
      !campaign ||
      campaign.business.status !== 'ACTIVE' ||
      !(await this.hasPermissionInBusiness(actor, 'bulk_message.send', campaign.businessId))
    )
      throw ApiError.notFound('Campaign');
    await this.requirePermission(actor, 'media.upload', campaign.businessId);
    if (campaign.status !== 'DRAFT')
      throw ApiError.conflict('Attachments can only be changed while the campaign is a draft.');
    return {
      businessId: campaign.businessId,
      policy: campaign.business.policy,
      conversationId: null,
      campaignId,
      forStatus: false,
    };
  }

  private signParts(
    key: string,
    uploadId: string,
    numbers: number[],
    totalBytes: number,
    partSize: number,
  ) {
    const lastPart = Math.ceil(totalBytes / partSize);
    return Promise.all(
      numbers.map(async (partNumber) => {
        const sizeBytes =
          partNumber === lastPart ? totalBytes - partSize * (lastPart - 1) : partSize;
        const url = await this.storage.presignPart(
          key,
          uploadId,
          partNumber,
          sizeBytes,
          this.config.MEDIA_UPLOAD_URL_TTL_SECONDS,
        );
        return { partNumber, url, sizeBytes };
      }),
    );
  }

  private async discardIncoming(media: {
    incomingKey: string;
    multipartUploadId: string | null;
  }): Promise<void> {
    try {
      if (media.multipartUploadId)
        await this.storage.abortMultipartUpload(media.incomingKey, media.multipartUploadId);
      await this.storage.delete(media.incomingKey);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not discard incoming upload; the sweeper will retry');
    }
  }

  private async requirePermission(
    actor: Actor,
    permission: 'media.upload' | 'media.download',
    businessId: string,
  ): Promise<void> {
    if (!(await this.hasPermissionInBusiness(actor, permission, businessId))) {
      throw ApiError.forbidden('You cannot share files here.');
    }
  }

  private async hasPermissionInBusiness(
    actor: Actor,
    permission: 'media.upload' | 'media.download' | 'bulk_message.send',
    businessId: string,
  ): Promise<boolean> {
    const coverage = await this.authz.coverage(actor, permission);
    return (
      coverage.all ||
      coverage.businessIds.has(businessId) ||
      [...coverage.stores.values()].includes(businessId)
    );
  }

  private async dto(mediaId: string): Promise<MediaAssetDto> {
    return toMediaAssetDto(
      await this.prisma.mediaAsset.findUniqueOrThrow({
        where: { id: mediaId },
        select: mediaAssetSelect,
      }),
    );
  }
}
