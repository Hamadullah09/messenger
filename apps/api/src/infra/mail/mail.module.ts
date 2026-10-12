import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MarketingChannelsService } from './marketing-channels.service';
import { PlatformSettingsService } from './platform-settings.service';

@Global()
@Module({
  providers: [PlatformSettingsService, MailService, MarketingChannelsService],
  exports: [PlatformSettingsService, MailService, MarketingChannelsService],
})
export class MailModule {}
