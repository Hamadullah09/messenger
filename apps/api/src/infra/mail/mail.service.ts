import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends transactional email over SMTP. Local development uses Mailpit (compose.yaml), which
 * catches every message and shows it at http://localhost:18025 — nothing leaves the machine.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.transport = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  /** Never throws: callers must not reveal delivery problems to anonymous requesters. */
  async send(mail: OutgoingMail): Promise<boolean> {
    if (!this.transport) return false;
    try {
      await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
      return true;
    } catch (error) {
      // Never log the recipient address (private contact data).
      this.logger.error(`Email "${mail.subject}" could not be sent: ${(error as Error).message}`);
      return false;
    }
  }
}
