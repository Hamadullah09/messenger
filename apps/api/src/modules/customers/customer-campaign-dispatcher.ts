import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CUSTOMER_CAMPAIGN_NAME_TOKEN } from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { MarketingChannelsService } from '../../infra/mail/marketing-channels.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { unsubscribeToken } from './customer-campaigns.service';

/** A message claimed for sending but never finished (worker stopped) is reported after this. */
const STALE_SENDING_MS = 10 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Worker: sends store-customer campaigns a batch at a time. Each recipient is claimed before
 * sending, consent is re-checked at that moment, and the provider's answer is stored as is
 * (SENT = accepted by the provider, never "delivered").
 */
@Injectable()
export class CustomerCampaignDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CustomerCampaignDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly channels: MarketingChannelsService,
    private readonly crypto: CryptoService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.CAMPAIGN_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'Customer campaign round failed');
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<void> {
    await this.prisma.customerCampaignRecipient.updateMany({
      where: { state: 'SENDING', sentAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
      data: { state: 'FAILED', error: 'Interrupted while sending; it may or may not have arrived' },
    });
    const campaigns = await this.prisma.customerCampaign.findMany({
      where: { status: 'SENDING' },
      select: {
        id: true,
        channel: true,
        subject: true,
        body: true,
        business: { select: { name: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: 5,
    });
    for (const campaign of campaigns) await this.sendBatch(campaign);
  }

  private async sendBatch(campaign: {
    id: string;
    channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
    subject: string | null;
    body: string;
    business: { name: string };
  }): Promise<void> {
    const batch = await this.prisma.customerCampaignRecipient.findMany({
      where: { campaignId: campaign.id, state: 'PENDING' },
      select: {
        id: true,
        destination: true,
        customer: { select: { id: true, name: true, marketingOptIn: true, deletedAt: true } },
      },
      take: this.config.CUSTOMER_CAMPAIGN_BATCH_SIZE,
    });
    if (batch.length === 0) {
      const inFlight = await this.prisma.customerCampaignRecipient.count({
        where: { campaignId: campaign.id, state: 'SENDING' },
      });
      if (inFlight === 0) {
        await this.prisma.customerCampaign.updateMany({
          where: { id: campaign.id, status: 'SENDING' },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
      return;
    }
    for (const r of batch) {
      const claimed = await this.prisma.customerCampaignRecipient.updateMany({
        where: { id: r.id, state: 'PENDING' },
        data: { state: 'SENDING', sentAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      if (!r.customer.marketingOptIn || r.customer.deletedAt) {
        await this.prisma.customerCampaignRecipient.update({
          where: { id: r.id },
          data: { state: 'SKIPPED', error: 'No longer agrees to marketing', sentAt: null },
        });
        continue;
      }
      const firstName = r.customer.name.split(/\s+/)[0] || r.customer.name;
      const text = campaign.body.split(CUSTOMER_CAMPAIGN_NAME_TOKEN).join(firstName);
      const link = `${this.config.WEB_APP_URL.replace(/\/$/, '')}/unsubscribe?c=${r.customer.id}&t=${unsubscribeToken(this.crypto, r.customer.id)}`;
      const business = campaign.business.name;
      const result = await this.channels.send(campaign.channel, {
        to: r.destination,
        name: firstName,
        subject: (campaign.subject ?? '').split(CUSTOMER_CAMPAIGN_NAME_TOKEN).join(firstName),
        text:
          campaign.channel === 'SMS'
            ? `${text}\n${business}. Stop: ${link}`
            : `${text}\n\n— ${business}\nYou get this because you agreed to hear from ${business}. Unsubscribe: ${link}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b1714">${escapeHtml(
          text,
        ).replace(
          /\n/g,
          '<br>',
        )}<p style="margin-top:24px;color:#6b6259;font-size:12px">— ${escapeHtml(
          business,
        )}<br>You get this because you agreed to hear from ${escapeHtml(
          business,
        )}. <a href="${link}">Unsubscribe</a></p></div>`,
        templateParams: [firstName, text],
      });
      await this.prisma.customerCampaignRecipient.update({
        where: { id: r.id },
        data: result.ok
          ? { state: 'SENT', providerMessageId: result.providerId, sentAt: new Date(), error: null }
          : { state: 'FAILED', error: result.error.slice(0, 300), sentAt: null },
      });
    }
  }
}
