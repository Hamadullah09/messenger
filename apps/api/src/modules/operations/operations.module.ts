import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createShiftRequestSchema,
  createTaskRequestSchema,
  listShiftsQuerySchema,
  listTasksQuerySchema,
  updateTaskRequestSchema,
  type CreateShiftRequest,
  type CreateTaskRequest,
  type ListShiftsQuery,
  type ListTasksQuery,
  type ShiftDto,
  type StoreStaffDto,
  type TaskDto,
  type UpdateTaskRequest,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { OperationsService } from './operations.service';

@ApiTags('operations')
@ApiBearerAuth()
@Controller({ version: '1' })
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @Get('tasks')
  @ApiZodQuery(listTasksQuerySchema)
  tasks(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listTasksQuerySchema)) query: ListTasksQuery,
  ): Promise<TaskDto[]> {
    return this.ops.listTasks(actor, query);
  }

  @Post('tasks')
  @ApiZodBody(createTaskRequestSchema)
  createTask(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createTaskRequestSchema)) body: CreateTaskRequest,
  ): Promise<TaskDto> {
    return this.ops.createTask(actor, body);
  }

  @Patch('tasks/:id')
  @ApiZodBody(updateTaskRequestSchema)
  updateTask(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateTaskRequestSchema)) body: UpdateTaskRequest,
  ): Promise<TaskDto> {
    return this.ops.updateTask(actor, id, body);
  }

  @Delete('tasks/:id')
  @HttpCode(204)
  async removeTask(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.ops.removeTask(actor, id);
  }

  @Get('shifts')
  @ApiZodQuery(listShiftsQuerySchema)
  shifts(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listShiftsQuerySchema)) query: ListShiftsQuery,
  ): Promise<ShiftDto[]> {
    return this.ops.listShifts(actor, query);
  }

  @Post('shifts')
  @ApiZodBody(createShiftRequestSchema)
  createShift(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createShiftRequestSchema)) body: CreateShiftRequest,
  ): Promise<ShiftDto> {
    return this.ops.createShift(actor, body);
  }

  @Delete('shifts/:id')
  @HttpCode(204)
  async removeShift(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.ops.removeShift(actor, id);
  }

  @Get('stores/:id/staff')
  staff(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<StoreStaffDto> {
    return this.ops.staff(actor, id);
  }
}

@Module({
  controllers: [OperationsController],
  providers: [OperationsService],
})
export class OperationsModule {}
