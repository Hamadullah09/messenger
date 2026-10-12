import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PlatformSettingsService } from './platform-settings.service';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends transactional email over SMTP. Local development uses Mailpit (compose.yaml), which
 * catches every message and shows it at http://localhost:18025 — nothing leaves the machine.
 * The mail server can also be set by the Super Admin in Integrations (it then wins).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport: Transporter | null = null;
  private builtFor: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: PlatformSettingsService,
  ) {}

  private get smtpUrl(): string | undefined {
    return this.settings.get('SMTP_URL') ?? this.config.SMTP_URL;
  }

  private get from(): string {
    return this.settings.get('MAIL_FROM') ?? this.config.MAIL_FROM;
  }

  /** Builds (or rebuilds after a settings change) the SMTP client. */
  private client(): Transporter | null {
    const url = this.smtpUrl ?? null;
    if (url !== this.builtFor) {
      this.transport?.close();
      this.transport = url ? createTransport(url) : null;
      this.builtFor = url;
    }
    return this.transport;
  }

  get enabled(): boolean {
    return !!this.smtpUrl;
  }

  /** Never throws: callers must not reveal delivery problems to anonymous requesters. */
  async send(mail: OutgoingMail): Promise<boolean> {
    const transport = this.client();
    if (!transport) return false;
    try {
      await transport.sendMail({ from: this.from, ...mail });
      return true;
    } catch (error) {
      // Never log the recipient address (private contact data).
      this.logger.error(`Email "${mail.subject}" could not be sent: ${(error as Error).message}`);
      return false;
    }
  }
}
