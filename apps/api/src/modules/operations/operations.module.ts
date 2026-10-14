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
  Put,
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
import { StaffService } from './staff.service';
import {
  attendanceDayQuerySchema,
  checkInRequestSchema,
  checkOutRequestSchema,
  checklistTemplateRequestSchema,
  checklistTickRequestSchema,
  createLeaveRequestSchema,
  decideLeaveRequestSchema,
  listLeaveQuerySchema,
  storeLocationRequestSchema,
  type AttendanceDayDto,
  type AttendanceDayQuery,
  type AttendanceRecordDto,
  type CheckInRequest,
  type CheckOutRequest,
  type ChecklistRunDto,
  type ChecklistTemplateDto,
  type ChecklistTemplateRequest,
  type ChecklistTickRequest,
  type CreateLeaveRequest,
  type DecideLeaveRequest,
  type LeaveDto,
  type ListLeaveQuery,
  type MyAttendanceDto,
  type StoreLocationRequest,
} from '@storeline/shared';
import { z } from 'zod';

const businessQuery = z.object({ businessId: z.uuid() });
const runsQuery = z.object({
  businessId: z.uuid(),
  storeId: z.uuid().optional(),
  day: z
    .string()
    .regex(/^d{4}-d{2}-d{2}$/)
    .optional(),
});

/** Attendance, checklists and leave. */
@ApiTags('operations')
@ApiBearerAuth()
@Controller({ version: '1' })
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Put('stores/:id/location')
  @HttpCode(204)
  @ApiZodBody(storeLocationRequestSchema)
  async setLocation(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(storeLocationRequestSchema)) body: StoreLocationRequest,
  ): Promise<void> {
    await this.staff.setStoreLocation(actor, id, body);
  }

  @Get('attendance/me')
  @ApiZodQuery(businessQuery)
  mine(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(businessQuery)) q: z.infer<typeof businessQuery>,
  ): Promise<MyAttendanceDto> {
    return this.staff.mine(actor, q.businessId);
  }

  @Post('attendance/check-in')
  @ApiZodBody(checkInRequestSchema)
  checkIn(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(checkInRequestSchema)) body: CheckInRequest,
  ): Promise<AttendanceRecordDto> {
    return this.staff.checkIn(actor, body);
  }

  @Post('attendance/check-out')
  @HttpCode(200)
  @ApiZodBody(checkOutRequestSchema)
  checkOut(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(checkOutRequestSchema)) body: CheckOutRequest,
  ): Promise<AttendanceRecordDto> {
    return this.staff.checkOut(actor, body);
  }

  @Get('attendance/day')
  @ApiZodQuery(attendanceDayQuerySchema)
  day(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(attendanceDayQuerySchema)) q: AttendanceDayQuery,
  ): Promise<AttendanceDayDto> {
    return this.staff.day(actor, q);
  }

  @Get('checklists/templates')
  @ApiZodQuery(businessQuery)
  templates(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(businessQuery)) q: z.infer<typeof businessQuery>,
  ): Promise<ChecklistTemplateDto[]> {
    return this.staff.listTemplates(actor, q.businessId);
  }

  @Post('checklists/templates')
  @ApiZodBody(checklistTemplateRequestSchema)
  createTemplate(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(checklistTemplateRequestSchema)) body: ChecklistTemplateRequest,
  ): Promise<ChecklistTemplateDto[]> {
    return this.staff.saveTemplate(actor, null, body);
  }

  @Patch('checklists/templates/:id')
  @ApiZodBody(checklistTemplateRequestSchema)
  updateTemplate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(checklistTemplateRequestSchema)) body: ChecklistTemplateRequest,
  ): Promise<ChecklistTemplateDto[]> {
    return this.staff.saveTemplate(actor, id, body);
  }

  @Delete('checklists/templates/:id')
  @HttpCode(204)
  async removeTemplate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.staff.removeTemplate(actor, id);
  }

  @Get('checklists/runs')
  @ApiZodQuery(runsQuery)
  runs(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(runsQuery)) q: z.infer<typeof runsQuery>,
  ): Promise<ChecklistRunDto[]> {
    return this.staff.runs(actor, q.businessId, q.storeId, q.day);
  }

  @Put('checklists/runs/:id/items')
  @ApiZodBody(checklistTickRequestSchema)
  tick(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(checklistTickRequestSchema)) body: ChecklistTickRequest,
  ): Promise<ChecklistRunDto> {
    return this.staff.tick(actor, id, body);
  }

  @Get('leave')
  @ApiZodQuery(listLeaveQuerySchema)
  leave(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listLeaveQuerySchema)) q: ListLeaveQuery,
  ): Promise<LeaveDto[]> {
    return this.staff.listLeave(actor, q);
  }

  @Post('leave')
  @ApiZodBody(createLeaveRequestSchema)
  requestLeave(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createLeaveRequestSchema)) body: CreateLeaveRequest,
  ): Promise<LeaveDto[]> {
    return this.staff.requestLeave(actor, body);
  }

  @Post('leave/:id/decide')
  @HttpCode(204)
  @ApiZodBody(decideLeaveRequestSchema)
  async decide(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideLeaveRequestSchema)) body: DecideLeaveRequest,
  ): Promise<void> {
    await this.staff.decide(actor, id, body);
  }

  @Post('leave/:id/cancel')
  @HttpCode(204)
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.staff.cancelLeave(actor, id);
  }
}

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
  async removeTask(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
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
  async removeShift(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.ops.removeShift(actor, id);
  }

  @Get('stores/:id/staff')
  staff(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StoreStaffDto> {
    return this.ops.staff(actor, id);
  }
}

@Module({
  controllers: [OperationsController, StaffController],
  providers: [OperationsService, StaffService],
})
export class OperationsModule {}
