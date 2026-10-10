import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesController, NotificationsController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PushGateway } from './push-gateway';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController, NotificationsController],
  providers: [DevicesService, PushGateway],
})
export class DevicesModule {}
