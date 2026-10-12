import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  customerCampaignAudienceSchema,
  type CreateCustomerCampaignRequest,
  type CustomerCampaignAudience,
  type CustomerCampaignDetailDto,
  type CustomerCampaignDto,
  type CustomerCampaignPreviewDto,
  type CustomerRecipientState,
  type MarketingChannel,
  type MarketingChannelsDto,
  type PreviewCustomerCampaignRequest,
  type UnsubscribeRequest,
} from '@storeline/shared';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { MarketingChannelsService } from '../../infra/mail/marketing-channels.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

/** Opted-in customers of the audience who can be reached on the channel. */
export function audienceWhere(
  businessId: string,
  audience: CustomerCampaignAudience,
  channel: MarketingChannel | null,
): Prisma.StoreCustomerWhereInput {
  return {
    businessId,
    deletedAt: null,
    marketingOptIn: true,
    ...(audience.storeIds.length ? { storeId: { in: audience.storeIds } } : {}),
    ...(audience.tags.length ? { tags: { hasSome: audience.tags } } : {}),
    ...(channel === 'EMAIL' ? { email: { not: null } } : channel ? { phone: { not: null } } : {}),
  };
}

/** HMAC token for one customer's unsubscribe link (cannot be guessed or reused for others). */
export function unsubscribeToken(crypto: CryptoService, customerId: string): string {
  return crypto.keyedHash(`unsubscribe:${customerId}`);
}

const campaignInclude = {
  createdBy: { select: { displayName: true } },
} as const satisfies Prisma.CustomerCampaignInclude;

type CampaignRow = Prisma.CustomerCampaignGetPayload<{ include: typeof campaignInclude }>;

/**
 * Campaigns from a business to its store customers who agreed to marketing, by email, SMS or
 * WhatsApp. Sending happens in the worker (CustomerCampaignDispatcher), a batch at a time.
 */
@Injectable()
export class CustomerCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly channels: MarketingChannelsService,
    private readonly crypto: CryptoService,
  ) {}

  /** Business-wide marketing rights: customer.manage and bulk_message.send. */
  private async requireMarketer(actor: Actor, businessId: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { deletedAt: true, internal: true, status: true },
    });
    if (!business || business.deletedAt || business.internal) throw ApiError.notFound('Business');
    await this.authz.require(actor, 'customer.manage', { businessId });
    await this.authz.require(actor, 'bulk_message.send', { businessId });
  }

  private async requireStores(businessId: string, storeIds: string[]): Promise<void> {
    if (storeIds.length === 0) return;
    const found = await this.prisma.store.count({
      where: { id: { in: storeIds }, businessId, deletedAt: null },
    });
    if (found !== new Set(storeIds).size)
      throw ApiError.validation('One or more stores were not found.', 'storeIds');
  }

  private async counts(campaignIds: string[]) {
    const rows = await this.prisma.customerCampaignRecipient.groupBy({
      by: ['campaignId', 'state'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    });
    const map = new Map<string, CustomerCampaignDto['counts']>();
    for (const id of campaignIds)
      map.set(id, { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 });
    for (const r of rows) {
      const c = map.get(r.campaignId)!;
      const n = r._count._all;
      c.total += n;
      if (r.state === 'PENDING' || r.state === 'SENDING') c.pending += n;
      else if (r.state === 'SENT') c.sent += n;
      else if (r.state === 'FAILED') c.failed += n;
      else c.skipped += n;
    }
    return map;
  }

  private toDto(row: CampaignRow, counts: CustomerCampaignDto['counts']): CustomerCampaignDto {
    const audience = customerCampaignAudienceSchema.safeParse(row.audience);
    return {
      id: row.id,
      businessId: row.businessId,
      name: row.name,
      channel: row.channel,
      subject: row.subject,
      body: row.body,
      audience: audience.success ? audience.data : { storeIds: [], tags: [] },
      status: row.status,
      counts,
      createdBy: row.createdBy?.displayName ?? null,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  channelsAvailable(): MarketingChannelsDto {
    return this.channels.available();
  }

  async list(actor: Actor, businessId: string): Promise<CustomerCampaignDto[]> {
    await this.requireMarketer(actor, businessId);
    const rows = await this.prisma.customerCampaign.findMany({
      where: { businessId },
      include: campaignInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const counts = await this.counts(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, counts.get(r.id)!));
  }

  async preview(
    actor: Actor,
    businessId: string,
    request: PreviewCustomerCampaignRequest,
  ): Promise<CustomerCampaignPreviewDto> {
    await this.requireMarketer(actor, businessId);
    await this.requireStores(businessId, request.storeIds);
    const [recipients, optedIn] = await Promise.all([
      this.prisma.storeCustomer.count({
        where: audienceWhere(businessId, request, request.channel),
      }),
      this.prisma.storeCustomer.count({ where: audienceWhere(businessId, request, null) }),
    ]);
    return { recipients, missingContact: optedIn - recipients };
  }

  async create(
    actor: Actor,
    businessId: string,
    request: CreateCustomerCampaignRequest,
  ): Promise<CustomerCampaignDto> {
    await this.requireMarketer(actor, businessId);
    await this.requireStores(businessId, request.storeIds);
    const row = await this.prisma.customerCampaign.create({
      data: {
        businessId,
        name: request.name,
        channel: request.channel,
        subject: request.channel === 'EMAIL' ? (request.subject ?? null) : null,
        body: request.body,
        audience: { storeIds: request.storeIds, tags: request.tags },
        createdById: actor.userId,
      },
      include: campaignInclude,
    });
    return this.toDto(row, { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 });
  }

  private async requireCampaign(actor: Actor, campaignId: string) {
    const row = await this.prisma.customerCampaign.findUnique({
      where: { id: campaignId },
      include: campaignInclude,
    });
    if (!row) throw ApiError.notFound('Campaign');
    await this.requireMarketer(actor, row.businessId);
    return row;
  }

  async get(actor: Actor, campaignId: string): Promise<CustomerCampaignDetailDto> {
    const row = await this.requireCampaign(actor, campaignId);
    const [counts, recipients] = await Promise.all([
      this.counts([row.id]),
      this.prisma.customerCampaignRecipient.findMany({
        where: { campaignId },
        select: {
          customerId: true,
          destination: true,
          state: true,
          error: true,
          sentAt: true,
          customer: { select: { name: true } },
        },
        orderBy: [{ state: 'asc' }, { sentAt: 'desc' }],
        take: 500,
      }),
    ]);
    return {
      ...this.toDto(row, counts.get(row.id)!),
      recipients: recipients.map((r) => ({
        customerId: r.customerId,
        name: r.customer.name,
        destination: r.destination,
        state: r.state as CustomerRecipientState,
        error: r.error,
        sentAt: r.state === 'SENT' ? (r.sentAt?.toISOString() ?? null) : null,
      })),
    };
  }

  /** Freezes the audience (who gets it) and hands the campaign to the worker. */
  async send(actor: Actor, campaignId: string): Promise<CustomerCampaignDetailDto> {
    const row = await this.requireCampaign(actor, campaignId);
    if (row.status !== 'DRAFT') throw ApiError.conflict('This campaign was already sent.');
    if (!this.channels.available()[row.channel])
      throw ApiError.conflict(
        `${row.channel === 'EMAIL' ? 'Email' : row.channel === 'SMS' ? 'SMS' : 'WhatsApp'} is not set up on this server yet.`,
      );
    const audience = customerCampaignAudienceSchema.parse(row.audience);
    const customers = await this.prisma.storeCustomer.findMany({
      where: audienceWhere(row.businessId, audience, row.channel),
      select: { id: true, email: true, phone: true },
      take: 100_000,
    });
    if (customers.length === 0)
      throw ApiError.conflict('No customers in this audience agreed to marketing on this channel.');
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.customerCampaign.updateMany({
        where: { id: campaignId, status: 'DRAFT' },
        data: { status: 'SENDING', startedAt: new Date() },
      });
      if (claimed.count !== 1) throw ApiError.conflict('This campaign was already sent.');
      await tx.customerCampaignRecipient.createMany({
        data: customers.map((c) => ({
          campaignId,
          customerId: c.id,
          destination: (row.channel === 'EMAIL' ? c.email : c.phone)!,
        })),
        skipDuplicates: true,
      });
      await this.audit.record(
        actor,
        {
          action: 'customer_campaign.sent',
          businessId: row.businessId,
          targetType: 'CustomerCampaign',
          targetId: campaignId,
          metadata: { channel: row.channel, recipients: customers.length },
        },
        tx,
      );
    });
    return this.get(actor, campaignId);
  }

  /** Stops a campaign: messages not sent yet are skipped. */
  async cancel(actor: Actor, campaignId: string): Promise<CustomerCampaignDetailDto> {
    const row = await this.requireCampaign(actor, campaignId);
    if (row.status === 'COMPLETED' || row.status === 'CANCELLED')
      throw ApiError.conflict('This campaign has already finished.');
    await this.prisma.$transaction([
      this.prisma.customerCampaign.update({
        where: { id: campaignId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      }),
      this.prisma.customerCampaignRecipient.updateMany({
        where: { campaignId, state: 'PENDING' },
        data: { state: 'SKIPPED', error: 'Campaign cancelled' },
      }),
    ]);
    return this.get(actor, campaignId);
  }

  /** Public unsubscribe link: marketing is switched off for this customer. */
  async unsubscribe(request: UnsubscribeRequest): Promise<{ businessName: string }> {
    const expected = unsubscribeToken(this.crypto, request.c);
    if (!this.crypto.safeEqual(expected, request.t))
      throw ApiError.validation('This unsubscribe link is not valid.', 't');
    const customer = await this.prisma.storeCustomer.findUnique({
      where: { id: request.c },
      select: { deletedAt: true, business: { select: { name: true } } },
    });
    if (!customer) throw ApiError.validation('This unsubscribe link is not valid.', 't');
    if (!customer.deletedAt) {
      await this.prisma.storeCustomer.update({
        where: { id: request.c },
        data: { marketingOptIn: false, optInAt: null, unsubscribedAt: new Date() },
      });
    }
    return { businessName: customer.business.name };
  }
}
