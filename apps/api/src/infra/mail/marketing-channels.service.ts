import { Inject, Injectable } from '@nestjs/common';
import type { MarketingChannel, MarketingChannelsDto } from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MailService } from './mail.service';

export interface OutgoingMarketingMessage {
  /** Email address or E.164 phone number. */
  to: string;
  name: string;
  subject?: string;
  text: string;
  html?: string;
  /** WhatsApp template variables: {{1}} name, {{2}} message. */
  templateParams?: [string, string];
}

/** Provider result. `ok` means the provider accepted the message, not that it was delivered. */
export type SendResult = { ok: true; providerId: string | null } | { ok: false; error: string };

const TIMEOUT_MS = 15_000;

/**
 * Sends marketing messages to store customers by email (SMTP), SMS (Twilio) or WhatsApp
 * (Meta Cloud API). A channel is only offered when its keys are configured.
 */
@Injectable()
export class MarketingChannelsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  available(): MarketingChannelsDto {
    const c = this.config;
    return {
      EMAIL: this.mail.enabled,
      SMS: !!(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_FROM),
      WHATSAPP: !!(
        c.WHATSAPP_PHONE_NUMBER_ID &&
        c.WHATSAPP_ACCESS_TOKEN &&
        c.WHATSAPP_TEMPLATE_NAME
      ),
    };
  }

  async send(channel: MarketingChannel, message: OutgoingMarketingMessage): Promise<SendResult> {
    if (!this.available()[channel]) return { ok: false, error: `${channel} is not set up` };
    try {
      if (channel === 'EMAIL') return await this.email(message);
      if (channel === 'SMS') return await this.sms(message);
      return await this.whatsapp(message);
    } catch (error) {
      return { ok: false, error: (error as Error).message.slice(0, 280) };
    }
  }

  private async email(m: OutgoingMarketingMessage): Promise<SendResult> {
    const sent = await this.mail.send({
      to: m.to,
      subject: m.subject ?? '',
      text: m.text,
      html: m.html ?? m.text,
    });
    return sent
      ? { ok: true, providerId: null }
      : { ok: false, error: 'The mail server refused it' };
  }

  private async sms(m: OutgoingMarketingMessage): Promise<SendResult> {
    const c = this.config;
    const params = new URLSearchParams({ To: m.to, Body: m.text });
    if (c.TWILIO_FROM!.startsWith('MG')) params.set('MessagingServiceSid', c.TWILIO_FROM!);
    else params.set('From', c.TWILIO_FROM!);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.TWILIO_ACCOUNT_SID!)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    return res.ok
      ? { ok: true, providerId: body.sid ?? null }
      : { ok: false, error: `Twilio ${res.status}: ${body.message ?? 'refused'}` };
  }

  private async whatsapp(m: OutgoingMarketingMessage): Promise<SendResult> {
    const c = this.config;
    const [name, text] = m.templateParams ?? [m.name, m.text];
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(c.WHATSAPP_PHONE_NUMBER_ID!)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: m.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: c.WHATSAPP_TEMPLATE_NAME,
            language: { code: c.WHATSAPP_TEMPLATE_LANGUAGE },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: name },
                  // WhatsApp template variables cannot contain new lines.
                  { type: 'text', text: text.replace(/\s*\n+\s*/g, ' ') },
                ],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string };
    };
    return res.ok
      ? { ok: true, providerId: body.messages?.[0]?.id ?? null }
      : { ok: false, error: `WhatsApp ${res.status}: ${body.error?.message ?? 'refused'}` };
  }
}
