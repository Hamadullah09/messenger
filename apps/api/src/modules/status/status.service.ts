import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  STATUS_TTL_HOURS,
  type CreateStatusRequest,
  type StatusFeedDto,
  type StatusPostDto,
  type StatusViewerDto,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import type { Actor } from '../auth/actor';
import { FeaturesService } from '../platform/features.module';
import { AuthorizationService } from '../authorization/authorization.service';
import { attachmentMediaSelect, toAttachmentDto } from '../media/media.mapper';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { statusAudienceUsersWhere, visibleStatusWhere } from './status-audience';

const postInclude = (userId: string) =>
  ({
    author: { select: publicUserSelect },
    store: { select: { name: true } },
    media: { select: { ...attachmentMediaSelect, status: true } },
    views: { where: { userId }, select: { userId: true } },
    _count: { select: { views: true } },
  }) as const satisfies Prisma.StatusPostInclude;

type PostRow = Prisma.StatusPostGetPayload<{ include: ReturnType<typeof postInclude> }>;

/**
 * WhatsApp-style Status: 24-hour text, photo or video posts for the people of a business (or
 * of one store, for store announcements). Authors see who viewed their posts.
 */
@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly realtime: RealtimeEmitter,
    private readonly rateLimiter: RateLimiterService,
    private readonly features: FeaturesService,
  ) {}

  private toDto(row: PostRow, actor: Actor): StatusPostDto {
    const mine = row.authorId === actor.userId;
    return {
      id: row.id,
      author: toPublicUser(row.author),
      businessId: row.businessId,
      storeId: row.storeId,
      storeName: row.store?.name ?? null,
      text: row.text,
      background: row.background,
      media: row.media && row.media.status === 'READY' ? toAttachmentDto(row.media) : null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      viewed: mine || row.views.length > 0,
      viewCount: mine ? row._count.views : null,
    };
  }

  async feed(actor: Actor, businessId?: string): Promise<StatusFeedDto> {
    this.features.require('STATUS');
    const rows = await this.prisma.statusPost.findMany({
      where: { AND: [visibleStatusWhere(actor.userId), businessId ? { businessId } : {}] },
      include: postInclude(actor.userId),
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    const posts = rows.map((r) => this.toDto(r, actor));
    const mine = posts.filter((p) => p.author.id === actor.userId);
    const byAuthor = new Map<string, StatusFeedDto['others'][number]>();
    for (const p of posts) {
      if (p.author.id === actor.userId) continue;
      const group = byAuthor.get(p.author.id) ?? { author: p.author, posts: [], allViewed: true };
      group.posts.push(p);
      group.allViewed &&= p.viewed;
      byAuthor.set(p.author.id, group);
    }
    const others = [...byAuthor.values()].sort((a, b) => {
      if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
      return b.posts.at(-1)!.createdAt.localeCompare(a.posts.at(-1)!.createdAt);
    });
    return { mine, others };
  }

  async create(actor: Actor, request: CreateStatusRequest): Promise<StatusPostDto> {
    this.features.require('STATUS');
    await this.rateLimiter.consume(RATE_LIMITS.messageSendPerUser, actor.userId);
    const storeId = request.storeId ?? null;
    const business = await this.prisma.business.findFirst({
      where: { id: request.businessId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!business) throw ApiError.notFound('Business');
    if (storeId) {
      const store = await this.prisma.store.findFirst({
        where: { id: storeId, businessId: request.businessId, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      if (!store) throw ApiError.validation('Store not found in this business.', 'storeId');
    }
    await this.authz.require(actor, 'status.post', { businessId: request.businessId, storeId });
    if (request.mediaId) {
      const media = await this.prisma.mediaAsset.findFirst({
        where: {
          id: request.mediaId,
          uploaderId: actor.userId,
          businessId: request.businessId,
          forStatus: true,
        },
        select: { status: true, kind: true },
      });
      if (!media) throw ApiError.validation('The photo or video was not found.', 'mediaId');
      if (media.status !== 'READY')
        throw ApiError.conflict('The file is still being checked. Please wait a moment.');
      if (media.kind !== 'IMAGE' && media.kind !== 'VIDEO')
        throw ApiError.validation('Status updates take photos and videos.', 'mediaId');
    }
    const post = await this.prisma.statusPost.create({
      data: {
        businessId: request.businessId,
        storeId,
        authorId: actor.userId,
        text: request.text?.trim() || null,
        background: request.mediaId ? null : (request.background ?? '#ea580c'),
        mediaId: request.mediaId ?? null,
        expiresAt: new Date(Date.now() + STATUS_TTL_HOURS * 3_600_000),
      },
      include: postInclude(actor.userId),
    });
    await this.announce(request.businessId, storeId);
    return this.toDto(post, actor);
  }

  async view(actor: Actor, statusId: string): Promise<void> {
    this.features.require('STATUS');
    const post = await this.requireVisible(actor, statusId);
    if (post.authorId === actor.userId) return;
    await this.prisma.statusView.upsert({
      where: { statusId_userId: { statusId, userId: actor.userId } },
      create: { statusId, userId: actor.userId },
      update: {},
    });
  }

  async viewers(actor: Actor, statusId: string): Promise<StatusViewerDto[]> {
    this.features.require('STATUS');
    const post = await this.requireVisible(actor, statusId);
    if (post.authorId !== actor.userId)
      throw ApiError.forbidden('Only the author can see who viewed it.');
    const views = await this.prisma.statusView.findMany({
      where: { statusId },
      include: { user: { select: publicUserSelect } },
      orderBy: { viewedAt: 'desc' },
      take: 1000,
    });
    return views.map((v) => ({ user: toPublicUser(v.user), viewedAt: v.viewedAt.toISOString() }));
  }

  async remove(actor: Actor, statusId: string): Promise<void> {
    const post = await this.requireVisible(actor, statusId);
    if (post.authorId !== actor.userId)
      throw ApiError.forbidden('Only the author can delete a status update.');
    await this.prisma.statusPost.update({
      where: { id: statusId },
      data: { deletedAt: new Date() },
    });
    await this.announce(post.businessId, post.storeId);
  }

  private async requireVisible(actor: Actor, statusId: string) {
    const post = await this.prisma.statusPost.findFirst({
      where: { AND: [{ id: statusId }, visibleStatusWhere(actor.userId)] },
      select: { id: true, authorId: true, businessId: true, storeId: true },
    });
    if (!post) throw ApiError.notFound('Status update');
    return post;
  }

  /** Tells the audience's open apps to refresh their status list. */
  private async announce(businessId: string, storeId: string | null): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: statusAudienceUsersWhere(businessId, storeId),
      select: { id: true },
      take: 5000,
    });
    this.realtime.toUsers(
      users.map((u) => u.id),
      'status.changed',
      { businessId },
    );
  }
}
