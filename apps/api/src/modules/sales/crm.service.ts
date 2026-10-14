import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import {
  OPEN_LEAD_STAGES,
  type ChangeDealStatusRequest,
  type CreateDealRequest,
  type CreateInvoiceRequest,
  type CrmCustomerDto,
  type CrmOverviewDto,
  type CrmServiceDto,
  type DealDto,
  type InvoiceDto,
  type LineItemInput,
  type ListDealsQuery,
  type ListInvoicesQuery,
  type Permission,
  type RecordPaymentRequest,
  type SetTargetRequest,
  type TargetHistoryDto,
  type TargetProgressDto,
  type TargetsDto,
  type UpdateDealRequest,
  type UpdateInvoiceRequest,
  type UpsertServiceRequest,
  type CommissionPlanDto,
  type CrmCustomerRef,
  type CrmSettingsDto,
  type PaymentClaimDto,
  type ReviewPaymentClaimRequest,
  type SetCommissionPlanRequest,
  type UpdateCrmSettingsRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import {
  type CrmSettings,
  CrmSettingsService,
  documentHtml,
  documentText,
  InvoiceFactory,
  newPublicToken,
  num,
  round2,
} from './crm-core';
import { SALES_PEOPLE_ROLE_KEYS, SalesService } from './sales.service';

/** "2026-10" → [first day of the month, first day of the next) in server time. */
function monthRange(month: string): [Date, Date] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
/** A DATE column value for the first of the month (stored at UTC midnight). */
function monthDate(month: string): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}
function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lineTotals(items: LineItemInput[]) {
  const rows = items.map((item, position) => ({
    serviceId: item.serviceId ?? null,
    name: item.name,
    quantity: item.quantity,
    unitPrice: round2(item.unitPrice),
    discountPct: item.discountPct ?? 0,
    billing: item.billing ?? 'ONE_TIME',
    total: round2(item.quantity * item.unitPrice * (1 - (item.discountPct ?? 0) / 100)),
    position,
  }));
  return { rows, amount: round2(rows.reduce((sum, r) => sum + r.total, 0)) };
}

const dealInclude = {
  lead: { select: { id: true, companyName: true, stage: true } },
  business: { select: { id: true, name: true } },
  owner: { select: publicUserSelect },
  items: { orderBy: { position: 'asc' } },
  invoices: { where: { status: { not: 'VOID' } }, select: { total: true, amountPaid: true } },
  subscriptions: { where: { status: { not: 'CANCELLED' } }, select: { id: true }, take: 1 },
} as const satisfies Prisma.DealInclude;
type DealRow = Prisma.DealGetPayload<{ include: typeof dealInclude }>;

const invoiceInclude = {
  deal: { select: { id: true, title: true, type: true, ownerId: true } },
  business: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true } },
  items: { orderBy: { position: 'asc' } },
  payments: { orderBy: { paidAt: 'asc' }, include: { recordedBy: { select: publicUserSelect } } },
  subscription: { select: { id: true, name: true } },
  _count: { select: { claims: { where: { status: 'PENDING' } } } },
} as const satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

interface Access {
  /** The business whose CRM this is. */
  teamId: string;
  /** SMA's own sales team (customers are businesses on SMA). */
  platform: boolean;
  settings: CrmSettings;
  seeAll: boolean;
  billing: boolean;
  catalog: boolean;
  targets: boolean;
  assign: boolean;
}

/**
 * A business's CRM (every business has its own; SMA's sales team uses it to sell SMA): the
 * services it sells, deals (new customers and upsells), invoices, payments and the sales
 * people's monthly targets. Agents work on their own deals; managers see everything, bill and
 * set targets. Every query is limited to the business (`teamId`).
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly crmSettings: CrmSettingsService,
    private readonly factory: InvoiceFactory,
  ) {}

  private async access(actor: Actor): Promise<Access> {
    const tenant = await this.sales.tenant(actor);
    const teamId = tenant.businessId;
    await this.authz.require(actor, 'sales.access', { businessId: teamId });
    const can = (p: Permission) => this.authz.can(actor, p, { businessId: teamId });
    const [seeAll, billing, catalog, targets, assign] = await Promise.all([
      can('sales.lead.read_all'),
      can('sales.billing.manage'),
      can('sales.catalog.manage'),
      can('sales.target.manage'),
      can('sales.lead.assign'),
    ]);
    const settings = await this.crmSettings.load(teamId);
    return {
      teamId,
      platform: tenant.platform,
      settings,
      seeAll,
      billing,
      catalog,
      targets,
      assign,
    };
  }

  private async requireSalesUser(teamId: string, userId: string): Promise<void> {
    const ok = await this.prisma.roleAssignment.count({
      where: {
        userId,
        businessId: teamId,
        revokedAt: null,
        role: { key: { in: [...SALES_PEOPLE_ROLE_KEYS] }, isSystem: true },
        user: { status: 'ACTIVE', deletedAt: null },
      },
    });
    if (!ok) throw ApiError.validation('Choose someone from the sales team.', 'ownerId');
  }

  /** Amount in the business's main currency (targets, totals). */
  private main(access: Access, amount: number, currency: string): number {
    return this.crmSettings.convert(
      amount,
      currency,
      access.settings.defaultCurrency,
      access.settings,
    );
  }

  /** Who a row is for: a business on SMA, or (a business's own CRM) the lead. */
  private customerOf(
    access: Access,
    business: { id: string; name: string } | null,
    lead: { id: string; companyName: string; stage?: string } | null,
  ): CrmCustomerRef | null {
    if (business) return { ...business, kind: 'BUSINESS' };
    if (!access.platform && lead && (lead.stage === undefined || lead.stage === 'WON'))
      return { id: lead.id, name: lead.companyName, kind: 'LEAD' };
    return null;
  }

  async getSettings(actor: Actor): Promise<CrmSettingsDto> {
    const access = await this.access(actor);
    return { ...access.settings, canManage: access.billing };
  }

  async updateSettings(actor: Actor, request: UpdateCrmSettingsRequest): Promise<CrmSettingsDto> {
    const access = await this.access(actor);
    if (!access.billing) throw ApiError.forbidden('Only sales managers can change these settings.');
    await this.crmSettings.update(access.teamId, request, actor.userId);
    await this.audit.record(actor, {
      action: 'crm.settings_changed',
      businessId: access.teamId,
      metadata: { fields: Object.keys(request) },
    });
    return this.getSettings(actor);
  }

  // ───────────────────────────── Services catalog ─────────────────────────────

  async listServices(actor: Actor): Promise<CrmServiceDto[]> {
    const access = await this.access(actor);
    const [rows, sold] = await Promise.all([
      this.prisma.crmService.findMany({
        where: { tenantId: access.teamId },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.dealItem.groupBy({
        by: ['serviceId'],
        where: {
          serviceId: { not: null },
          deal: { tenantId: access.teamId, status: 'WON', deletedAt: null },
        },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(sold.map((s) => [s.serviceId, s._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      price: num(r.price),
      currency: r.currency,
      billing: r.billing,
      active: r.active,
      timesSold: counts.get(r.id) ?? 0,
    }));
  }

  async saveService(
    actor: Actor,
    serviceId: string | null,
    request: UpsertServiceRequest,
  ): Promise<CrmServiceDto[]> {
    const access = await this.access(actor);
    if (!access.catalog) throw ApiError.forbidden('Only sales managers can change services.');
    const data = {
      name: request.name,
      description: request.description ?? null,
      category: request.category ?? null,
      price: request.price,
      currency: request.currency,
      billing: request.billing,
      ...(request.active !== undefined ? { active: request.active } : {}),
    };
    if (serviceId) {
      const updated = await this.prisma.crmService.updateMany({
        where: { id: serviceId, tenantId: access.teamId },
        data,
      });
      if (updated.count === 0) throw ApiError.notFound('Service');
    } else {
      await this.prisma.crmService.create({ data: { ...data, tenantId: access.teamId } });
    }
    return this.listServices(actor);
  }

  // ───────────────────────────── Deals ─────────────────────────────

  private dealWhere(actor: Actor, access: Access): Prisma.DealWhereInput {
    return access.seeAll
      ? { tenantId: access.teamId, deletedAt: null }
      : {
          tenantId: access.teamId,
          deletedAt: null,
          OR: [{ ownerId: actor.userId }, { createdById: actor.userId }],
        };
  }

  private toDeal(row: DealRow, actor: Actor, access: Access): DealDto {
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      lead: row.lead,
      customer: this.customerOf(access, row.business, row.lead),
      owner: row.owner ? toPublicUser(row.owner) : null,
      amount: num(row.amount),
      currency: row.currency,
      expectedCloseAt: row.expectedCloseAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      lostReason: row.lostReason,
      notes: row.notes,
      items: row.items.map((i) => ({
        id: i.id,
        serviceId: i.serviceId,
        name: i.name,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        discountPct: num(i.discountPct),
        total: num(i.total),
        billing: i.billing,
      })),
      subscriptionId: row.subscriptions[0]?.id ?? null,
      invoiced: round2(row.invoices.reduce((s, i) => s + num(i.total), 0)),
      paid: round2(row.invoices.reduce((s, i) => s + num(i.amountPaid), 0)),
      invoiceCount: row.invoices.length,
      createdAt: row.createdAt.toISOString(),
      canEdit: access.seeAll || row.ownerId === actor.userId,
    };
  }

  async listDeals(actor: Actor, query: ListDealsQuery): Promise<DealDto[]> {
    const access = await this.access(actor);
    const q = query.q?.trim();
    const rows = await this.prisma.deal.findMany({
      where: {
        AND: [
          this.dealWhere(actor, access),
          query.status ? { status: query.status } : {},
          query.type ? { type: query.type } : {},
          query.ownerId ? { ownerId: query.ownerId === 'me' ? actor.userId : query.ownerId } : {},
          query.businessId ? { businessId: query.businessId } : {},
          query.leadId ? { leadId: query.leadId } : {},
          q
            ? {
                OR: [
                  { title: { contains: q, mode: 'insensitive' } },
                  { business: { name: { contains: q, mode: 'insensitive' } } },
                  { lead: { companyName: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : {},
        ],
      },
      include: dealInclude,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => this.toDeal(r, actor, access));
  }

  async getDeal(actor: Actor, dealId: string): Promise<DealDto> {
    const access = await this.access(actor);
    const row = await this.prisma.deal.findFirst({
      where: { AND: [{ id: dealId }, this.dealWhere(actor, access)] },
      include: dealInclude,
    });
    if (!row) throw ApiError.notFound('Deal');
    return this.toDeal(row, actor, access);
  }

  private async requireCustomer(
    access: Access,
    businessId: string,
  ): Promise<{ id: string; name: string }> {
    if (!access.platform)
      throw ApiError.validation('Choose the customer from your won leads.', 'businessId');
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, internal: false, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!business) throw ApiError.validation('Choose an SMA customer.', 'businessId');
    return business;
  }

  async createDeal(actor: Actor, request: CreateDealRequest): Promise<DealDto> {
    const access = await this.access(actor);
    await this.authz.require(actor, 'sales.lead.manage', { businessId: access.teamId });
    let businessId = request.businessId ?? null;
    let leadId = request.leadId ?? null;
    if (leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: {
          id: leadId,
          tenantId: access.teamId,
          deletedAt: null,
          ...(access.seeAll ? {} : { OR: [{ ownerId: actor.userId }, { ownerId: null }] }),
        },
        select: { id: true, convertedBusinessId: true, stage: true },
      });
      if (!lead) throw ApiError.validation('Lead not found.', 'leadId');
      if (request.type === 'UPSELL' && !access.platform && lead.stage !== 'WON')
        throw ApiError.validation('Upsells are for customers: choose a won lead.', 'leadId');
      businessId = businessId ?? lead.convertedBusinessId;
    }
    if (businessId) await this.requireCustomer(access, businessId);
    if (request.type === 'UPSELL' && !businessId && !leadId)
      throw ApiError.validation('Choose the customer.', 'businessId');
    if (request.type !== 'NEW_BUSINESS') leadId = leadId ?? null;
    let ownerId: string | null = actor.userId;
    if (request.ownerId !== undefined && request.ownerId !== actor.userId) {
      if (!access.assign) throw ApiError.forbidden('Only sales managers can assign deals.');
      if (request.ownerId) await this.requireSalesUser(access.teamId, request.ownerId);
      ownerId = request.ownerId;
    }
    await this.requireServices(access, request.items);
    const { rows, amount } = lineTotals(request.items);
    const currency = request.currency ?? access.settings.defaultCurrency;
    const deal = await this.prisma.deal.create({
      data: {
        tenantId: access.teamId,
        title: request.title,
        type: request.type,
        leadId,
        businessId,
        ownerId,
        amount,
        currency,
        expectedCloseAt: request.expectedCloseAt ?? null,
        notes: request.notes ?? null,
        createdById: actor.userId,
        items: { create: rows },
      },
      select: { id: true },
    });
    if (leadId) {
      await this.prisma.leadActivity.create({
        data: {
          leadId,
          type: 'NOTE',
          body: `Deal created: ${request.title} (${amount.toFixed(2)} ${currency})`,
          actorId: actor.userId,
        },
      });
    }
    return this.getDeal(actor, deal.id);
  }

  private async requireServices(access: Access, items: LineItemInput[]): Promise<void> {
    const ids = [...new Set(items.map((i) => i.serviceId).filter((v): v is string => !!v))];
    if (ids.length === 0) return;
    const found = await this.prisma.crmService.count({
      where: { id: { in: ids }, tenantId: access.teamId },
    });
    if (found !== ids.length) throw ApiError.validation('A chosen service was not found.', 'items');
  }

  private async editableDeal(actor: Actor, dealId: string) {
    const access = await this.access(actor);
    const deal = await this.prisma.deal.findFirst({
      where: { AND: [{ id: dealId }, this.dealWhere(actor, access)] },
      select: {
        id: true,
        status: true,
        ownerId: true,
        leadId: true,
        title: true,
        amount: true,
        currency: true,
        type: true,
      },
    });
    if (!deal) throw ApiError.notFound('Deal');
    if (!access.seeAll && deal.ownerId !== actor.userId)
      throw ApiError.forbidden('Only the owner or a sales manager can change this deal.');
    return { deal, access };
  }

  async updateDeal(actor: Actor, dealId: string, request: UpdateDealRequest): Promise<DealDto> {
    const { deal, access } = await this.editableDeal(actor, dealId);
    if (request.ownerId !== undefined && request.ownerId !== deal.ownerId) {
      if (!access.assign) throw ApiError.forbidden('Only sales managers can assign deals.');
      if (request.ownerId) await this.requireSalesUser(access.teamId, request.ownerId);
    }
    let items: ReturnType<typeof lineTotals> | null = null;
    if (request.items) {
      if (deal.status !== 'OPEN' && !access.seeAll)
        throw ApiError.conflict('A closed deal can only be changed by a sales manager.');
      await this.requireServices(access, request.items);
      items = lineTotals(request.items);
    }
    await this.prisma.$transaction(async (tx) => {
      if (items) {
        await tx.dealItem.deleteMany({ where: { dealId } });
        await tx.dealItem.createMany({ data: items.rows.map((r) => ({ ...r, dealId })) });
      }
      await tx.deal.update({
        where: { id: dealId },
        data: {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.ownerId !== undefined ? { ownerId: request.ownerId } : {}),
          ...(request.expectedCloseAt !== undefined
            ? { expectedCloseAt: request.expectedCloseAt }
            : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          ...(items ? { amount: items.amount } : {}),
        },
      });
    });
    return this.getDeal(actor, dealId);
  }

  /** Won deals count towards the owner's target; winning a new-business deal wins its lead. */
  async changeDealStatus(
    actor: Actor,
    dealId: string,
    request: ChangeDealStatusRequest,
  ): Promise<DealDto> {
    const { deal } = await this.editableDeal(actor, dealId);
    if (deal.status === request.status) return this.getDeal(actor, dealId);
    const closedAt = request.status === 'OPEN' ? null : (request.closedAt ?? new Date());
    if (closedAt && closedAt > new Date(Date.now() + 60_000))
      throw ApiError.validation('The closing date cannot be in the future.', 'closedAt');
    await this.prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: request.status,
          closedAt,
          lostReason: request.status === 'LOST' ? (request.lostReason ?? null) : null,
        },
      });
      if (!deal.leadId) return;
      const lead = await tx.lead.findUnique({
        where: { id: deal.leadId },
        select: { stage: true },
      });
      const leadOpen = !!lead && (OPEN_LEAD_STAGES as readonly string[]).includes(lead.stage);
      const winLead = request.status === 'WON' && deal.type === 'NEW_BUSINESS' && leadOpen;
      if (winLead) {
        await tx.lead.update({
          where: { id: deal.leadId },
          data: {
            stage: 'WON',
            closedAt,
            stageChangedAt: new Date(),
            lastActivityAt: new Date(),
          },
        });
      }
      await tx.leadActivity.create({
        data: {
          leadId: deal.leadId,
          type: winLead ? 'STAGE_CHANGED' : 'NOTE',
          ...(winLead ? { fromStage: lead!.stage, toStage: 'WON' as const } : {}),
          body:
            request.status === 'WON'
              ? `Deal won: ${deal.title} (${num(deal.amount).toFixed(2)} ${deal.currency})`
              : request.status === 'LOST'
                ? `Deal lost: ${deal.title} — ${request.lostReason ?? ''}`
                : `Deal reopened: ${deal.title}`,
          actorId: actor.userId,
        },
      });
    });
    return this.getDeal(actor, dealId);
  }

  async removeDeal(actor: Actor, dealId: string): Promise<void> {
    const { deal } = await this.editableDeal(actor, dealId);
    const billed = await this.prisma.invoice.count({
      where: { dealId, status: { not: 'VOID' } },
    });
    if (billed > 0) throw ApiError.conflict('This deal has invoices. Void them first.');
    await this.prisma.deal.update({ where: { id: dealId }, data: { deletedAt: new Date() } });
    await this.audit.record(actor, {
      action: 'crm.deal_deleted',
      targetType: 'Deal',
      targetId: dealId,
      metadata: { title: deal.title },
    });
  }

  // ───────────────────────────── Invoices and payments ─────────────────────────────

  private invoiceWhere(actor: Actor, access: Access): Prisma.InvoiceWhereInput {
    return access.billing || access.seeAll
      ? { tenantId: access.teamId }
      : { tenantId: access.teamId, deal: { ownerId: actor.userId } };
  }

  private toInvoice(row: InvoiceRow, access: Access): InvoiceDto {
    const total = num(row.total);
    const paid = num(row.amountPaid);
    const open = row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID';
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      overdue: open && isoDate(row.dueDate) < isoDate(dateOnly(new Date())),
      deal: row.deal ? { id: row.deal.id, title: row.deal.title, type: row.deal.type } : null,
      customer: this.customerOf(access, row.business, row.lead),
      lead: row.lead,
      billToName: row.billToName,
      billToEmail: row.billToEmail,
      billToPhone: row.billToPhone,
      billToAddress: row.billToAddress,
      billToTaxNumber: row.billToTaxNumber,
      issueDate: isoDate(row.issueDate),
      dueDate: isoDate(row.dueDate),
      currency: row.currency,
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      taxRate: num(row.taxRate),
      taxAmount: num(row.taxAmount),
      total,
      amountPaid: paid,
      balance: row.status === 'VOID' ? 0 : round2(total - paid),
      notes: row.notes,
      items: row.items.map((i) => ({
        id: i.id,
        serviceId: i.serviceId,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        total: num(i.total),
      })),
      payments: row.payments.map((p) => ({
        id: p.id,
        amount: num(p.amount),
        paidAt: p.paidAt.toISOString(),
        method: p.method,
        reference: p.reference,
        notes: p.notes,
        recordedBy: p.recordedBy ? toPublicUser(p.recordedBy) : null,
        voided: p.voidedAt !== null,
      })),
      issuedAt: row.issuedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      lastEmailedAt: row.lastEmailedAt?.toISOString() ?? null,
      subscription: row.subscription,
      periodStart: row.periodStart ? isoDate(row.periodStart) : null,
      periodEnd: row.periodEnd ? isoDate(row.periodEnd) : null,
      reminderCount: row.reminderCount,
      lastReminderAt: row.lastReminderAt?.toISOString() ?? null,
      payUrl:
        row.payToken && row.status !== 'DRAFT' && row.status !== 'VOID'
          ? `/pay/${row.payToken}`
          : null,
      pendingClaims: row._count.claims,
      fbr:
        row.fbrInvoiceNumber || row.fbrError
          ? {
              invoiceNumber: row.fbrInvoiceNumber,
              submittedAt: row.fbrSubmittedAt?.toISOString() ?? null,
              sandbox: row.fbrSandbox,
              error: row.fbrInvoiceNumber ? null : row.fbrError,
              qrDataUrl: null,
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      canManage: access.billing,
    };
  }

  async listInvoices(actor: Actor, query: ListInvoicesQuery): Promise<InvoiceDto[]> {
    const access = await this.access(actor);
    const today = dateOnly(new Date());
    const q = query.q?.trim();
    const rows = await this.prisma.invoice.findMany({
      where: {
        AND: [
          this.invoiceWhere(actor, access),
          query.status === 'OVERDUE'
            ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: today } }
            : query.status === 'UNPAID'
              ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }
              : query.status
                ? { status: query.status }
                : {},
          query.businessId ? { businessId: query.businessId } : {},
          query.dealId ? { dealId: query.dealId } : {},
          q
            ? {
                OR: [
                  { number: { contains: q, mode: 'insensitive' } },
                  { billToName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      include: invoiceInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => this.toInvoice(r, access));
  }

  async getInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    const access = await this.access(actor);
    const row = await this.prisma.invoice.findFirst({
      where: { AND: [{ id: invoiceId }, this.invoiceWhere(actor, access)] },
      include: invoiceInclude,
    });
    if (!row) throw ApiError.notFound('Invoice');
    const dto = this.toInvoice(row, access);
    // The QR code printed on FBR invoices (only for the one invoice opened).
    if (dto.fbr?.invoiceNumber)
      dto.fbr.qrDataUrl = await QRCode.toDataURL(dto.fbr.invoiceNumber, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 160,
      });
    return dto;
  }

  private async requireBilling(actor: Actor): Promise<Access> {
    const access = await this.access(actor);
    if (!access.billing)
      throw ApiError.forbidden('Only sales managers can create invoices and record payments.');
    return access;
  }

  private async billTo(
    access: Access,
    businessId: string | null,
    leadId: string | null,
  ): Promise<{ name: string; email: string | null; phone: string | null; address: string | null }> {
    if (businessId) {
      if (!access.platform)
        throw ApiError.validation('Choose the customer from your won leads.', 'businessId');
      const b = await this.prisma.business.findFirst({
        where: { id: businessId, internal: false, deletedAt: null },
        select: { name: true, email: true, phone: true, address: true },
      });
      if (!b) throw ApiError.validation('Choose an SMA customer.', 'businessId');
      const a = (b.address ?? {}) as Record<string, string | undefined>;
      const address = [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
        .filter(Boolean)
        .join(', ');
      return { name: b.name, email: b.email, phone: b.phone, address: address || null };
    }
    if (leadId) {
      const l = await this.prisma.lead.findFirst({
        where: { id: leadId, tenantId: access.teamId, deletedAt: null },
        select: { companyName: true, email: true, phone: true, city: true, country: true },
      });
      if (!l) throw ApiError.validation('Lead not found.', 'leadId');
      return {
        name: l.companyName,
        email: l.email,
        phone: l.phone,
        address: [l.city, l.country].filter(Boolean).join(', ') || null,
      };
    }
    return { name: '', email: null, phone: null, address: null };
  }

  async createInvoice(actor: Actor, request: CreateInvoiceRequest): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    let businessId = request.businessId ?? null;
    let leadId = request.leadId ?? null;
    let currency: string = request.currency ?? access.settings.defaultCurrency;
    let items: Array<{
      serviceId: string | null;
      name: string;
      description: string | null;
      quantity: number;
      unitPrice: number;
      total: number;
      position: number;
    }> = [];
    if (request.dealId) {
      const deal = await this.prisma.deal.findFirst({
        where: { id: request.dealId, tenantId: access.teamId, deletedAt: null },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (!deal) throw ApiError.notFound('Deal');
      if (deal.status === 'LOST') throw ApiError.conflict('This deal was lost.');
      currency = deal.currency;
      businessId = businessId ?? deal.businessId;
      leadId = leadId ?? deal.leadId;
      items = deal.items.map((i, position) => {
        const discount = num(i.discountPct);
        return {
          serviceId: i.serviceId,
          name: i.name,
          description:
            [
              i.billing === 'MONTHLY' ? 'Monthly' : i.billing === 'YEARLY' ? 'Yearly' : null,
              discount > 0 ? `${discount}% discount` : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
          quantity: i.quantity,
          unitPrice: round2(num(i.total) / i.quantity),
          total: num(i.total),
          position,
        };
      });
    }
    if (request.items?.length) {
      await this.requireServices(
        access,
        request.items.map((i) => ({ ...i, discountPct: 0, billing: 'ONE_TIME' as const })),
      );
      items = request.items.map((i, position) => ({
        serviceId: i.serviceId ?? null,
        name: i.name,
        description: i.description ?? null,
        quantity: i.quantity,
        unitPrice: round2(i.unitPrice),
        total: round2(i.quantity * i.unitPrice),
        position,
      }));
    }
    if (items.length === 0) throw ApiError.validation('Add at least one item.', 'items');
    const party = await this.billTo(access, businessId, leadId);
    const name = request.billToName ?? party.name;
    if (!name) throw ApiError.validation('Who is the invoice for?', 'billToName');
    const issueDate = dateOnly(request.issueDate ?? new Date());
    const dueDate = dateOnly(
      request.dueDate ?? new Date(issueDate.getTime() + this.config.INVOICE_DUE_DAYS * 86_400_000),
    );
    if (dueDate < issueDate)
      throw ApiError.validation('The due date must be on or after the issue date.', 'dueDate');
    const id = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          tenantId: access.teamId,
          number: await this.factory.nextInvoiceNumber(tx, access.teamId),
          dealId: request.dealId ?? null,
          businessId,
          leadId,
          billToName: name,
          billToEmail: request.billToEmail !== undefined ? request.billToEmail : party.email,
          billToPhone: request.billToPhone !== undefined ? request.billToPhone : party.phone,
          billToAddress:
            request.billToAddress !== undefined ? request.billToAddress : party.address,
          issueDate,
          dueDate,
          currency,
          discount: request.discount ?? 0,
          taxRate: request.taxRate ?? access.settings.taxRate,
          notes: request.notes ?? null,
          createdById: actor.userId,
          items: { create: items },
        },
        select: { id: true },
      });
      await this.factory.recompute(tx, invoice.id);
      return invoice.id;
    });
    return this.getInvoice(actor, id);
  }

  async updateInvoice(
    actor: Actor,
    invoiceId: string,
    request: UpdateInvoiceRequest,
  ): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: access.teamId },
      select: { status: true, issueDate: true, dueDate: true },
    });
    if (!invoice) throw ApiError.notFound('Invoice');
    if (invoice.status !== 'DRAFT')
      throw ApiError.conflict('Only draft invoices can be changed. Void it and create a new one.');
    const issueDate = request.issueDate ? dateOnly(request.issueDate) : invoice.issueDate;
    const dueDate = request.dueDate ? dateOnly(request.dueDate) : invoice.dueDate;
    if (dueDate < issueDate)
      throw ApiError.validation('The due date must be on or after the issue date.', 'dueDate');
    await this.prisma.$transaction(async (tx) => {
      if (request.items) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId } });
        await tx.invoiceItem.createMany({
          data: request.items.map((i, position) => ({
            invoiceId,
            serviceId: i.serviceId ?? null,
            name: i.name,
            description: i.description ?? null,
            quantity: i.quantity,
            unitPrice: round2(i.unitPrice),
            total: round2(i.quantity * i.unitPrice),
            position,
          })),
        });
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          ...(request.billToName !== undefined ? { billToName: request.billToName } : {}),
          ...(request.billToEmail !== undefined ? { billToEmail: request.billToEmail } : {}),
          ...(request.billToPhone !== undefined ? { billToPhone: request.billToPhone } : {}),
          ...(request.billToAddress !== undefined ? { billToAddress: request.billToAddress } : {}),
          ...(request.discount !== undefined ? { discount: request.discount } : {}),
          ...(request.taxRate !== undefined ? { taxRate: request.taxRate } : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          issueDate,
          dueDate,
        },
      });
      await this.factory.recompute(tx, invoiceId);
    });
    return this.getInvoice(actor, invoiceId);
  }

  async issueInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    const updated = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, tenantId: access.teamId, status: 'DRAFT' },
      data: { status: 'ISSUED', issuedAt: new Date(), payToken: newPublicToken() },
    });
    if (updated.count === 0) throw ApiError.conflict('Only draft invoices can be issued.');
    await this.prisma.$transaction((tx) => this.factory.recompute(tx, invoiceId));
    return this.getInvoice(actor, invoiceId);
  }

  async voidInvoice(actor: Actor, invoiceId: string, reason: string): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: access.teamId },
      select: {
        status: true,
        number: true,
        _count: { select: { payments: { where: { voidedAt: null } } } },
      },
    });
    if (!invoice) throw ApiError.notFound('Invoice');
    if (invoice.status === 'VOID') return this.getInvoice(actor, invoiceId);
    if (invoice._count.payments > 0)
      throw ApiError.conflict('This invoice has payments. Remove them first.');
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    });
    await this.audit.record(actor, {
      action: 'crm.invoice_voided',
      businessId: access.teamId,
      targetType: 'Invoice',
      targetId: invoiceId,
      metadata: { number: invoice.number },
    });
    return this.getInvoice(actor, invoiceId);
  }

  async recordPayment(
    actor: Actor,
    invoiceId: string,
    request: RecordPaymentRequest,
  ): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    await this.prisma.$transaction(async (tx) => {
      // Lock the invoice row so two payments cannot overshoot the total together.
      await tx.$executeRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, tenantId: access.teamId },
        select: { status: true, total: true, amountPaid: true, number: true },
      });
      if (!invoice) throw ApiError.notFound('Invoice');
      if (invoice.status === 'VOID') throw ApiError.conflict('This invoice was voided.');
      if (invoice.status === 'PAID') throw ApiError.conflict('This invoice is already paid.');
      const balance = round2(num(invoice.total) - num(invoice.amountPaid));
      if (request.amount > balance + 0.004)
        throw ApiError.validation(
          `That is more than the amount due (${balance.toFixed(2)}).`,
          'amount',
        );
      if (invoice.status === 'DRAFT') {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: 'ISSUED', issuedAt: new Date(), payToken: newPublicToken() },
        });
      }
      await tx.payment.create({
        data: {
          invoiceId,
          amount: request.amount,
          paidAt: request.paidAt ?? new Date(),
          method: request.method,
          reference: request.reference ?? null,
          notes: request.notes ?? null,
          recordedById: actor.userId,
        },
      });
      await this.factory.recompute(tx, invoiceId);
      await this.audit.record(
        actor,
        {
          action: 'crm.payment_recorded',
          businessId: access.teamId,
          targetType: 'Invoice',
          targetId: invoiceId,
          metadata: { number: invoice.number, amount: request.amount, method: request.method },
        },
        tx,
      );
    });
    return this.getInvoice(actor, invoiceId);
  }

  async voidPayment(actor: Actor, invoiceId: string, paymentId: string): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, invoiceId, invoice: { tenantId: access.teamId }, voidedAt: null },
        data: { voidedAt: new Date() },
      });
      if (updated.count === 0) throw ApiError.notFound('Payment');
      await this.factory.recompute(tx, invoiceId);
      await this.audit.record(
        actor,
        { action: 'crm.payment_voided', targetType: 'Invoice', targetId: invoiceId },
        tx,
      );
    });
    return this.getInvoice(actor, invoiceId);
  }

  /** Sends the invoice as an HTML email to the bill-to address. */
  async emailInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    const access = await this.requireBilling(actor);
    const invoice = await this.getInvoice(actor, invoiceId);
    if (invoice.status === 'DRAFT') throw ApiError.conflict('Issue the invoice before sending it.');
    if (invoice.status === 'VOID') throw ApiError.conflict('This invoice was voided.');
    if (!invoice.billToEmail)
      throw ApiError.validation('Add the customer’s email address first.', 'billToEmail');
    if (!this.mail.enabled)
      throw ApiError.conflict('Email is not set up yet. Add the mail server in Integrations.');
    const settings = access.settings;
    const doc = invoiceDocument(invoice, this.crmSettings);
    const sent = await this.mail.send({
      to: invoice.billToEmail,
      subject: `Invoice ${invoice.number} from ${settings.companyName}`,
      text: documentText(doc, settings),
      html: documentHtml(doc, settings),
    });
    if (!sent)
      throw ApiError.conflict('The mail server did not accept the email. Try again later.');
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { lastEmailedAt: new Date() },
    });
    return this.getInvoice(actor, invoiceId);
  }

  // ───────────────────────────── Customers ─────────────────────────────

  async customers(actor: Actor): Promise<CrmCustomerDto[]> {
    const access = await this.access(actor);
    if (!access.platform) return this.leadCustomers(access);
    const businesses = await this.prisma.business.findMany({
      where: { internal: false, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        sourceLead: {
          select: { id: true, convertedAt: true, owner: { select: publicUserSelect } },
        },
        _count: { select: { stores: { where: { deletedAt: null } } } },
        deals: {
          where: { tenantId: access.teamId, deletedAt: null },
          select: {
            status: true,
            type: true,
            amount: true,
            currency: true,
            items: { select: { name: true } },
          },
        },
        invoices: {
          where: { tenantId: access.teamId, status: { not: 'VOID' } },
          select: { total: true, amountPaid: true, status: true, currency: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return businesses.map((b) => {
      const won = b.deals.filter((d) => d.status === 'WON');
      const invoiced = round2(
        b.invoices
          .filter((i) => i.status !== 'DRAFT')
          .reduce((s, i) => s + this.main(access, num(i.total), i.currency), 0),
      );
      const paid = round2(
        b.invoices.reduce((s, i) => s + this.main(access, num(i.amountPaid), i.currency), 0),
      );
      return {
        id: b.id,
        kind: 'BUSINESS' as const,
        name: b.name,
        slug: b.slug,
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        lead: b.sourceLead
          ? {
              id: b.sourceLead.id,
              owner: b.sourceLead.owner ? toPublicUser(b.sourceLead.owner) : null,
              convertedAt: b.sourceLead.convertedAt?.toISOString() ?? null,
            }
          : null,
        storeCount: b._count.stores,
        wonDeals: won.length,
        upsells: won.filter((d) => d.type === 'UPSELL').length,
        lifetimeValue: round2(
          won.reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
        ),
        invoiced,
        paid,
        outstanding: round2(invoiced - paid),
        openDeals: b.deals.filter((d) => d.status === 'OPEN').length,
        services: [...new Set(won.flatMap((d) => d.items.map((i) => i.name)))].slice(0, 12),
      };
    });
  }

  /** A business's own customers: its won leads. */
  private async leadCustomers(access: Access): Promise<CrmCustomerDto[]> {
    const leads = await this.prisma.lead.findMany({
      where: { tenantId: access.teamId, deletedAt: null, stage: 'WON' },
      select: {
        id: true,
        companyName: true,
        storeCount: true,
        closedAt: true,
        createdAt: true,
        owner: { select: publicUserSelect },
        deals: {
          where: { deletedAt: null },
          select: {
            status: true,
            type: true,
            amount: true,
            currency: true,
            items: { select: { name: true } },
          },
        },
        invoices: {
          where: { status: { not: 'VOID' } },
          select: { total: true, amountPaid: true, status: true, currency: true },
        },
      },
      orderBy: { companyName: 'asc' },
      take: 2000,
    });
    return leads.map((l) => {
      const won = l.deals.filter((d) => d.status === 'WON');
      const invoiced = round2(
        l.invoices
          .filter((i) => i.status !== 'DRAFT')
          .reduce((s, i) => s + this.main(access, num(i.total), i.currency), 0),
      );
      const paid = round2(
        l.invoices.reduce((s, i) => s + this.main(access, num(i.amountPaid), i.currency), 0),
      );
      return {
        id: l.id,
        kind: 'LEAD' as const,
        name: l.companyName,
        slug: '',
        status: 'ACTIVE',
        createdAt: (l.closedAt ?? l.createdAt).toISOString(),
        lead: {
          id: l.id,
          owner: l.owner ? toPublicUser(l.owner) : null,
          convertedAt: l.closedAt?.toISOString() ?? null,
        },
        storeCount: l.storeCount ?? 0,
        wonDeals: won.length,
        upsells: won.filter((d) => d.type === 'UPSELL').length,
        lifetimeValue: round2(
          won.reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
        ),
        invoiced,
        paid,
        outstanding: round2(invoiced - paid),
        openDeals: l.deals.filter((d) => d.status === 'OPEN').length,
        services: [...new Set(won.flatMap((d) => d.items.map((i) => i.name)))].slice(0, 12),
      };
    });
  }

  // ───────────────────────────── Targets ─────────────────────────────

  private async salesPeople(teamId: string) {
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        businessId: teamId,
        revokedAt: null,
        role: { key: { in: [...SALES_PEOPLE_ROLE_KEYS] }, isSystem: true },
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { user: { select: publicUserSelect } },
    });
    const people = new Map(rows.map((r) => [r.user.id, toPublicUser(r.user)]));
    return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Won value, counts, closed leads and collected payments per owner for a month. */
  private async achievements(access: Access, start: Date, end: Date, userIds: string[]) {
    const [deals, leads, payments] = await Promise.all([
      this.prisma.deal.findMany({
        where: {
          tenantId: access.teamId,
          deletedAt: null,
          status: 'WON',
          closedAt: { gte: start, lt: end },
          ownerId: { in: userIds },
        },
        select: { ownerId: true, amount: true, type: true, currency: true },
      }),
      this.prisma.lead.groupBy({
        by: ['ownerId', 'stage'],
        where: {
          tenantId: access.teamId,
          deletedAt: null,
          closedAt: { gte: start, lt: end },
          stage: { in: ['WON', 'LOST'] },
          ownerId: { in: userIds },
        },
        _count: { _all: true },
      }),
      this.prisma.payment.findMany({
        where: {
          voidedAt: null,
          paidAt: { gte: start, lt: end },
          invoice: {
            tenantId: access.teamId,
            status: { not: 'VOID' },
            deal: { ownerId: { in: userIds } },
          },
        },
        select: {
          amount: true,
          invoice: { select: { currency: true, deal: { select: { ownerId: true } } } },
        },
      }),
    ]);
    const by = new Map<
      string,
      {
        achieved: number;
        won: number;
        upsells: number;
        closed: number;
        leadsWon: number;
        collected: number;
      }
    >();
    const get = (id: string) => {
      let v = by.get(id);
      if (!v) {
        v = { achieved: 0, won: 0, upsells: 0, closed: 0, leadsWon: 0, collected: 0 };
        by.set(id, v);
      }
      return v;
    };
    for (const d of deals) {
      const v = get(d.ownerId!);
      v.achieved = round2(v.achieved + this.main(access, num(d.amount), d.currency));
      v.won += 1;
      if (d.type === 'UPSELL') v.upsells += 1;
    }
    for (const l of leads) {
      const v = get(l.ownerId!);
      v.closed += l._count._all;
      if (l.stage === 'WON') v.leadsWon += l._count._all;
    }
    for (const p of payments) {
      const owner = p.invoice.deal?.ownerId;
      if (owner)
        get(owner).collected = round2(
          get(owner).collected + this.main(access, num(p.amount), p.invoice.currency),
        );
    }
    return by;
  }

  async targets(actor: Actor, month: string): Promise<TargetsDto> {
    const access = await this.access(actor);
    const [start, end] = monthRange(month);
    let people = await this.salesPeople(access.teamId);
    if (!access.seeAll && !access.targets) people = people.filter((p) => p.id === actor.userId);
    const ids = people.map((p) => p.id);
    const [targets, achieved] = await Promise.all([
      this.prisma.salesTarget.findMany({
        where: { tenantId: access.teamId, userId: { in: ids }, month: monthDate(month) },
        select: { userId: true, amount: true },
      }),
      this.achievements(access, start, end, ids),
    ]);
    const targetBy = new Map(targets.map((t) => [t.userId, num(t.amount)]));
    const plans = await this.commissionPlans(access.teamId);
    const team: TargetProgressDto[] = people.map((user) => {
      const a = achieved.get(user.id);
      const target = targetBy.get(user.id) ?? null;
      const value = a?.achieved ?? 0;
      const plan = plans.get(user.id) ?? plans.get('team')!;
      return {
        commission: commissionFor(plan, plan.basis === 'WON' ? value : (a?.collected ?? 0), target),
        commissionPlan: {
          baseRate: plan.baseRate,
          bonusRate: plan.bonusRate,
          basis: plan.basis,
          custom: plans.has(user.id),
        },
        user,
        month,
        target,
        achieved: value,
        progress: target && target > 0 ? value / target : null,
        wonDeals: a?.won ?? 0,
        upsells: a?.upsells ?? 0,
        leadsClosed: a?.closed ?? 0,
        leadsWon: a?.leadsWon ?? 0,
        collected: a?.collected ?? 0,
      };
    });
    return {
      month,
      currency: access.settings.defaultCurrency,
      team,
      totals: {
        target: round2(team.reduce((s, t) => s + (t.target ?? 0), 0)),
        achieved: round2(team.reduce((s, t) => s + t.achieved, 0)),
        collected: round2(team.reduce((s, t) => s + t.collected, 0)),
        commission: round2(team.reduce((s, t) => s + t.commission, 0)),
      },
      canManage: access.targets,
    };
  }

  async setTarget(actor: Actor, request: SetTargetRequest): Promise<TargetsDto> {
    const access = await this.access(actor);
    if (!access.targets) throw ApiError.forbidden('Only sales managers can set targets.');
    await this.requireSalesUser(access.teamId, request.userId);
    const month = monthDate(request.month);
    await this.prisma.salesTarget.upsert({
      where: { tenantId_userId_month: { tenantId: access.teamId, userId: request.userId, month } },
      create: {
        tenantId: access.teamId,
        userId: request.userId,
        month,
        amount: request.amount,
        currency: access.settings.defaultCurrency,
        setById: actor.userId,
      },
      update: { amount: request.amount, setById: actor.userId },
    });
    return this.targets(actor, request.month);
  }

  async targetHistory(actor: Actor, userId: string, months = 12): Promise<TargetHistoryDto> {
    const access = await this.access(actor);
    if (userId !== actor.userId && !access.seeAll && !access.targets) throw ApiError.forbidden();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelect,
    });
    if (!user) throw ApiError.notFound('User');
    const now = new Date();
    const keys = Array.from({ length: months }, (_, i) =>
      monthKey(new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1)),
    );
    const [first] = monthRange(keys[0]!);
    const [, last] = monthRange(keys[keys.length - 1]!);
    const [targets, deals, leads] = await Promise.all([
      this.prisma.salesTarget.findMany({
        where: {
          tenantId: access.teamId,
          userId,
          month: { gte: monthDate(keys[0]!), lte: monthDate(keys.at(-1)!) },
        },
        select: { month: true, amount: true },
      }),
      this.prisma.deal.findMany({
        where: {
          tenantId: access.teamId,
          ownerId: userId,
          status: 'WON',
          deletedAt: null,
          closedAt: { gte: first, lt: last },
        },
        select: { amount: true, closedAt: true, currency: true },
      }),
      this.prisma.lead.findMany({
        where: {
          tenantId: access.teamId,
          ownerId: userId,
          stage: 'WON',
          deletedAt: null,
          closedAt: { gte: first, lt: last },
        },
        select: { closedAt: true },
      }),
    ]);
    const targetBy = new Map(
      targets.map((t) => [t.month.toISOString().slice(0, 7), num(t.amount)]),
    );
    const plans = await this.commissionPlans(access.teamId);
    const plan = plans.get(userId) ?? plans.get('team')!;
    return {
      user: toPublicUser(user),
      currency: access.settings.defaultCurrency,
      months: keys.map((key) => {
        const achieved = round2(
          deals
            .filter((d) => d.closedAt && monthKey(d.closedAt) === key)
            .reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
        );
        const target = targetBy.get(key) ?? null;
        return {
          month: key,
          target,
          achieved,
          leadsWon: leads.filter((l) => l.closedAt && monthKey(l.closedAt) === key).length,
          // History shows commission on won value (collections per month are on the Targets tab).
          commission: commissionFor(plan, achieved, target),
        };
      }),
    };
  }

  // ───────────────────────────── Commission ─────────────────────────────

  /** "team" plus per-person overrides. */
  private async commissionPlans(tenantId: string) {
    const rows = await this.prisma.commissionPlan.findMany({ where: { tenantId } });
    const plans = new Map<
      string,
      { baseRate: number; bonusRate: number; basis: 'WON' | 'COLLECTED' }
    >(
      rows.map((r) => [
        r.scope,
        { baseRate: num(r.baseRate), bonusRate: num(r.bonusRate), basis: r.basis },
      ]),
    );
    if (!plans.has('team')) plans.set('team', { baseRate: 5, bonusRate: 10, basis: 'WON' });
    return plans;
  }

  async listCommissionPlans(actor: Actor): Promise<CommissionPlanDto[]> {
    const access = await this.access(actor);
    const plans = await this.commissionPlans(access.teamId);
    const people = await this.salesPeople(access.teamId);
    const team = plans.get('team')!;
    return [
      { scope: 'team', user: null, ...team },
      ...people
        .filter(
          (p) => plans.has(p.id) && (access.seeAll || access.targets || p.id === actor.userId),
        )
        .map((p) => ({ scope: p.id, user: p, ...plans.get(p.id)! })),
    ];
  }

  async setCommissionPlan(
    actor: Actor,
    request: SetCommissionPlanRequest,
  ): Promise<CommissionPlanDto[]> {
    const access = await this.access(actor);
    if (!access.targets) throw ApiError.forbidden('Only sales managers can change commission.');
    if (request.scope !== 'team') await this.requireSalesUser(access.teamId, request.scope);
    await this.prisma.commissionPlan.upsert({
      where: { tenantId_scope: { tenantId: access.teamId, scope: request.scope } },
      create: { ...request, tenantId: access.teamId, updatedById: actor.userId },
      update: {
        baseRate: request.baseRate,
        bonusRate: request.bonusRate,
        basis: request.basis,
        updatedById: actor.userId,
      },
    });
    return this.listCommissionPlans(actor);
  }

  async removeCommissionPlan(actor: Actor, scope: string): Promise<CommissionPlanDto[]> {
    const access = await this.access(actor);
    if (!access.targets) throw ApiError.forbidden('Only sales managers can change commission.');
    if (scope === 'team') throw ApiError.validation('The team plan cannot be removed.', 'scope');
    await this.prisma.commissionPlan.deleteMany({ where: { tenantId: access.teamId, scope } });
    return this.listCommissionPlans(actor);
  }

  // ───────────────────────────── Payment claims ─────────────────────────────

  async listClaims(
    actor: Actor,
    status?: 'PENDING' | 'CONFIRMED' | 'REJECTED',
  ): Promise<PaymentClaimDto[]> {
    const access = await this.access(actor);
    if (!access.billing && !access.seeAll) throw ApiError.forbidden();
    const rows = await this.prisma.paymentClaim.findMany({
      where: { invoice: { tenantId: access.teamId }, ...(status ? { status } : {}) },
      include: {
        invoice: {
          select: {
            id: true,
            number: true,
            billToName: true,
            currency: true,
            total: true,
            amountPaid: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((c) => ({
      id: c.id,
      invoice: {
        id: c.invoice.id,
        number: c.invoice.number,
        billToName: c.invoice.billToName,
        currency: c.invoice.currency,
        balance: round2(num(c.invoice.total) - num(c.invoice.amountPaid)),
      },
      amount: num(c.amount),
      method: c.method,
      reference: c.reference,
      payerName: c.payerName,
      note: c.note,
      status: c.status,
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      reviewNote: c.reviewNote,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  /** Confirming a customer's "I have paid" records the payment on the invoice. */
  async reviewClaim(
    actor: Actor,
    claimId: string,
    request: ReviewPaymentClaimRequest,
  ): Promise<PaymentClaimDto[]> {
    const access = await this.requireBilling(actor);
    const claim = await this.prisma.paymentClaim.findFirst({
      where: { id: claimId, invoice: { tenantId: access.teamId } },
    });
    if (!claim) throw ApiError.notFound('Payment');
    if (claim.status !== 'PENDING') throw ApiError.conflict('This payment was already reviewed.');
    if (request.action === 'confirm') {
      const invoice = await this.prisma.invoice.findUniqueOrThrow({
        where: { id: claim.invoiceId },
        select: { total: true, amountPaid: true },
      });
      const balance = round2(num(invoice.total) - num(invoice.amountPaid));
      const amount = Math.min(num(claim.amount), balance);
      if (amount <= 0) throw ApiError.conflict('This invoice is already paid.');
      await this.recordPayment(actor, claim.invoiceId, {
        amount,
        paidAt: claim.createdAt,
        method: claim.method,
        reference: claim.reference,
        notes:
          [claim.payerName ? `Paid by ${claim.payerName}` : null, claim.note]
            .filter(Boolean)
            .join(' — ') || null,
      });
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: claim.invoiceId, reference: claim.reference },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      await this.prisma.paymentClaim.update({
        where: { id: claimId },
        data: {
          status: 'CONFIRMED',
          paymentId: payment?.id ?? null,
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          reviewNote: request.note ?? null,
        },
      });
    } else {
      await this.prisma.paymentClaim.update({
        where: { id: claimId },
        data: {
          status: 'REJECTED',
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          reviewNote: request.note ?? null,
        },
      });
    }
    await this.audit.record(actor, {
      action: `crm.payment_claim_${request.action === 'confirm' ? 'confirmed' : 'rejected'}`,
      businessId: access.teamId,
      targetType: 'Invoice',
      targetId: claim.invoiceId,
      metadata: { amount: num(claim.amount), method: claim.method },
    });
    return this.listClaims(actor, 'PENDING');
  }

  // ───────────────────────────── Overview ─────────────────────────────

  async overview(actor: Actor): Promise<CrmOverviewDto> {
    const access = await this.access(actor);
    const dealScope = this.dealWhere(actor, access);
    const invoiceScope = this.invoiceWhere(actor, access);
    const now = new Date();
    const month = monthKey(now);
    const [start, end] = monthRange(month);
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const today = dateOnly(now);
    const [won, open, invoices, payments, items] = await Promise.all([
      this.prisma.deal.findMany({
        where: { AND: [dealScope, { status: 'WON', closedAt: { gte: trendStart, lt: end } }] },
        select: { amount: true, closedAt: true, type: true, currency: true },
      }),
      this.prisma.deal.findMany({
        where: { AND: [dealScope, { status: 'OPEN' }] },
        select: { amount: true, currency: true },
      }),
      this.prisma.invoice.findMany({
        where: { AND: [invoiceScope, { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } }] },
        select: {
          total: true,
          amountPaid: true,
          status: true,
          dueDate: true,
          issueDate: true,
          currency: true,
        },
      }),
      this.prisma.payment.findMany({
        where: {
          voidedAt: null,
          paidAt: { gte: trendStart, lt: end },
          invoice: { AND: [invoiceScope, { status: { not: 'VOID' } }] },
        },
        select: { amount: true, paidAt: true, invoice: { select: { currency: true } } },
      }),
      this.prisma.dealItem.findMany({
        where: { deal: { AND: [dealScope, { status: 'WON' }] } },
        select: { name: true, total: true, deal: { select: { currency: true } } },
      }),
    ]);
    const thisMonth = won.filter((d) => d.closedAt && d.closedAt >= start);
    const unpaid = invoices.filter((i) => i.status !== 'PAID');
    const overdue = unpaid.filter((i) => i.dueDate < today);
    const services = new Map<string, { name: string; count: number; value: number }>();
    for (const i of items) {
      const s = services.get(i.name) ?? { name: i.name, count: 0, value: 0 };
      s.count += 1;
      s.value = round2(s.value + this.main(access, num(i.total), i.deal.currency));
      services.set(i.name, s);
    }
    const trend = Array.from({ length: 6 }, (_, i) => {
      const key = monthKey(new Date(now.getFullYear(), now.getMonth() - 5 + i, 1));
      return {
        month: key,
        won: round2(
          won
            .filter((d) => d.closedAt && monthKey(d.closedAt) === key)
            .reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
        ),
        collected: round2(
          payments
            .filter((p) => monthKey(p.paidAt) === key)
            .reduce((s, p) => s + this.main(access, num(p.amount), p.invoice.currency), 0),
        ),
      };
    });
    return {
      currency: access.settings.defaultCurrency,
      month,
      wonThisMonth: round2(
        thisMonth.reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
      ),
      wonCountThisMonth: thisMonth.length,
      upsellThisMonth: round2(
        thisMonth
          .filter((d) => d.type === 'UPSELL')
          .reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
      ),
      openPipeline: round2(
        open.reduce((s, d) => s + this.main(access, num(d.amount), d.currency), 0),
      ),
      openDeals: open.length,
      invoicedThisMonth: round2(
        invoices
          .filter((i) => i.issueDate >= dateOnly(start) && i.issueDate < dateOnly(end))
          .reduce((s, i) => s + this.main(access, num(i.total), i.currency), 0),
      ),
      collectedThisMonth: trend.at(-1)!.collected,
      outstanding: round2(
        unpaid.reduce(
          (s, i) => s + this.main(access, num(i.total) - num(i.amountPaid), i.currency),
          0,
        ),
      ),
      overdue: round2(
        overdue.reduce(
          (s, i) => s + this.main(access, num(i.total) - num(i.amountPaid), i.currency),
          0,
        ),
      ),
      overdueCount: overdue.length,
      trend,
      topServices: [...services.values()].sort((a, b) => b.value - a.value).slice(0, 6),
      canManageBilling: access.billing,
      canManageCatalog: access.catalog,
      canManageTargets: access.targets,
    };
  }
}

/** Base rate up to the target, bonus rate on everything above it (no target: base rate). */
export function commissionFor(
  plan: { baseRate: number; bonusRate: number },
  value: number,
  target: number | null,
): number {
  if (!target || target <= 0) return round2((value * plan.baseRate) / 100);
  const within = Math.min(value, target);
  const above = Math.max(0, value - target);
  return round2((within * plan.baseRate + above * plan.bonusRate) / 100);
}

// ───────────────────────────── Invoice email ─────────────────────────────

/** An invoice as an email document, with its pay page link. */
export function invoiceDocument(i: InvoiceDto, settings: CrmSettingsService) {
  return {
    kind: 'Invoice' as const,
    number: i.number,
    billToName: i.billToName,
    issueDate: i.issueDate,
    dueLabel: 'Due',
    dueDate: i.dueDate,
    currency: i.currency,
    items: i.items,
    subtotal: i.subtotal,
    discount: i.discount,
    taxRate: i.taxRate,
    taxAmount: i.taxAmount,
    total: i.total,
    amountPaid: i.amountPaid,
    balance: i.balance,
    notes: i.notes,
    actionUrl: i.payUrl ? settings.link(i.payUrl) : null,
    actionLabel: 'View and pay',
  };
}
