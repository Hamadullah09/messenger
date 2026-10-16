import { Body, Controller, Get, Global, Injectable, Module, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  FEATURE_KEYS,
  FEATURES,
  featureSettingKey,
  updateFeaturesRequestSchema,
  type FeatureKey,
  type FeaturesDto,
  type UpdateFeaturesRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { PlatformSettingsService } from '../../infra/mail/platform-settings.service';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

/** Parts of SMA the Super Admin switched off (stored as platform settings; on by default). */
@Injectable()
export class FeaturesService {
  constructor(private readonly settings: PlatformSettingsService) {}

  enabled(key: FeatureKey): boolean {
    return this.settings.get(featureSettingKey(key)) !== 'off';
  }

  all(): FeaturesDto {
    return Object.fromEntries(FEATURE_KEYS.map((k) => [k, this.enabled(k)])) as FeaturesDto;
  }

  /** Refuses the request when the feature is switched off. */
  require(key: FeatureKey): void {
    if (!this.enabled(key))
      throw ApiError.conflict(`${FEATURES[key].label} is turned off by the administrator.`);
  }
}

@ApiTags('platform')
@ApiBearerAuth()
@Controller({ version: '1' })
export class FeaturesController {
  constructor(
    private readonly features: FeaturesService,
    private readonly settings: PlatformSettingsService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** Which parts of the app are on (everyone signed in; the app hides what is off). */
  @Get('features')
  get(): FeaturesDto {
    return this.features.all();
  }

  @Put('platform/features')
  @ApiZodBody(updateFeaturesRequestSchema)
  async update(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(updateFeaturesRequestSchema)) body: UpdateFeaturesRequest,
  ): Promise<FeaturesDto> {
    await this.authz.require(actor, 'platform.config', null);
    const changes = Object.entries(body.features) as Array<[FeatureKey, boolean]>;
    for (const [key, on] of changes)
      await this.settings.set(featureSettingKey(key), on ? null : 'off', actor.userId);
    await this.audit.record(actor, {
      action: 'platform.features_changed',
      metadata: { features: changes.map(([k, on]) => `${k}:${on ? 'on' : 'off'}`) },
    });
    return this.features.all();
  }
}

@Global()
@Module({
  controllers: [FeaturesController],
  providers: [FeaturesService],
  exports: [FeaturesService],
})
export class FeaturesModule {}
