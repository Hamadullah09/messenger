import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PushPayload, WebPushSubscription } from '@storeline/shared';
import webpush, { WebPushError } from 'web-push';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';

export type PushOutcome = 'sent' | 'gone';

export interface PushTarget {
  provider: 'WEB_PUSH' | 'FCM' | 'APNS';
  /** Decrypted token: JSON Web Push subscription, FCM registration token or APNs device token. */
  token: string;
}

/**
 * Sends notifications through the platforms' push services. Web Push (VAPID, RFC 8030/8291) is
 * implemented; FCM and APNs need provider credentials and report "not configured" until an
 * adapter is added (docs/architecture/clients.md) — devices cannot register for them before.
 */
@Injectable()
export class PushGateway {
  private readonly logger = new Logger(PushGateway.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get webPushEnabled(): boolean {
    return !!(this.config.VAPID_PUBLIC_KEY && this.config.VAPID_PRIVATE_KEY);
  }

  get webPushPublicKey(): string | null {
    return this.webPushEnabled ? this.config.VAPID_PUBLIC_KEY! : null;
  }

  enabled(provider: PushTarget['provider']): boolean {
    return provider === 'WEB_PUSH' ? this.webPushEnabled : false;
  }

  /** SSRF guard: the server only POSTs over HTTPS to allow-listed push services. */
  assertAllowedEndpoint(endpoint: string): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('invalid_endpoint');
    }
    const host = url.hostname.toLowerCase();
    const allowed = this.config.WEB_PUSH_ALLOWED_HOSTS.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    if (!allowed || url.protocol !== 'https:' || url.username || url.password)
      throw new Error('endpoint_not_allowed');
  }

  async send(
    target: PushTarget,
    payload: PushPayload,
    options: { urgency: 'normal' | 'high'; ttlSeconds: number },
  ): Promise<PushOutcome> {
    if (target.provider !== 'WEB_PUSH' || !this.webPushEnabled)
      throw new Error(`push provider ${target.provider} is not configured`);
    const subscription = JSON.parse(target.token) as WebPushSubscription;
    this.assertAllowedEndpoint(subscription.endpoint);
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: {
          subject: this.config.VAPID_SUBJECT,
          publicKey: this.config.VAPID_PUBLIC_KEY!,
          privateKey: this.config.VAPID_PRIVATE_KEY!,
        },
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
        timeout: 10_000,
      });
      return 'sent';
    } catch (error) {
      // 404/410: the subscription expired or the user revoked permission — forget it.
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410))
        return 'gone';
      this.logger.warn(
        { status: error instanceof WebPushError ? error.statusCode : undefined },
        'Web Push delivery failed',
      );
      throw error;
    }
  }
}
