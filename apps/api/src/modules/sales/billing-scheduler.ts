import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { MailService } from '../../infra/mail/mail.service';
import { OutboxService } from '../outbox/outbox.service';

/** How a payment reminder goes out; APP = a notice in the SMA app to a customer business. */
export type ReminderChannel = 'EMAIL' | 'WHATSAPP' | 'SMS' | 'APP';
import { MarketingChannelsService } from '../../infra/mail/marketing-channels.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  CrmSettingsService,
  dateOnly,
  documentHtml,
  documentText,
  formatMoney,
  InvoiceFactory,
  isoDate,
  newPublicToken,
  num,
  round2,
  today,
  type DocumentForEmail,
  dueByDay,
} from './crm-core';
import { SMA_PLANS, type SmaPlanKey } from '@storeline/shared';
import { nextPeriod } from './billing.service';

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 30_000;

/**
 * Subscription invoices and payment reminders (email, WhatsApp, SMS — whatever is set up).
 * Used by the worker on a timer (BillingScheduler) and by the API for "send reminder now".
 */
@Injectable()
export class BillingRunner {
  private readonly logger = new Logger(BillingRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: InvoiceFactory,
    private readonly settings: CrmSettingsService,
    private readonly mail: MailService,
    private readonly channels: MarketingChannelsService,
    private readonly outbox: OutboxService,
  ) {}

  /** One invoice per due subscription period; the period moves on in the same transaction. */
  async billSubscriptions(): Promise<number> {
    const due = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', nextInvoiceAt: { lte: today() } },
      include: {
        items: { orderBy: { position: 'asc' } },
        business: { select: { name: true, email: true, phone: true, address: true } },
        lead: {
          select: { companyName: true, email: true, phone: true, city: true, country: true },
        },
      },
      take: 100,
    });
    let count = 0;
    for (const sub of due) {
      // SMA plans priced per store bill for today's number of stores.
      const plan = await this.prisma.businessPlan.findUnique({
        where: { subscriptionId: sub.id },
        select: { plan: true, businessId: true },
      });
      if (plan && SMA_PLANS[plan.plan as SmaPlanKey].perStore) {
        const stores = Math.max(
          1,
          await this.prisma.store.count({
            where: { businessId: plan.businessId, status: 'ACTIVE' },
          }),
        );
        await this.prisma.subscriptionItem.updateMany({
          where: { subscriptionId: sub.id },
          data: { quantity: stores },
        });
        for (const item of sub.items) item.quantity = stores;
      }
      const dueBy =
        sub.interval === 'MONTHLY' ? (await this.settings.load(sub.tenantId)).paymentDueDay : null;
      const periodStart = sub.nextInvoiceAt;
      const periodEnd = nextPeriod(periodStart, sub.interval as 'MONTHLY' | 'YEARLY');
      try {
        const invoiceId = await this.prisma.$transaction(async (tx) => {
          // Claim the period: only one worker round can move it on.
          const claimed = await tx.subscription.updateMany({
            where: { id: sub.id, status: 'ACTIVE', nextInvoiceAt: periodStart },
            data: { nextInvoiceAt: periodEnd },
          });
          if (claimed.count === 0) return null;
          const a = (sub.business?.address ?? {}) as Record<string, string | undefined>;
          const party = sub.business
            ? {
                name: sub.business.name,
                email: sub.business.email,
                phone: sub.business.phone,
                address: [a.line1, a.city, a.country].filter(Boolean).join(', ') || null,
              }
            : {
                name: sub.lead?.companyName ?? sub.name,
                email: sub.lead?.email ?? null,
                phone: sub.lead?.phone ?? null,
                address: [sub.lead?.city, sub.lead?.country].filter(Boolean).join(', ') || null,
              };
          const invoice = await tx.invoice.create({
            data: {
              tenantId: sub.tenantId,
              number: await this.factory.nextInvoiceNumber(tx, sub.tenantId),
              dealId: sub.dealId,
              businessId: sub.businessId,
              leadId: sub.leadId,
              subscriptionId: sub.id,
              periodStart,
              periodEnd: new Date(periodEnd.getTime() - 86_400_000),
              billToName: party.name,
              billToEmail: party.email,
              billToPhone: party.phone,
              billToAddress: party.address,
              issueDate: today(),
              // The business's monthly payment window (e.g. by the 10th), else the
              // subscription's own number of days.
              dueDate:
                sub.interval === 'MONTHLY' && dueBy
                  ? dueByDay(today(), dueBy)
                  : dateOnly(new Date(Date.now() + sub.dueDays * 86_400_000)),
              currency: sub.currency,
              taxRate: sub.taxRate,
              notes: `${sub.name} · ${isoDate(periodStart)} to ${isoDate(new Date(periodEnd.getTime() - 86_400_000))}`,
              status: 'ISSUED',
              issuedAt: new Date(),
              payToken: newPublicToken(),
              items: {
                create: sub.items.map((i, position) => ({
                  serviceId: i.serviceId,
                  name: i.name,
                  description: sub.interval === 'MONTHLY' ? 'Monthly' : 'Yearly',
                  quantity: i.quantity,
                  unitPrice: i.unitPrice,
                  total: round2(i.quantity * num(i.unitPrice)),
                  position,
                })),
              },
            },
            select: { id: true },
          });
          await this.factory.recompute(tx, invoice.id);
          return invoice.id;
        });
        if (!invoiceId) continue;
        count += 1;
        if (sub.autoEmail) await this.emailInvoice(invoiceId, null);
      } catch (error) {
        this.logger.error({ err: error, subscriptionId: sub.id }, 'Subscription invoice failed');
      }
    }
    return count;
  }

  private async documentFor(invoiceId: string): Promise<{
    doc: DocumentForEmail;
    email: string | null;
    phone: string | null;
    tenantId: string;
  } | null> {
    const i = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!i) return null;
    const total = num(i.total);
    const paid = num(i.amountPaid);
    return {
      email: i.billToEmail,
      phone: i.billToPhone,
      tenantId: i.tenantId,
      doc: {
        kind: 'Invoice',
        number: i.number,
        billToName: i.billToName,
        issueDate: isoDate(i.issueDate),
        dueLabel: 'Due',
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
        total,
        amountPaid: paid,
        balance: round2(total - paid),
        notes: i.notes,
        actionUrl: i.payToken ? this.settings.link(`/pay/${i.payToken}`) : null,
        actionLabel: 'View and pay',
      },
    };
  }

  /** Emails an invoice (new, or as a reminder). Returns whether the mail server accepted it. */
  async emailInvoice(invoiceId: string, intro: string | null): Promise<boolean> {
    if (!this.mail.enabled) return false;
    const found = await this.documentFor(invoiceId);
    if (!found?.email) return false;
    const s = await this.settings.load(found.tenantId);
    const sent = await this.mail.send({
      to: found.email,
      subject: intro
        ? `Reminder: invoice ${found.doc.number} is overdue`
        : `Invoice ${found.doc.number} from ${s.companyName}`,
      text: documentText(found.doc, s, intro ?? undefined),
      html: documentHtml(found.doc, s, intro ?? undefined),
    });
    if (sent)
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { lastEmailedAt: new Date() },
      });
    return sent;
  }

  /**
   * Reminders on the configured days after the due date (e.g. 0 = on the due date, then 1, 7
   * and 14 days late). Each
   * invoice gets each reminder once; the next is due when it is that many days overdue.
   */
  async sendReminders(): Promise<number> {
    const overdue = await this.prisma.invoice.findMany({
      // Due today too: a reminder day of 0 means "on the due date".
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lte: today() } },
      select: { id: true, dueDate: true, reminderCount: true, tenantId: true },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
    let count = 0;
    for (const inv of overdue) {
      // Each business has its own reminder days.
      const days = (await this.settings.load(inv.tenantId)).reminderDays;
      if (inv.reminderCount >= days.length) continue;
      const daysLate = Math.floor((today().getTime() - inv.dueDate.getTime()) / 86_400_000);
      // The latest step that is due. Steps missed earlier are skipped, so an invoice that is
      // already long overdue gets one reminder, not every step in a burst.
      const step = days.filter((d) => d <= daysLate).length;
      if (step <= inv.reminderCount) continue;
      if (await this.remind(inv.id, step)) count += 1;
    }
    return count;
  }

  /**
   * Sends one reminder on every configured channel; counts it if any channel accepted it.
   * `step` sets how many reminder steps are done (default: one more than now).
   */
  async remind(invoiceId: string, step?: number, only?: ReminderChannel[]): Promise<boolean> {
    const found = await this.documentFor(invoiceId);
    if (!found) return false;
    const s = await this.settings.load(found.tenantId);
    // Automatic and "remind" use the business's channels, plus the SMA app when the customer
    // is a business on SMA; "Email" or "Notify" in the Accounts tab pick their own.
    const ways: ReminderChannel[] = only ?? [...s.reminderChannels, 'APP'];
    const { doc } = found;
    const dueToday = doc.dueDate === isoDate(today());
    const when = dueToday ? `is due today (${doc.dueDate})` : `was due on ${doc.dueDate}`;
    const intro = `Friendly reminder: invoice ${doc.number} for ${formatMoney(doc.balance ?? doc.total, doc.currency)} ${when}.`;
    const shortText = `${intro} ${doc.actionUrl ? `Pay or view it here: ${doc.actionUrl}` : ''} — ${s.companyName}`;
    let delivered = false;
    for (const channel of ways) {
      if (channel === 'APP') {
        delivered = (await this.notifyApp(invoiceId, intro)) || delivered;
        continue;
      }
      if (channel === 'EMAIL') delivered = (await this.emailInvoice(invoiceId, intro)) || delivered;
      else if (found.phone && s.channels[channel]) {
        const result = await this.channels.send(channel, {
          to: found.phone,
          name: doc.billToName,
          text: shortText,
          templateParams: [doc.billToName, shortText],
        });
        delivered = result.ok || delivered;
      }
    }
    // Counted even when nothing could be sent, so a customer without contact details is not
    // retried every round; the invoice page shows how many reminders went out.
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        reminderCount: step ?? { increment: 1 },
        ...(delivered ? { lastReminderAt: new Date() } : {}),
      },
    });
    return delivered;
  }

  /**
   * Customer is a business on SMA: a phone/app notice to its owners and admins (the SMA bill
   * is under Admin → Plan & billing). Returns whether anyone was there to notify.
   */
  private async notifyApp(invoiceId: string, text: string): Promise<boolean> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { businessId: true, number: true },
    });
    if (!invoice?.businessId) return false;
    const admins = await this.prisma.roleAssignment.findMany({
      where: {
        businessId: invoice.businessId,
        revokedAt: null,
        role: { key: { in: ['BUSINESS_OWNER', 'BUSINESS_ADMIN'] }, isSystem: true },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: { userId: true },
    });
    const userIds = [...new Set(admins.map((a) => a.userId))];
    if (userIds.length === 0) return false;
    await this.outbox.pushQueue
      .add(
        'notice',
        {
          kind: 'notice',
          userIds,
          title: 'Payment reminder',
          body: text,
          url: '/admin?tab=billing',
          tag: `invoice-${invoice.number}`,
        },
        { jobId: `invoice-${invoiceId}-${Date.now()}` },
      )
      .catch(() => undefined);
    return true;
  }
}

/**
 * SMA plan status: an ended trial, or an SMA invoice more than 7 days overdue, makes the plan
 * PAST_DUE (admins see a notice); paying brings it back to ACTIVE. Suspension stays manual.
 */
export async function sweepPlanStatuses(prisma: PrismaService): Promise<number> {
  const now = new Date();
  let changed = (
    await prisma.businessPlan.updateMany({
      where: { status: 'TRIAL', trialEndsAt: { lt: now } },
      data: { status: 'PAST_DUE' },
    })
  ).count;
  const sma = await prisma.business.findFirst({
    where: { internal: true, deletedAt: null },
    select: { id: true },
  });
  if (!sma) return changed;
  const overdue = await prisma.invoice.findMany({
    where: {
      tenantId: sma.id,
      businessId: { not: null },
      status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
      dueDate: { lt: dateOnly(new Date(now.getTime() - 7 * 86_400_000)) },
    },
    select: { businessId: true },
    distinct: ['businessId'],
  });
  const late = overdue.map((i) => i.businessId!);
  changed += (
    await prisma.businessPlan.updateMany({
      where: { status: 'ACTIVE', businessId: { in: late } },
      data: { status: 'PAST_DUE' },
    })
  ).count;
  changed += (
    await prisma.businessPlan.updateMany({
      where: { status: 'PAST_DUE', plan: { not: 'TRIAL' }, businessId: { notIn: late } },
      data: { status: 'ACTIVE' },
    })
  ).count;
  return changed;
}

/** Worker: runs billing every 10 minutes and expires old quotes. */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BillingScheduler.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly runner: BillingRunner,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    this.timers.push(setTimeout(() => void this.tick(), FIRST_TICK_MS).unref());
    this.timers.push(setInterval(() => void this.tick(), TICK_MS).unref());
  }

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearTimeout(t));
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const invoiced = await this.runner.billSubscriptions();
      const reminded = await this.runner.sendReminders();
      const plans = await sweepPlanStatuses(this.prisma);
      if (plans) this.logger.log({ plans }, 'SMA plan statuses updated');
      const expired = await this.prisma.quote.updateMany({
        where: { status: { in: ['DRAFT', 'SENT'] }, validUntil: { lt: today() } },
        data: { status: 'EXPIRED' },
      });
      if (invoiced || reminded || expired.count)
        this.logger.log({ invoiced, reminded, expiredQuotes: expired.count }, 'Billing round done');
    } catch (error) {
      this.logger.error({ err: error }, 'Billing round failed');
    } finally {
      this.running = false;
    }
  }
}
