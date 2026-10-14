import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  CreateShiftRequest,
  CreateTaskRequest,
  CoverageSet,
  ListShiftsQuery,
  ListTasksQuery,
  ShiftDto,
  StoreStaffDto,
  TaskDto,
  UpdateTaskRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

const taskInclude = {
  store: { select: { name: true } },
  assignee: { select: publicUserSelect },
  createdBy: { select: publicUserSelect },
  completedBy: { select: publicUserSelect },
} as const satisfies Prisma.StoreTaskInclude;
type TaskRow = Prisma.StoreTaskGetPayload<{ include: typeof taskInclude }>;

const shiftInclude = {
  store: { select: { name: true } },
  user: { select: publicUserSelect },
} as const satisfies Prisma.ShiftInclude;
type ShiftRow = Prisma.ShiftGetPayload<{ include: typeof shiftInclude }>;

/** Stores of a business covered by a permission (null = every store of the business). */
function storesIn(cov: CoverageSet, businessId: string): Set<string> | null {
  if (cov.all || cov.businessIds.has(businessId)) return null;
  return new Set([...cov.stores.entries()].filter(([, b]) => b === businessId).map(([s]) => s));
}

/**
 * Store operations: to-do lists and shift plans. Managers (task.manage) assign tasks and plan
 * shifts for their stores; staff (task.work) see their store's tasks and shifts and tick off
 * tasks given to them (or to nobody in particular).
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  private async scope(actor: Actor, businessId: string) {
    const [work, manage] = await Promise.all([
      this.authz.coverage(actor, 'task.work'),
      this.authz.coverage(actor, 'task.manage'),
    ]);
    const workStores = storesIn(work, businessId);
    const manageStores = storesIn(manage, businessId);
    const canWorkAll = workStores === null || manageStores === null;
    const visible = canWorkAll ? null : new Set([...(workStores ?? []), ...(manageStores ?? [])]);
    if (visible && visible.size === 0) throw ApiError.forbidden('You have no stores here.');
    return {
      visible,
      canManage: (storeId: string) => manageStores === null || manageStores.has(storeId),
      canWork: (storeId: string) =>
        workStores === null ||
        manageStores === null ||
        !!workStores?.has(storeId) ||
        !!manageStores?.has(storeId),
    };
  }

  private toTask(
    row: TaskRow,
    actor: Actor,
    scope: Awaited<ReturnType<OperationsService['scope']>>,
  ): TaskDto {
    const canEdit = scope.canManage(row.storeId);
    return {
      id: row.id,
      businessId: row.businessId,
      storeId: row.storeId,
      storeName: row.store.name,
      title: row.title,
      notes: row.notes,
      priority: row.priority,
      status: row.status,
      dueAt: row.dueAt?.toISOString() ?? null,
      assignee: row.assignee ? toPublicUser(row.assignee) : null,
      createdBy: row.createdBy ? toPublicUser(row.createdBy) : null,
      completedBy: row.completedBy ? toPublicUser(row.completedBy) : null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      canEdit,
      canComplete:
        canEdit ||
        row.assigneeId === actor.userId ||
        (row.assigneeId === null && scope.canWork(row.storeId)),
    };
  }

  // ───────────────────────────── Tasks ─────────────────────────────

  async listTasks(actor: Actor, query: ListTasksQuery): Promise<TaskDto[]> {
    const scope = await this.scope(actor, query.businessId);
    if (query.storeId && scope.visible && !scope.visible.has(query.storeId))
      throw ApiError.notFound('Store');
    const rows = await this.prisma.storeTask.findMany({
      where: {
        businessId: query.businessId,
        deletedAt: null,
        store: { deletedAt: null },
        ...(query.storeId
          ? { storeId: query.storeId }
          : scope.visible
            ? { storeId: { in: [...scope.visible] } }
            : {}),
        ...(query.status !== 'ALL' ? { status: query.status } : {}),
        ...(query.mine ? { assigneeId: actor.userId } : {}),
      },
      include: taskInclude,
      orderBy: [
        { status: 'asc' },
        { dueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 500,
    });
    return rows.map((r) => this.toTask(r, actor, scope));
  }

  private async requireStore(storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, businessId: true },
    });
    if (!store) throw ApiError.notFound('Store');
    return store;
  }

  /** Assignees work at the store (or hold a business-wide role). */
  private async requireStaff(businessId: string, storeId: string, userId: string): Promise<void> {
    const ok = await this.prisma.user.count({
      where: {
        id: userId,
        status: 'ACTIVE',
        deletedAt: null,
        OR: [
          { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
          { roleAssignments: { some: { businessId, scopeType: 'BUSINESS', revokedAt: null } } },
        ],
      },
    });
    if (!ok) throw ApiError.validation('Choose someone who works at this store.', 'assigneeId');
  }

  async createTask(actor: Actor, request: CreateTaskRequest): Promise<TaskDto> {
    const store = await this.requireStore(request.storeId);
    await this.authz.require(actor, 'task.manage', {
      businessId: store.businessId,
      storeId: store.id,
    });
    if (request.assigneeId) await this.requireStaff(store.businessId, store.id, request.assigneeId);
    const row = await this.prisma.storeTask.create({
      data: {
        businessId: store.businessId,
        storeId: store.id,
        title: request.title,
        notes: request.notes ?? null,
        priority: request.priority,
        dueAt: request.dueAt ?? null,
        assigneeId: request.assigneeId ?? null,
        createdById: actor.userId,
      },
      include: taskInclude,
    });
    await this.announce(store.businessId, store.id);
    return this.toTask(row, actor, await this.scope(actor, store.businessId));
  }

  async updateTask(actor: Actor, taskId: string, request: UpdateTaskRequest): Promise<TaskDto> {
    const task = await this.prisma.storeTask.findFirst({
      where: { id: taskId, deletedAt: null },
      include: taskInclude,
    });
    if (!task) throw ApiError.notFound('Task');
    const scope = await this.scope(actor, task.businessId);
    const dto = this.toTask(task, actor, scope);
    const { status, ...edits } = request;
    const editing = Object.values(edits).some((v) => v !== undefined);
    if (editing && !dto.canEdit)
      throw ApiError.forbidden('Only the store manager can change tasks.');
    if (status !== undefined && !dto.canComplete)
      throw ApiError.forbidden('This task is assigned to someone else.');
    if (edits.assigneeId) await this.requireStaff(task.businessId, task.storeId, edits.assigneeId);
    const row = await this.prisma.storeTask.update({
      where: { id: taskId },
      data: {
        ...(edits.title !== undefined ? { title: edits.title } : {}),
        ...(edits.notes !== undefined ? { notes: edits.notes } : {}),
        ...(edits.priority !== undefined ? { priority: edits.priority } : {}),
        ...(edits.dueAt !== undefined ? { dueAt: edits.dueAt } : {}),
        ...(edits.assigneeId !== undefined ? { assigneeId: edits.assigneeId } : {}),
        ...(status !== undefined && status !== task.status
          ? status === 'DONE'
            ? { status, completedAt: new Date(), completedById: actor.userId }
            : { status, completedAt: null, completedById: null }
          : {}),
      },
      include: taskInclude,
    });
    await this.announce(task.businessId, task.storeId);
    return this.toTask(row, actor, scope);
  }

  async removeTask(actor: Actor, taskId: string): Promise<void> {
    const task = await this.prisma.storeTask.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { businessId: true, storeId: true },
    });
    if (!task) throw ApiError.notFound('Task');
    await this.authz.require(actor, 'task.manage', task);
    await this.prisma.storeTask.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
    await this.announce(task.businessId, task.storeId);
  }

  // ───────────────────────────── Shifts ─────────────────────────────

  private toShift(row: ShiftRow, scope: Awaited<ReturnType<OperationsService['scope']>>): ShiftDto {
    return {
      id: row.id,
      businessId: row.businessId,
      storeId: row.storeId,
      storeName: row.store.name,
      user: toPublicUser(row.user),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      title: row.title,
      notes: row.notes,
      canEdit: scope.canManage(row.storeId),
    };
  }

  async listShifts(actor: Actor, query: ListShiftsQuery): Promise<ShiftDto[]> {
    if (query.to <= query.from) throw ApiError.validation('The end must be after the start.', 'to');
    if (query.to.getTime() - query.from.getTime() > 62 * 86_400_000)
      throw ApiError.validation('Choose at most two months.', 'to');
    const scope = await this.scope(actor, query.businessId);
    if (query.storeId && scope.visible && !scope.visible.has(query.storeId))
      throw ApiError.notFound('Store');
    const rows = await this.prisma.shift.findMany({
      where: {
        businessId: query.businessId,
        store: { deletedAt: null },
        startsAt: { lt: query.to },
        endsAt: { gt: query.from },
        ...(query.storeId
          ? { storeId: query.storeId }
          : scope.visible
            ? { storeId: { in: [...scope.visible] } }
            : {}),
        ...(query.mine ? { userId: actor.userId } : {}),
      },
      include: shiftInclude,
      orderBy: { startsAt: 'asc' },
      take: 2000,
    });
    return rows.map((r) => this.toShift(r, scope));
  }

  async createShift(actor: Actor, request: CreateShiftRequest): Promise<ShiftDto> {
    const store = await this.requireStore(request.storeId);
    await this.authz.require(actor, 'task.manage', {
      businessId: store.businessId,
      storeId: store.id,
    });
    await this.requireStaff(store.businessId, store.id, request.userId);
    const overlap = await this.prisma.shift.findFirst({
      where: {
        userId: request.userId,
        startsAt: { lt: request.endsAt },
        endsAt: { gt: request.startsAt },
      },
      select: { store: { select: { name: true } } },
    });
    if (overlap)
      throw ApiError.conflict(`This person already has a shift then (${overlap.store.name}).`);
    const row = await this.prisma.shift.create({
      data: {
        businessId: store.businessId,
        storeId: store.id,
        userId: request.userId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        title: request.title ?? null,
        notes: request.notes ?? null,
        createdById: actor.userId,
      },
      include: shiftInclude,
    });
    await this.announce(store.businessId, store.id);
    return this.toShift(row, await this.scope(actor, store.businessId));
  }

  async removeShift(actor: Actor, shiftId: string): Promise<void> {
    const shift = await this.prisma.shift.findUnique({
      where: { id: shiftId },
      select: { businessId: true, storeId: true },
    });
    if (!shift) throw ApiError.notFound('Shift');
    await this.authz.require(actor, 'task.manage', shift);
    await this.prisma.shift.delete({ where: { id: shiftId } });
    await this.announce(shift.businessId, shift.storeId);
  }

  /** People a manager can give tasks and shifts to in a store. */
  async staff(actor: Actor, storeId: string): Promise<StoreStaffDto> {
    const store = await this.requireStore(storeId);
    await this.authz.require(actor, 'task.work', { businessId: store.businessId, storeId });
    const people = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        kind: 'INTERNAL',
        OR: [
          { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
          {
            roleAssignments: {
              some: { businessId: store.businessId, scopeType: 'BUSINESS', revokedAt: null },
            },
          },
        ],
      },
      select: publicUserSelect,
      orderBy: { displayName: 'asc' },
      take: 500,
    });
    return { storeId, people: people.map(toPublicUser) };
  }

  /** Live refresh for the store's people. */
  private async announce(businessId: string, storeId: string): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
          { roleAssignments: { some: { businessId, revokedAt: null, scopeType: 'BUSINESS' } } },
        ],
      },
      select: { id: true },
      take: 2000,
    });
    this.realtime.toUsers(
      users.map((u) => u.id),
      'task.changed',
      { businessId, storeId },
    );
  }
}
