import { Module } from '@nestjs/common';
import { CustomerCampaignsService } from './customer-campaigns.service';
import {
  CustomerCampaignsController,
  CustomersController,
  PublicUnsubscribeController,
} from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController, CustomerCampaignsController, PublicUnsubscribeController],
  providers: [CustomersService, CustomerCampaignsService],
})
export class CustomersModule {}
