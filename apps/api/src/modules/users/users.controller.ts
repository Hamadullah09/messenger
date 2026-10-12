import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  adminSetPasswordRequestSchema,
  createRoleAssignmentRequestSchema,
  createRoleRequestSchema,
  createUserRequestSchema,
  listUsersQuerySchema,
  setUserRoleRequestSchema,
  setUserStoresRequestSchema,
  updateUserContactRequestSchema,
  updateUserRequestSchema,
  type AdminSetPasswordRequest,
  type AdminUserDto,
  type CreateRoleAssignmentRequest,
  type CreateRoleRequest,
  type CreateUserRequest,
  type ListUsersQuery,
  type Page,
  type RoleDto,
  type SetUserRoleRequest,
  type SetUserStoresRequest,
  type UpdateUserContactRequest,
  type UpdateUserRequest,
  type UserContactDto,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'businesses/:businessId/users', version: '1' })
export class BusinessUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiZodQuery(listUsersQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query(new ZodPipe(listUsersQuerySchema)) query: ListUsersQuery,
  ): Promise<Page<AdminUserDto>> {
    return this.users.list(actor, businessId, query);
  }

  @Post()
  @ApiZodBody(createUserRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<AdminUserDto> {
    return this.users.create(actor, businessId, body);
  }

  @Get(':userId')
  get(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserDto> {
    return this.users.get(actor, businessId, userId);
  }

  @Patch(':userId')
  @ApiZodBody(updateUserRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<AdminUserDto> {
    return this.users.update(actor, businessId, userId, body);
  }

  @Put(':userId/stores')
  @ApiZodBody(setUserStoresRequestSchema)
  setStores(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(setUserStoresRequestSchema)) body: SetUserStoresRequest,
  ): Promise<AdminUserDto> {
    return this.users.setStores(actor, businessId, userId, body.storeIds);
  }

  /** Change the person's role (and, for store roles, which stores). */
  @Put(':userId/role')
  @ApiZodBody(setUserRoleRequestSchema)
  setRole(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(setUserRoleRequestSchema)) body: SetUserRoleRequest,
  ): Promise<AdminUserDto> {
    return this.users.setRole(actor, businessId, userId, body);
  }

  /** Make the person manager of one store (keeps their other stores). */
  @Put(':userId/managed-stores/:storeId')
  addManagedStore(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<AdminUserDto> {
    return this.users.setStoreManager(actor, businessId, userId, storeId, true);
  }

  @Delete(':userId/managed-stores/:storeId')
  removeManagedStore(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<AdminUserDto> {
    return this.users.setStoreManager(actor, businessId, userId, storeId, false);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.removeFromBusiness(actor, businessId, userId);
  }

  @Post(':userId/sessions/revoke')
  @HttpCode(204)
  async revokeSessions(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.revokeSessions(actor, businessId, userId);
  }

  @Get(':userId/contact')
  getContact(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<UserContactDto> {
    return this.users.getContact(actor, businessId, userId);
  }

  @Put(':userId/contact')
  @ApiZodBody(updateUserContactRequestSchema)
  updateContact(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(updateUserContactRequestSchema)) body: UpdateUserContactRequest,
  ): Promise<UserContactDto> {
    return this.users.updateContact(actor, businessId, userId, body);
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
  ) {}

  @Post(':userId/deactivate')
  @HttpCode(204)
  async deactivate(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.setStatus(actor, userId, 'DEACTIVATED');
  }

  /** Delete the account (anonymised; their past messages stay as "Deleted user"). */
  @Delete(':userId')
  @HttpCode(204)
  async delete(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.deleteUser(actor, userId);
  }

  @Post(':userId/reactivate')
  @HttpCode(204)
  async reactivate(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.setStatus(actor, userId, 'ACTIVE');
  }

  /** Set a new password for someone (admins, or their store manager). Signs them out everywhere. */
  @Post(':userId/password')
  @HttpCode(204)
  @ApiZodBody(adminSetPasswordRequestSchema)
  async setPassword(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(adminSetPasswordRequestSchema)) body: AdminSetPasswordRequest,
  ): Promise<void> {
    await this.users.setPassword(actor, userId, body);
  }

  /** Turn someone's two-step verification off (lost phone). */
  @Post(':userId/mfa/reset')
  @HttpCode(204)
  async resetMfa(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.users.resetMfa(actor, userId);
  }

  @Post(':userId/role-assignments')
  @ApiZodBody(createRoleAssignmentRequestSchema)
  assignRole(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(createRoleAssignmentRequestSchema)) body: CreateRoleAssignmentRequest,
  ): Promise<{ id: string }> {
    return this.roles.assign(actor, userId, body);
  }
}

@ApiTags('roles')
@ApiBearerAuth()
@Controller({ version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  catalog(): ReturnType<RolesService['catalog']> {
    return this.roles.catalog();
  }

  @Get('businesses/:businessId/roles')
  list(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<RoleDto[]> {
    return this.roles.list(actor, businessId);
  }

  @Post('businesses/:businessId/roles')
  @ApiZodBody(createRoleRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(createRoleRequestSchema)) body: CreateRoleRequest,
  ): Promise<RoleDto> {
    return this.roles.create(actor, businessId, body);
  }

  @Delete('role-assignments/:id')
  @HttpCode(204)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.roles.revoke(actor, id);
  }
}
