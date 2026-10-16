import { Body, Controller, Get, HttpCode, Injectable, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  financeRemindRequestSchema,
  type FinanceDashboardDto,
  type FinanceInvoiceRowDto,
  type FinanceRemindRequest,
  type PaymentMethod,
} from '@storeline/shared';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { BillingRunner } from './billing-scheduler';
import { CrmSettingsService, isoDate, num, round2, today } from './crm-core';
import { SalesService } from './sales.service';

const DAY = 86_400_000;
const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const OPEN = ['ISSUED', 'PARTIALLY_PAID'];

/**
 * The Accounts tab: money in, money owed and who to remind, for the accountant (and sales
 * managers, owners and admins). Read-only except for sending reminders.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly settings: CrmSettingsService,
    private readonly runner: BillingRunner,
    private readonly audit: AuditService,
  ) {}

  private async tenant(actor: Actor): Promise<string> {
    const { businessId } = await this.sales.tenant(actor);
    await this.authz.require(actor, 'sales.finance.read', { businessId });
    return businessId;
  }

  async dashboard(actor: Actor): Promise<FinanceDashboardDto> {
    const tenantId = await this.tenant(actor);
    const settings = await this.settings.load(tenantId);
    const main = (amount: number, currency: string) =>
      this.settings.convert(amount, currency, settings.defaultCurrency, settings);
    const now = today();
    const month = monthKey(now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const [invoices, payments, subscriptions, canRemind] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenantId, status: { in: [...OPEN, 'PAID'] as never } },
        select: {
          id: true,
          number: true,
          billToName: true,
          billToEmail: true,
          billToPhone: true,
          currency: true,
          total: true,
          amountPaid: true,
          status: true,
          issueDate: true,
          dueDate: true,
          subscriptionId: true,
          businessId: true,
          leadId: true,
          reminderCount: true,
          lastReminderAt: true,
        },
        orderBy: { dueDate: 'asc' },
        take: 20_000,
      }),
      this.prisma.payment.findMany({
        where: {
          voidedAt: null,
          paidAt: { gte: trendStart },
          invoice: { tenantId, status: { not: 'VOID' } },
        },
        select: {
          id: true,
          amount: true,
          paidAt: true,
          method: true,
          reference: true,
          invoice: { select: { id: true, number: true, billToName: true, currency: true } },
          recordedBy: { select: { displayName: true } },
        },
        orderBy: { paidAt: 'desc' },
      }),
      this.prisma.subscription.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { id: true, businessId: true, leadId: true },
      }),
      this.authz.can(actor, 'sales.billing.manage', { businessId: tenantId }),
    ]);

    const unpaidRows = invoices.filter((i) => OPEN.includes(i.status));
    const balanceOf = (i: (typeof invoices)[number]) => round2(num(i.total) - num(i.amountPaid));
    const daysLate = (due: Date) => Math.floor((now.getTime() - due.getTime()) / DAY);
    const unpaid: FinanceInvoiceRowDto[] = unpaidRows
      .map((i) => ({
        id: i.id,
        number: i.number,
        customer: i.billToName,
        email: i.billToEmail,
        phone: i.billToPhone,
        currency: i.currency,
        total: num(i.total),
        balance: balanceOf(i),
        issueDate: isoDate(i.issueDate),
        dueDate: isoDate(i.dueDate),
        daysLate: daysLate(i.dueDate),
        recurring: !!i.subscriptionId,
        reminderCount: i.reminderCount,
        lastReminderAt: i.lastReminderAt?.toISOString() ?? null,
      }))
      .sort((a, b) => b.daysLate - a.daysLate);
    const sum = (rows: FinanceInvoiceRowDto[]) =>
      round2(rows.reduce((s, r) => s + main(r.balance, r.currency), 0));
    const overdueRows = unpaid.filter((r) => r.daysLate > 0);
    const customerKey = (i: { businessId: string | null; leadId: string | null; id: string }) =>
      i.businessId ?? i.leadId ?? i.id;
    const recurringThisMonth = invoices.filter(
      (i) => i.subscriptionId && i.issueDate >= monthStart,
    );
    const trend = Array.from({ length: 6 }, (_, n) => {
      const key = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + n, 1)));
      return {
        month: key,
        invoiced: round2(
          invoices
            .filter((i) => monthKey(i.issueDate) === key)
            .reduce((s, i) => s + main(num(i.total), i.currency), 0),
        ),
        received: round2(
          payments
            .filter((p) => monthKey(p.paidAt) === key)
            .reduce((s, p) => s + main(num(p.amount), p.invoice.currency), 0),
        ),
      };
    });
    const thisMonthPayments = payments.filter((p) => monthKey(p.paidAt) === month);
    return {
      currency: settings.defaultCurrency,
      month,
      paymentDueDay: settings.paymentDueDay,
      clients: {
        active: new Set(subscriptions.map(customerKey)).size,
        owing: new Set(unpaidRows.map(customerKey)).size,
      },
      invoicedThisMonth: trend.at(-1)!.invoiced,
      receivedThisMonth: trend.at(-1)!.received,
      paymentsThisMonth: thisMonthPayments.length,
      outstanding: sum(unpaid),
      overdue: sum(overdueRows),
      overdueCount: overdueRows.length,
      thisMonth: {
        paid: recurringThisMonth.filter((i) => i.status === 'PAID').length,
        waiting: recurringThisMonth.filter((i) => i.status !== 'PAID' && i.dueDate >= now).length,
        late: recurringThisMonth.filter((i) => i.status !== 'PAID' && i.dueDate < now).length,
      },
      aging: {
        notDue: sum(unpaid.filter((r) => r.daysLate <= 0)),
        days1to30: sum(unpaid.filter((r) => r.daysLate >= 1 && r.daysLate <= 30)),
        days31to60: sum(unpaid.filter((r) => r.daysLate >= 31 && r.daysLate <= 60)),
        over60: sum(unpaid.filter((r) => r.daysLate > 60)),
      },
      trend,
      unpaid: unpaid.slice(0, 300),
      recentPayments: payments.slice(0, 30).map((p) => ({
        id: p.id,
        invoiceId: p.invoice.id,
        invoiceNumber: p.invoice.number,
        customer: p.invoice.billToName,
        amount: num(p.amount),
        currency: p.invoice.currency,
        method: p.method as PaymentMethod,
        reference: p.reference,
        paidAt: p.paidAt.toISOString(),
        recordedBy: p.recordedBy?.displayName ?? null,
      })),
      reminderDays: settings.reminderDays,
      reminderChannels: settings.reminderChannels,
      canRemind,
    };
  }

  /** Reminds the chosen invoices now (none chosen: every overdue one) on the set channels. */
  async remind(
    actor: Actor,
    request: FinanceRemindRequest,
  ): Promise<{ reminded: number; failed: number }> {
    const tenantId = await this.tenant(actor);
    await this.authz.require(actor, 'sales.billing.manage', { businessId: tenantId });
    const rows = await this.prisma.invoice.findMany({
      where: {
        tenantId,
        status: { in: OPEN as never },
        ...(request.invoiceIds.length
          ? { id: { in: request.invoiceIds } }
          : { dueDate: { lt: today() } }),
      },
      select: { id: true },
      take: 200,
    });
    let reminded = 0;
    for (const row of rows) if (await this.runner.remind(row.id)) reminded += 1;
    await this.audit.record(actor, {
      action: 'sales.payment_reminders_sent',
      businessId: tenantId,
      metadata: { reminded, failed: rows.length - reminded },
    });
    return { reminded, failed: rows.length - reminded };
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller({ path: 'sales/crm/finance', version: '1' })
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  dashboard(@CurrentActor() actor: Actor): Promise<FinanceDashboardDto> {
    return this.finance.dashboard(actor);
  }

  @Post('remind')
  @HttpCode(200)
  @ApiZodBody(financeRemindRequestSchema)
  remind(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(financeRemindRequestSchema)) body: FinanceRemindRequest,
  ): Promise<{ reminded: number; failed: number }> {
    return this.finance.remind(actor, body);
  }
}
