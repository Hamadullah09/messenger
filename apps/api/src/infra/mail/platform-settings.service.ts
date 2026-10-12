import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { INTEGRATION_KEYS, type IntegrationKey } from '@storeline/shared';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_MS = 30_000;

/**
 * Settings the Super Admin enters in the app (provider keys for email, SMS and WhatsApp).
 * Stored AES-256-GCM encrypted in PlatformSetting and kept in memory, refreshed every 30
 * seconds so the API and the worker pick up changes. A value here overrides the server's
 * environment variable of the same name.
 */
@Injectable()
export class PlatformSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private values = new Map<IntegrationKey, string>();
  private timer: NodeJS.Timeout | null = null;
  private version = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((error: unknown) =>
      this.logger.warn({ err: error }, 'Platform settings could not be loaded yet'),
    );
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Changes whenever a value changes (lets callers rebuild clients such as SMTP). */
  get revision(): number {
    return this.version;
  }

  get(key: IntegrationKey): string | undefined {
    return this.values.get(key);
  }

  async refresh(): Promise<void> {
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: [...INTEGRATION_KEYS] } },
    });
    const next = new Map<IntegrationKey, string>();
    for (const row of rows) {
      try {
        next.set(row.key as IntegrationKey, this.crypto.decrypt(row.valueEnc, `setting:${row.key}`));
      } catch {
        this.logger.warn(`Setting ${row.key} could not be decrypted; ignoring it`);
      }
    }
    const changed =
      next.size !== this.values.size || [...next].some(([k, v]) => this.values.get(k) !== v);
    if (changed) {
      this.values = next;
      this.version += 1;
    }
  }

  async set(key: IntegrationKey, value: string | null, userId: string): Promise<void> {
    if (value === null || value === '') {
      await this.prisma.platformSetting.deleteMany({ where: { key } });
    } else {
      const valueEnc = this.crypto.encrypt(value, `setting:${key}`);
      await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, valueEnc, updatedById: userId },
        update: { valueEnc, updatedById: userId },
      });
    }
    await this.refresh();
  }
}
