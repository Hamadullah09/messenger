import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { PublicLeadsController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [SalesController, PublicLeadsController, CrmController],
  providers: [SalesService, CrmService],
})
export class SalesModule {}
