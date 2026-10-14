import { Injectable } from '@nestjs/common';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { PURGE_AFTER_DAYS } from './business-purger';

const EXPORT_LIMIT = { name: 'business:export', limit: 3, windowSeconds: 24 * 3600 } as const;
const PAGE = 1000;

export interface ClosureStatusDto {
  closureRequestedAt: string | null;
  closureReason: string | null;
  /** Days between deletion and permanent erasure. */
  eraseAfterDays: number;
}

/**
 * A business's own data: a full export (everything it put into SMA, for its records or to move
 * elsewhere) and the request to close the account. Owners and admins with two-step login.
 */
@Injectable()
export class BusinessDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  private async requireOwner(actor: Actor, businessId: string) {
    if (!(await this.authz.can(actor, 'business.read', { businessId })))
      throw ApiError.notFound('Business');
    await this.authz.require(actor, 'business.update', { businessId });
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, deletedAt: null, internal: false },
      select: { id: true, name: true, slug: true, closureRequestedAt: true, closureReason: true },
    });
    if (!business) throw ApiError.notFound('Business');
    return business;
  }

  async setup(actor: Actor, businessId: string): Promise<SetupStatusDto> {
    if (!(await this.authz.can(actor, 'business.read', { businessId })))
      throw ApiError.notFound('Business');
    return setupStatus(this.prisma, businessId);
  }

  async closureStatus(actor: Actor, businessId: string): Promise<ClosureStatusDto> {
    const b = await this.requireOwner(actor, businessId);
    return {
      closureRequestedAt: b.closureRequestedAt?.toISOString() ?? null,
      closureReason: b.closureReason,
      eraseAfterDays: PURGE_AFTER_DAYS,
    };
  }

  /** The owner asks SMA to close the account (SMA then deletes it; data is erased 30 days later). */
  async requestClosure(
    actor: Actor,
    businessId: string,
    reason: string | undefined,
  ): Promise<ClosureStatusDto> {
    await this.requireOwner(actor, businessId);
    await this.prisma.business.update({
      where: { id: businessId },
      data: { closureRequestedAt: new Date(), closureReason: reason?.trim() || null },
    });
    await this.audit.record(actor, {
      action: 'business.closure_requested',
      businessId,
      targetType: 'Business',
      targetId: businessId,
    });
    return this.closureStatus(actor, businessId);
  }

  async cancelClosure(actor: Actor, businessId: string): Promise<ClosureStatusDto> {
    await this.requireOwner(actor, businessId);
    await this.prisma.business.update({
      where: { id: businessId },
      data: { closureRequestedAt: null, closureReason: null },
    });
    await this.audit.record(actor, {
      action: 'business.closure_cancelled',
      businessId,
      targetType: 'Business',
      targetId: businessId,
    });
    return this.closureStatus(actor, businessId);
  }

  /**
   * Everything the business has in SMA as one JSON document, written piece by piece (large
   * businesses never sit in memory). Audited; at most 3 a day.
   */
  async export(
    actor: Actor,
    businessId: string,
    open: (fileName: string) => void,
    write: (chunk: string) => Promise<void>,
  ): Promise<void> {
    const business = await this.requireOwner(actor, businessId);
    await this.rateLimiter.consume(EXPORT_LIMIT, businessId);
    open(`sma-export-${business.slug}-${new Date().toISOString().slice(0, 10)}.json`);
    await this.audit.record(actor, {
      action: 'business.data_exported',
      businessId,
      targetType: 'Business',
      targetId: businessId,
    });
    const db = this.prisma;
    const B = businessId;
    let first = true;
    const section = async (name: string, value: unknown) => {
      await write(
        `${first ? '' : ','}\n${JSON.stringify(name)}:${JSON.stringify(value, jsonSafe)}`,
      );
      first = false;
    };
    /** A list written page by page. */
    const list = async <T extends { id: string }>(
      name: string,
      page: (after: string | undefined) => Promise<T[]>,
    ) => {
      await write(`${first ? '' : ','}\n${JSON.stringify(name)}:[`);
      first = false;
      let after: string | undefined;
      let n = 0;
      for (;;) {
        const rows = await page(after);
        for (const row of rows) await write(`${n++ ? ',' : ''}\n${JSON.stringify(row, jsonSafe)}`);
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1]!.id;
      }
      await write(']');
    };
    const paged = { take: PAGE, orderBy: { id: 'asc' as const } };
    const cursor = (after: string | undefined) => (after ? { id: { gt: after } } : {});

    await write('{');
    await section('exportedAt', new Date().toISOString());
    await section('format', 'SMA business export, version 1');
    await section(
      'business',
      await db.business.findUnique({
        where: { id: B },
        select: {
          id: true,
          name: true,
          slug: true,
          timeZone: true,
          locale: true,
          address: true,
          description: true,
          phone: true,
          email: true,
          website: true,
          createdAt: true,
        },
      }),
    );
    await section(
      'stores',
      await db.store.findMany({
        where: { businessId: B },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          address: true,
          phone: true,
          email: true,
          createdAt: true,
        },
      }),
    );
    await list('people', (after) =>
      db.user.findMany({
        where: { ...cursor(after), businessMemberships: { some: { businessId: B } } },
        select: {
          id: true,
          username: true,
          displayName: true,
          status: true,
          createdAt: true,
          contact: { select: { email: true, phone: true } },
          roleAssignments: {
            where: { businessId: B, revokedAt: null },
            select: { role: { select: { name: true } }, storeId: true },
          },
        },
        ...paged,
      }),
    );
    await list('chats', (after) =>
      db.conversation.findMany({
        where: { ...cursor(after), businessId: B },
        select: {
          id: true,
          type: true,
          title: true,
          storeId: true,
          createdAt: true,
          members: { select: { userId: true, role: true, joinedAt: true, leftAt: true } },
        },
        ...paged,
      }),
    );
    await list('messages', (after) =>
      db.message.findMany({
        where: { ...cursor(after), conversation: { businessId: B }, deletedAt: null },
        select: {
          id: true,
          conversationId: true,
          seq: true,
          senderId: true,
          kind: true,
          body: true,
          createdAt: true,
          editedAt: true,
          attachments: {
            select: { media: { select: { fileName: true, mimeType: true, sizeBytes: true } } },
          },
        },
        ...paged,
      }),
    );
    await list('files', (after) =>
      db.mediaAsset.findMany({
        where: { ...cursor(after), businessId: B },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          createdAt: true,
          uploaderId: true,
        },
        ...paged,
      }),
    );
    await list('storeCustomers', (after) =>
      db.storeCustomer.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('customerCampaigns', (after) =>
      db.customerCampaign.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('tasks', (after) =>
      db.storeTask.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('shifts', (after) =>
      db.shift.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('attendance', (after) =>
      db.attendanceRecord.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('leaveRequests', (after) =>
      db.leaveRequest.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('checklistTemplates', (after) =>
      db.checklistTemplate.findMany({ where: { ...cursor(after), businessId: B }, ...paged }),
    );
    await list('checklistRuns', (after) =>
      db.checklistRun.findMany({
        where: { ...cursor(after), businessId: B },
        include: { items: true },
        ...paged,
      }),
    );
    await list('emergencyIncidents', (after) =>
      db.emergencyIncident.findMany({
        where: { ...cursor(after), businessId: B },
        include: { events: true },
        ...paged,
      }),
    );
    // Its own Sales & Marketing.
    await list('leads', (after) =>
      db.lead.findMany({
        where: { ...cursor(after), tenantId: B },
        include: { activities: true },
        ...paged,
      }),
    );
    await list('deals', (after) =>
      db.deal.findMany({
        where: { ...cursor(after), tenantId: B },
        include: { items: true },
        ...paged,
      }),
    );
    await list('quotes', (after) =>
      db.quote.findMany({
        where: { ...cursor(after), tenantId: B },
        include: { items: true },
        omit: { publicToken: true },
        ...paged,
      }),
    );
    await list('invoices', (after) =>
      db.invoice.findMany({
        where: { ...cursor(after), tenantId: B },
        include: { items: true, payments: true },
        omit: { payToken: true },
        ...paged,
      }),
    );
    await list('services', (after) =>
      db.crmService.findMany({ where: { ...cursor(after), tenantId: B }, ...paged }),
    );
    await write('\n}\n');
  }
}

/** BigInt and Decimal values as plain numbers/strings in JSON. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (
    value &&
    typeof value === 'object' &&
    'toFixed' in value &&
    typeof (value as { toFixed: unknown }).toFixed === 'function' &&
    !(value instanceof Date)
  )
    return Number(value as unknown as number);
  return value;
}

export interface SetupStatusDto {
  details: boolean;
  stores: number;
  people: number;
  groups: number;
  salesReady: boolean;
}

/** How far a new business got with setting itself up (the dashboard checklist). */
export async function setupStatus(
  prisma: PrismaService,
  businessId: string,
): Promise<SetupStatusDto> {
  const [business, stores, people, groups, services, settings] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { phone: true, email: true, logoUpdatedAt: true, address: true },
    }),
    prisma.store.count({ where: { businessId, status: 'ACTIVE' } }),
    prisma.businessMembership.count({ where: { businessId, status: 'ACTIVE' } }),
    prisma.conversation.count({ where: { businessId, type: 'GROUP', archivedAt: null } }),
    prisma.crmService.count({ where: { tenantId: businessId } }),
    prisma.crmSetting.count({ where: { businessId } }),
  ]);
  return {
    details:
      !!business &&
      (!!business.logoUpdatedAt || !!business.address || !!business.phone || !!business.email),
    stores,
    people,
    groups,
    salesReady: services > 0 || settings > 0,
  };
}
