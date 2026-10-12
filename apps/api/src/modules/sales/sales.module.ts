import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PublicLeadsController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [SalesController, PublicLeadsController],
  providers: [SalesService],
})
export class SalesModule {}
