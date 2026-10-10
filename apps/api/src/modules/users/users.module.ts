import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { RolesService } from './roles.service';
import { BusinessUsersController, RolesController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, MessagingModule],
  controllers: [BusinessUsersController, UsersController, RolesController],
  providers: [UsersService, RolesService],
})
export class UsersModule {}
