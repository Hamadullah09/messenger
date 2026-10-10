import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  notificationPreferencesSchema,
  registerDeviceRequestSchema,
  registerPushRequestSchema,
  type DeviceDto,
  type NotificationConfigDto,
  type NotificationPreferences,
  type RegisterDeviceRequest,
  type RegisterPushRequest,
} from '@storeline/shared';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { AllowPasswordChangePending, CurrentActor, type Actor } from '../auth/actor';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Registers the device behind this session (call after every sign-in). Idempotent. */
  @AllowPasswordChangePending()
  @Post()
  @HttpCode(200)
  @ApiZodBody(registerDeviceRequestSchema)
  register(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(registerDeviceRequestSchema)) body: RegisterDeviceRequest,
  ): Promise<DeviceDto> {
    return this.devices.register(actor, body);
  }

  @AllowPasswordChangePending()
  @Get()
  list(@CurrentActor() actor: Actor): Promise<DeviceDto[]> {
    return this.devices.list(actor);
  }

  /** Signs a device out (its session, sockets and push registration). */
  @AllowPasswordChangePending()
  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.devices.revoke(actor, id);
  }

  @Put('current/push')
  @ApiZodBody(registerPushRequestSchema)
  registerPush(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(registerPushRequestSchema)) body: RegisterPushRequest,
  ): Promise<DeviceDto> {
    return this.devices.registerPush(actor, body);
  }

  @Delete('current/push')
  @HttpCode(204)
  async clearPush(@CurrentActor() actor: Actor): Promise<void> {
    await this.devices.clearPush(actor);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly devices: DevicesService) {}

  /** Which push providers the server supports, and the Web Push public key. */
  @Get('config')
  config(): NotificationConfigDto {
    return this.devices.config();
  }

  @Get('preferences')
  preferences(@CurrentActor() actor: Actor): Promise<NotificationPreferences> {
    return this.devices.preferences(actor);
  }

  @Put('preferences')
  @ApiZodBody(notificationPreferencesSchema)
  update(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(notificationPreferencesSchema)) body: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    return this.devices.updatePreferences(actor, body);
  }
}
