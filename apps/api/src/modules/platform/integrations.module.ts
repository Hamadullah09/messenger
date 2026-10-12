import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  INTEGRATION_KEYS,
  testIntegrationRequestSchema,
  updateIntegrationsRequestSchema,
  type IntegrationKey,
  type IntegrationsDto,
  type TestIntegrationRequest,
  type UpdateIntegrationsRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { MarketingChannelsService } from '../../infra/mail/marketing-channels.service';
import { PlatformSettingsService } from '../../infra/mail/platform-settings.service';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

const SECRET_KEYS = new Set<IntegrationKey>(['SMTP_URL', 'TWILIO_AUTH_TOKEN', 'WHATSAPP_ACCESS_TOKEN']);

/** Shows enough to recognise a value, never the secret itself. */
function preview(key: IntegrationKey, value: string): string {
  if (key === 'SMTP_URL') {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.username ? `${url.username}:••••@` : ''}${url.host}`;
    } catch {
      return '••••';
    }
  }
  if (SECRET_KEYS.has(key)) return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
  return value;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: PlatformSettingsService,
    private readonly channels: MarketingChannelsService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async requirePlatform(actor: Actor): Promise<void> {
    await this.authz.require(actor, 'platform.config', null);
  }

  async get(actor: Actor): Promise<IntegrationsDto> {
    await this.requirePlatform(actor);
    await this.settings.refresh();
    return {
      channels: this.channels.available(),
      keys: INTEGRATION_KEYS.map((key) => {
        const app = this.settings.get(key);
        const server = this.config[key] as string | undefined;
        const value = app ?? server;
        return {
          key,
          source: app ? 'app' : server ? 'server' : 'none',
          preview: value ? preview(key, value) : null,
          secret: SECRET_KEYS.has(key),
        };
      }),
    };
  }

  async update(actor: Actor, request: UpdateIntegrationsRequest): Promise<IntegrationsDto> {
    await this.requirePlatform(actor);
    const entries = Object.entries(request.values) as Array<[IntegrationKey, string | null]>;
    for (const [key, value] of entries) {
      if (key === 'SMTP_URL' && value) {
        try {
          const url = new URL(value);
          if (!['smtp:', 'smtps:'].includes(url.protocol)) throw new Error('protocol');
        } catch {
          throw ApiError.validation('Use smtp://user:password@host:port', 'values.SMTP_URL');
        }
      }
      await this.settings.set(key, value, actor.userId);
    }
    await this.audit.record(actor, {
      action: 'platform.integrations_changed',
      metadata: { keys: entries.map(([k, v]) => `${k}:${v ? 'set' : 'cleared'}`) },
    });
    return this.get(actor);
  }

  /** Sends one test message so the Super Admin can see the keys work. */
  async test(actor: Actor, request: TestIntegrationRequest): Promise<{ ok: boolean; detail: string }> {
    await this.requirePlatform(actor);
    const text = 'Test message from SMA Technology: your connection works.';
    const result = await this.channels.send(request.channel, {
      to: request.to,
      name: 'SMA',
      subject: 'SMA test message',
      text,
      html: `<p>${text}</p>`,
      templateParams: ['SMA', text],
    });
    await this.audit.record(actor, {
      action: 'platform.integration_tested',
      metadata: { channel: request.channel, ok: result.ok },
    });
    return result.ok
      ? { ok: true, detail: 'Accepted by the provider. Check that it arrived.' }
      : { ok: false, detail: result.error };
  }
}

@ApiTags('platform')
@ApiBearerAuth()
@Controller({ path: 'platform/integrations', version: '1' })
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  get(@CurrentActor() actor: Actor): Promise<IntegrationsDto> {
    return this.integrations.get(actor);
  }

  @Put()
  @ApiZodBody(updateIntegrationsRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(updateIntegrationsRequestSchema)) body: UpdateIntegrationsRequest,
  ): Promise<IntegrationsDto> {
    return this.integrations.update(actor, body);
  }

  @Post('test')
  @HttpCode(200)
  @ApiZodBody(testIntegrationRequestSchema)
  test(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(testIntegrationRequestSchema)) body: TestIntegrationRequest,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.integrations.test(actor, body);
  }
}

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
