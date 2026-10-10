import { Module } from '@nestjs/common';
import { BusinessCampaignsController, CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  controllers: [CampaignsController, BusinessCampaignsController],
  providers: [CampaignsService],
})
export class CampaignsModule {}
