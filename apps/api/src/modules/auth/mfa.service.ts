import { Inject, Injectable } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';

const PERIOD_SECONDS = 30;

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the profile supported by all authenticator apps. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
  ) {}

  createSecret(): string {
    return new Secret({ size: 20 }).base32;
  }

  async describe(
    secretBase32: string,
    username: string,
  ): Promise<{ otpauthUrl: string; qrCodeDataUrl: string }> {
    const otpauthUrl = this.totp(secretBase32, username).toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    });
    return { otpauthUrl, qrCodeDataUrl };
  }

  /**
   * Validates a code allowing ±1 step of clock drift. Returns the matched time step so the
   * caller can reject replays of a step that was already used.
   */
  verify(
    secretBase32: string,
    code: string,
    lastUsedStep: bigint | null,
    now = Date.now(),
  ): bigint | null {
    const delta = this.totp(secretBase32).validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return null;
    const step = BigInt(Math.floor(now / 1000 / PERIOD_SECONDS) + delta);
    if (lastUsedStep !== null && step <= lastUsedStep) return null;
    return step;
  }

  /** Generate a code (used by tests and the seed's development helper only). */
  generate(secretBase32: string, now = Date.now()): string {
    return this.totp(secretBase32).generate({ timestamp: now });
  }

  encryptSecret(userId: string, secretBase32: string): string {
    return this.crypto.encrypt(secretBase32, `mfa:${userId}`);
  }

  decryptSecret(userId: string, envelope: string): string {
    return this.crypto.decrypt(envelope, `mfa:${userId}`);
  }

  private totp(secretBase32: string, label = 'user'): TOTP {
    return new TOTP({
      issuer: this.config.MFA_ISSUER,
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(secretBase32),
    });
  }
}
