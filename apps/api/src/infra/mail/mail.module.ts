import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MarketingChannelsService } from './marketing-channels.service';

@Global()
@Module({
  providers: [MailService, MarketingChannelsService],
  exports: [MailService, MarketingChannelsService],
})
export class MailModule {}
