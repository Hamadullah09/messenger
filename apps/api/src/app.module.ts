import { Module } from '@nestjs/common';
import { ConfigModule } from './infra/config/config.module';
import { CryptoModule } from './infra/crypto/crypto.service';
import { LoggerModule } from './infra/logging/logger.module';
import { MailModule } from './infra/mail/mail.module';
import { PrismaModule } from './infra/prisma/prisma.service';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.service';
import { AuditController } from './modules/audit/audit.controller';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { MetricsModule } from './infra/metrics/metrics.module';
import { DevicesModule } from './modules/devices/devices.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { EmergencyModule } from './modules/emergency/emergency.module';
import { HealthModule } from './modules/health/health.module';
import { MediaModule } from './modules/media/media.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { RealtimeEmitterModule } from './modules/realtime/realtime-emitter.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { ImportsModule } from './modules/imports/imports.module';
import { FeaturesModule } from './modules/platform/features.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SalesModule } from './modules/sales/sales.module';
import { StatusModule } from './modules/status/status.module';
import { CallsModule } from './modules/calls/calls.module';
import { OperationsModule } from './modules/operations/operations.module';
import { ReportsModule } from './modules/reports/reports.module';
import { IntegrationsModule } from './modules/platform/integrations.module';
import { MapsModule } from './modules/maps/maps.module';
import { UsersModule } from './modules/users/users.module';

/** Shared infrastructure for both process types (api and worker). */
export const CORE_IMPORTS = [
  ConfigModule,
  LoggerModule,
  PrismaModule,
  RedisModule,
  CryptoModule,
  MailModule,
  AuditModule,
  OutboxModule,
  AuthorizationModule,
  RealtimeEmitterModule,
  StorageModule,
];

@Module({
  imports: [
    ...CORE_IMPORTS,
    AuthModule,
    TenancyModule,
    ImportsModule,
    FeaturesModule,
    UsersModule,
    SalesModule,
    CustomersModule,
    MessagingModule,
    RealtimeModule,
    MediaModule,
    StatusModule,
    CallsModule,
    OperationsModule,
    ReportsModule,
    IntegrationsModule,
    MapsModule,
    EmergencyModule,
    CampaignsModule,
    DevicesModule,
    HealthModule,
    MetricsModule.forRole('api'),
  ],
  controllers: [AuditController],
})
export class AppModule {}
