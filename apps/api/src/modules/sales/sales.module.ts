import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BillingController, PublicCrmController } from './billing.controller';
import { PublicPayService, SubscriptionsService } from './billing.service';
import { BillingRunner } from './billing-scheduler';
import { CrmSettingsService, InvoiceFactory } from './crm-core';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { FbrController } from './fbr.controller';
import { FbrService } from './fbr.service';
import { LeadImportService } from './lead-import.service';
import {
  OnlinePaymentsPublicController,
  PaymentGatewaysController,
} from './online-payments.controller';
import { OnlinePaymentsService } from './online-payments.service';
import { QuotesService } from './quotes.service';
import { PublicLeadsController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SmaBillingController } from './sma-billing.controller';
import { SmaBillingService } from './sma-billing.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [
    SalesController,
    PublicLeadsController,
    CrmController,
    BillingController,
    PublicCrmController,
    PaymentGatewaysController,
    OnlinePaymentsPublicController,
    SmaBillingController,
    FbrController,
  ],
  providers: [
    SalesService,
    CrmService,
    CrmSettingsService,
    InvoiceFactory,
    QuotesService,
    SubscriptionsService,
    PublicPayService,
    BillingRunner,
    LeadImportService,
    OnlinePaymentsService,
    SmaBillingService,
    FbrService,
  ],
})
export class SalesModule {}
