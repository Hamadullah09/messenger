import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type CreateSubscriptionRequest,
  type PublicInvoiceDto,
  type SubmitPaymentClaimRequest,
  type SubscriptionDto,
  type UpdateSubscriptionRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { CrmSettingsService, dateOnly, isoDate, num, round2, today } from './crm-core';
import { SalesService } from './sales.service';

const subscriptionInclude = {
  business: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true } },
  deal: { select: { id: true, title: true } },
  items: { orderBy: { position: 'asc' } },
  invoices: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { id: true, number: true, status: true },
  },
  _count: { select: { invoices: true } },
} as const satisfies Prisma.SubscriptionInclude;
type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionInclude }>;

const PAY_LIMIT = { name: 'public:pay', limit: 20, windowSeconds: 3600 } as const;

/** Adds one billing period to a DATE. */
export function nextPeriod(date: Date, interval: 'MONTHLY' | 'YEARLY'): Date {
  const d = new Date(date);
  if (interval === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/**
 * Monthly/yearly billing for customers (SMA's: businesses on SMA; a business's own: won leads). The worker creates and sends the invoices on the
 * date (see BillingScheduler); this service manages the plans.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly settings: CrmSettingsService,
    private readonly audit: AuditService,
  ) {}

  private async access(actor: Actor, write: boolean) {
    const tenant = await this.sales.tenant(actor);
    const businessId = tenant.businessId;
    await this.authz.require(actor, 'sales.access', { businessId });
    const billing = await this.authz.can(actor, 'sales.billing.manage', { businessId });
    const seeAll = await this.authz.can(actor, 'sales.lead.read_all', { businessId });
    if (write && !billing) throw ApiError.forbidden('Only sales managers can change billing.');
    if (!write && !billing && !seeAll) throw ApiError.forbidden();
    return tenant;
  }

  private toDto(row: SubscriptionRow): SubscriptionDto {
    return {
      id: row.id,
      customer: row.business
        ? { ...row.business, kind: 'BUSINESS' }
        : row.lead
          ? { id: row.lead.id, name: row.lead.companyName, kind: 'LEAD' }
          : null,
      deal: row.deal,
      name: row.name,
      currency: row.currency,
      interval: row.interval as 'MONTHLY' | 'YEARLY',
      status: row.status,
      nextInvoiceAt: isoDate(row.nextInvoiceAt),
      dueDays: row.dueDays,
      taxRate: num(row.taxRate),
      autoEmail: row.autoEmail,
      items: row.items.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
      })),
      amount: round2(row.items.reduce((s, i) => s + i.quantity * num(i.unitPrice), 0)),
      invoiceCount: row._count.invoices,
      lastInvoice: row.invoices[0] ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(actor: Actor, customerId?: string): Promise<SubscriptionDto[]> {
    const tenant = await this.access(actor, false);
    const rows = await this.prisma.subscription.findMany({
      where: {
        tenantId: tenant.businessId,
        ...(customerId ? { OR: [{ businessId: customerId }, { leadId: customerId }] } : {}),
      },
      include: subscriptionInclude,
      orderBy: [{ status: 'asc' }, { nextInvoiceAt: 'asc' }],
      take: 500,
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(actor: Actor, request: CreateSubscriptionRequest): Promise<SubscriptionDto> {
    const tenant = await this.access(actor, true);
    const settings = await this.settings.load(tenant.businessId);
    const businessId = request.businessId ?? null;
    const leadId = businessId ? null : (request.leadId ?? null);
    if (businessId) {
      const business = tenant.platform
        ? await this.prisma.business.findFirst({
            where: { id: businessId, internal: false, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!business) throw ApiError.validation('Choose an SMA customer.', 'businessId');
    } else {
      const lead = await this.prisma.lead.findFirst({
        where: { id: leadId ?? undefined, tenantId: tenant.businessId, deletedAt: null, stage: 'WON' },
        select: { id: true },
      });
      if (!lead) throw ApiError.validation('Choose a customer (a won lead).', 'leadId');
    }
    const start = dateOnly(request.startDate);
    if (start < today()) throw ApiError.validation('The first invoice date cannot be in the past.', 'startDate');
    if (request.dealId) {
      const deal = await this.prisma.deal.findFirst({
        where: {
          id: request.dealId,
          tenantId: tenant.businessId,
          deletedAt: null,
          ...(businessId ? { businessId } : { leadId }),
        },
        select: { id: true },
      });
      if (!deal) throw ApiError.validation('That deal is not for this customer.', 'dealId');
    }
    if (request.items.some((i) => i.serviceId)) {
      const ids = [...new Set(request.items.map((i) => i.serviceId).filter((v): v is string => !!v))];
      const found = await this.prisma.crmService.count({ where: { id: { in: ids }, tenantId: tenant.businessId } });
      if (found !== ids.length) throw ApiError.validation('A chosen service was not found.', 'items');
    }
    const row = await this.prisma.subscription.create({
      data: {
        tenantId: tenant.businessId,
        businessId,
        leadId,
        dealId: request.dealId ?? null,
        name: request.name,
        currency: request.currency ?? settings.defaultCurrency,
        interval: request.interval,
        nextInvoiceAt: start,
        dueDays: request.dueDays,
        taxRate: request.taxRate ?? settings.taxRate,
        autoEmail: request.autoEmail,
        createdById: actor.userId,
        items: {
          create: request.items.map((i, position) => ({
            serviceId: i.serviceId ?? null,
            name: i.name,
            quantity: i.quantity,
            unitPrice: round2(i.unitPrice),
            position,
          })),
        },
      },
      include: subscriptionInclude,
    });
    await this.audit.record(actor, {
      action: 'crm.subscription_created',
      businessId: tenant.businessId,
      targetType: 'Subscription',
      targetId: row.id,
    });
    return this.toDto(row);
  }

  async update(actor: Actor, id: string, request: UpdateSubscriptionRequest): Promise<SubscriptionDto> {
    const tenant = await this.access(actor, true);
    const existing = await this.prisma.subscription.findFirst({
      where: { id, tenantId: tenant.businessId },
      select: { status: true },
    });
    if (!existing) throw ApiError.notFound('Subscription');
    if (existing.status === 'CANCELLED' && request.status !== 'ACTIVE')
      throw ApiError.conflict('This subscription was cancelled.');
    if (request.nextInvoiceAt && dateOnly(request.nextInvoiceAt) < today())
      throw ApiError.validation('The next invoice date cannot be in the past.', 'nextInvoiceAt');
    const row = await this.prisma.$transaction(async (tx) => {
      if (request.items) {
        await tx.subscriptionItem.deleteMany({ where: { subscriptionId: id } });
        await tx.subscriptionItem.createMany({
          data: request.items.map((i, position) => ({
            subscriptionId: id,
            serviceId: i.serviceId ?? null,
            name: i.name,
            quantity: i.quantity,
            unitPrice: round2(i.unitPrice),
            position,
          })),
        });
      }
      return tx.subscription.update({
        where: { id },
        data: {
          ...(request.status ? { status: request.status } : {}),
          ...(request.status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
          ...(request.status === 'ACTIVE' ? { cancelledAt: null } : {}),
          ...(request.nextInvoiceAt ? { nextInvoiceAt: dateOnly(request.nextInvoiceAt) } : {}),
          ...(request.autoEmail !== undefined ? { autoEmail: request.autoEmail } : {}),
          ...(request.dueDays !== undefined ? { dueDays: request.dueDays } : {}),
        },
        include: subscriptionInclude,
      });
    });
    return this.toDto(row);
  }
}

/** The customer's pay page: the invoice and how to pay, plus "I have paid". No sign-in. */
@Injectable()
export class PublicPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CrmSettingsService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  private async byToken(token: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { payToken: token },
      include: {
        items: { orderBy: { position: 'asc' } },
        _count: { select: { claims: { where: { status: 'PENDING' } } } },
      },
    });
    if (!invoice || invoice.status === 'DRAFT' || invoice.status === 'VOID') throw ApiError.notFound('Invoice');
    return invoice;
  }

  async view(token: string, ipHash: string): Promise<PublicInvoiceDto> {
    await this.rateLimiter.consume(PAY_LIMIT, ipHash);
    const i = await this.byToken(token);
    const s = await this.settings.load(i.tenantId);
    return {
      number: i.number,
      status: i.status,
      company: {
        name: s.companyName,
        address: s.companyAddress,
        email: s.companyEmail,
        phone: s.companyPhone,
        taxNumber: s.taxNumber,
        taxName: s.taxName,
      },
      billToName: i.billToName,
      issueDate: isoDate(i.issueDate),
      dueDate: isoDate(i.dueDate),
      currency: i.currency,
      items: i.items.map((it) => ({
        name: it.name,
        description: it.description,
        quantity: it.quantity,
        unitPrice: num(it.unitPrice),
        total: num(it.total),
      })),
      subtotal: num(i.subtotal),
      discount: num(i.discount),
      taxRate: num(i.taxRate),
      taxAmount: num(i.taxAmount),
      total: num(i.total),
      amountPaid: num(i.amountPaid),
      balance: round2(num(i.total) - num(i.amountPaid)),
      payTo: s.payTo,
      paymentDetails: s.paymentDetails,
      pendingClaims: i._count.claims,
    };
  }

  async claim(token: string, request: SubmitPaymentClaimRequest, ipHash: string): Promise<PublicInvoiceDto> {
    await this.rateLimiter.consume(PAY_LIMIT, ipHash);
    const i = await this.byToken(token);
    if (request.website) return this.view(token, ipHash); // bot
    if (i.status === 'PAID') throw ApiError.conflict('This invoice is already paid. Thank you!');
    const balance = round2(num(i.total) - num(i.amountPaid));
    if (request.amount > balance + 0.004)
      throw ApiError.validation(`That is more than the amount due (${balance.toFixed(2)}).`, 'amount');
    if (i._count.claims >= 5)
      throw ApiError.conflict('We are already checking your earlier payments. Please wait for us to confirm them.');
    await this.prisma.paymentClaim.create({
      data: {
        invoiceId: i.id,
        amount: request.amount,
        method: request.method,
        reference: request.reference,
        payerName: request.payerName ?? null,
        note: request.note ?? null,
        ipHash,
      },
    });
    return this.view(token, ipHash);
  }
}
