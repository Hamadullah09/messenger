import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { MailService } from '../../infra/mail/mail.service';
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
} from './crm-core';
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
  ) {}

  /** One invoice per due subscription period; the period moves on in the same transaction. */
  async billSubscriptions(): Promise<number> {
    const due = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', nextInvoiceAt: { lte: today() } },
      include: { items: { orderBy: { position: 'asc' } }, business: { select: { name: true, email: true, phone: true, address: true } } },
      take: 100,
    });
    let count = 0;
    for (const sub of due) {
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
          const a = (sub.business.address ?? {}) as Record<string, string | undefined>;
          const invoice = await tx.invoice.create({
            data: {
              number: await this.factory.nextInvoiceNumber(tx),
              dealId: sub.dealId,
              businessId: sub.businessId,
              subscriptionId: sub.id,
              periodStart,
              periodEnd: new Date(periodEnd.getTime() - 86_400_000),
              billToName: sub.business.name,
              billToEmail: sub.business.email,
              billToPhone: sub.business.phone,
              billToAddress: [a.line1, a.city, a.country].filter(Boolean).join(', ') || null,
              issueDate: today(),
              dueDate: dateOnly(new Date(Date.now() + sub.dueDays * 86_400_000)),
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

  private async documentFor(invoiceId: string): Promise<{ doc: DocumentForEmail; email: string | null; phone: string | null } | null> {
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
    const s = this.settings.current();
    const sent = await this.mail.send({
      to: found.email,
      subject: intro
        ? `Reminder: invoice ${found.doc.number} is overdue`
        : `Invoice ${found.doc.number} from ${s.companyName}`,
      text: documentText(found.doc, s, intro ?? undefined),
      html: documentHtml(found.doc, s, intro ?? undefined),
    });
    if (sent) await this.prisma.invoice.update({ where: { id: invoiceId }, data: { lastEmailedAt: new Date() } });
    return sent;
  }

  /**
   * Overdue reminders on the configured days after the due date (e.g. 1, 7 and 14 days). Each
   * invoice gets each reminder once; the next is due when it is that many days overdue.
   */
  async sendReminders(): Promise<number> {
    const s = this.settings.current();
    const days = s.reminderDays;
    if (days.length === 0) return 0;
    const overdue = await this.prisma.invoice.findMany({
      where: {
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        dueDate: { lt: today() },
        reminderCount: { lt: days.length },
      },
      select: { id: true, dueDate: true, reminderCount: true },
      take: 200,
    });
    let count = 0;
    for (const inv of overdue) {
      const daysLate = Math.floor((today().getTime() - inv.dueDate.getTime()) / 86_400_000);
      if (daysLate < days[inv.reminderCount]!) continue;
      if (await this.remind(inv.id)) count += 1;
    }
    return count;
  }

  /** Sends one reminder on every configured channel; counts it if any channel accepted it. */
  async remind(invoiceId: string): Promise<boolean> {
    const found = await this.documentFor(invoiceId);
    if (!found) return false;
    const s = this.settings.current();
    const { doc } = found;
    const intro = `Friendly reminder: invoice ${doc.number} for ${formatMoney(doc.balance ?? doc.total, doc.currency)} was due on ${doc.dueDate}.`;
    const shortText = `${intro} ${doc.actionUrl ? `Pay or view it here: ${doc.actionUrl}` : ''} — ${s.companyName}`;
    let delivered = false;
    for (const channel of s.reminderChannels) {
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
      data: { reminderCount: { increment: 1 }, ...(delivered ? { lastReminderAt: new Date() } : {}) },
    });
    return delivered;
  }
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
