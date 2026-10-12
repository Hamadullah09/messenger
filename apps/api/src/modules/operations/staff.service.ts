import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AttendanceDayDto,
  AttendanceDayQuery,
  AttendanceRecordDto,
  AttendanceRowDto,
  CheckInRequest,
  CheckOutRequest,
  ChecklistRunDto,
  ChecklistTemplateDto,
  ChecklistTemplateRequest,
  ChecklistTickRequest,
  CreateLeaveRequest,
  DecideLeaveRequest,
  LeaveDto,
  ListLeaveQuery,
  MyAttendanceDto,
  StoreLocationRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { attachmentMediaSelect, toAttachmentDto } from '../media/media.mapper';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

/** Minutes after the shift start before someone counts as late. */
const LATE_GRACE_MIN = 5;
/** A check-in this long before a shift starts still belongs to it. */
const EARLY_WINDOW_MS = 2 * 3_600_000;
const DAY = 86_400_000;

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** "2026-10-14" → local midnight, and the DATE value stored for that day. */
function localDay(day: string): { start: Date; end: Date; date: Date } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1), date: new Date(Date.UTC(y, m - 1, d)) };
}
function todayKey(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const recordInclude = {
  store: { select: { name: true, geofenceMeters: true } },
  user: { select: publicUserSelect },
  shift: { select: { id: true, startsAt: true, endsAt: true } },
} as const satisfies Prisma.AttendanceRecordInclude;
type RecordRow = Prisma.AttendanceRecordGetPayload<{ include: typeof recordInclude }>;

function toRecord(r: RecordRow): AttendanceRecordDto {
  const late = r.shift ? Math.max(0, Math.round((r.checkInAt.getTime() - r.shift.startsAt.getTime()) / 60_000)) : 0;
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: r.store.name,
    user: toPublicUser(r.user),
    checkInAt: r.checkInAt.toISOString(),
    checkOutAt: r.checkOutAt?.toISOString() ?? null,
    checkInDistance: r.checkInDistance,
    checkOutDistance: r.checkOutDistance,
    outside: r.checkInDistance !== null && r.checkInDistance > r.store.geofenceMeters,
    shift: r.shift ? { id: r.shift.id, startsAt: r.shift.startsAt.toISOString(), endsAt: r.shift.endsAt.toISOString() } : null,
    lateMinutes: late > LATE_GRACE_MIN ? late : 0,
    note: r.note,
  };
}

/**
 * Staff day-to-day: attendance (check in/out with distance from the store, matched to shifts),
 * daily checklists with photo proof, and leave requests. Staff use task.work; store managers
 * (task.manage) see the attendance board, run checklists and approve leave.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly realtime: RealtimeEmitter,
    private readonly audit: AuditService,
  ) {}

  private async store(storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, businessId: true, name: true, latitude: true, longitude: true, geofenceMeters: true },
    });
    if (!store) throw ApiError.notFound('Store');
    return store;
  }

  /** Stores of a business the actor covers with a permission (null = all of them). */
  private async covered(actor: Actor, permission: 'task.work' | 'task.manage', businessId: string) {
    const cov = await this.authz.coverage(actor, permission);
    if (cov.all || cov.businessIds.has(businessId)) return null;
    return new Set([...cov.stores.entries()].filter(([, b]) => b === businessId).map(([s]) => s));
  }

  private async notifyStore(businessId: string, storeId: string, extra: string[] = []) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
          { roleAssignments: { some: { businessId, scopeType: 'BUSINESS', revokedAt: null } } },
        ],
      },
      select: { id: true },
      take: 2000,
    });
    this.realtime.toUsers([...users.map((u) => u.id), ...extra], 'task.changed', { businessId, storeId });
  }

  // ───────────────────────────── Store location ─────────────────────────────

  async setStoreLocation(actor: Actor, storeId: string, request: StoreLocationRequest): Promise<void> {
    const store = await this.store(storeId);
    const scope = { businessId: store.businessId, storeId };
    if (!(await this.authz.can(actor, 'store.update', scope)) && !(await this.authz.can(actor, 'task.manage', scope)))
      throw ApiError.forbidden('Only managers can set the store location.');
    if ((request.latitude === null) !== (request.longitude === null))
      throw ApiError.validation('Give both latitude and longitude.', 'latitude');
    await this.prisma.store.update({ where: { id: storeId }, data: request });
    await this.audit.record(actor, { action: 'store.location_set', businessId: store.businessId, storeId });
  }

  // ───────────────────────────── Attendance ─────────────────────────────

  async mine(actor: Actor, businessId: string): Promise<MyAttendanceDto> {
    const covered = await this.covered(actor, 'task.work', businessId);
    const stores = await this.prisma.store.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(covered ? { id: { in: [...covered] } } : {}),
      },
      select: { id: true, name: true, latitude: true, longitude: true, geofenceMeters: true },
      orderBy: { name: 'asc' },
    });
    const { start, end } = localDay(todayKey());
    const [open, shifts, recent] = await Promise.all([
      this.prisma.attendanceRecord.findFirst({
        where: { userId: actor.userId, businessId, checkOutAt: null, checkInAt: { gt: new Date(Date.now() - 20 * 3_600_000) } },
        include: recordInclude,
        orderBy: { checkInAt: 'desc' },
      }),
      this.prisma.shift.findMany({
        where: { userId: actor.userId, businessId, startsAt: { lt: end }, endsAt: { gt: start } },
        include: { store: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { userId: actor.userId, businessId },
        include: recordInclude,
        orderBy: { checkInAt: 'desc' },
        take: 14,
      }),
    ]);
    return {
      open: open ? toRecord(open) : null,
      shifts: shifts.map((s) => ({
        id: s.id,
        storeId: s.storeId,
        storeName: s.store.name,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
      })),
      stores,
      recent: recent.map(toRecord),
    };
  }

  async checkIn(actor: Actor, request: CheckInRequest): Promise<AttendanceRecordDto> {
    const store = await this.store(request.storeId);
    await this.authz.require(actor, 'task.work', { businessId: store.businessId, storeId: store.id });
    const open = await this.prisma.attendanceRecord.findFirst({
      where: { userId: actor.userId, checkOutAt: null, checkInAt: { gt: new Date(Date.now() - 20 * 3_600_000) } },
      select: { store: { select: { name: true } } },
    });
    if (open) throw ApiError.conflict(`You are already checked in at ${open.store.name}. Check out first.`);
    const now = new Date();
    const shift = await this.prisma.shift.findFirst({
      where: {
        userId: actor.userId,
        storeId: store.id,
        startsAt: { lte: new Date(now.getTime() + EARLY_WINDOW_MS) },
        endsAt: { gt: now },
      },
      orderBy: { startsAt: 'asc' },
      select: { id: true },
    });
    const hasPoint = request.lat !== undefined && request.lng !== undefined;
    const distance =
      hasPoint && store.latitude !== null && store.longitude !== null
        ? distanceMetres({ lat: request.lat!, lng: request.lng! }, { lat: store.latitude, lng: store.longitude })
        : null;
    const row = await this.prisma.attendanceRecord.create({
      data: {
        businessId: store.businessId,
        storeId: store.id,
        userId: actor.userId,
        shiftId: shift?.id ?? null,
        checkInAt: now,
        checkInLat: request.lat ?? null,
        checkInLng: request.lng ?? null,
        checkInAccuracy: request.accuracy !== undefined ? Math.round(request.accuracy) : null,
        checkInDistance: distance,
        note: request.note ?? null,
      },
      include: recordInclude,
    });
    await this.notifyStore(store.businessId, store.id);
    return toRecord(row);
  }

  async checkOut(actor: Actor, request: CheckOutRequest): Promise<AttendanceRecordDto> {
    const open = await this.prisma.attendanceRecord.findFirst({
      where: { userId: actor.userId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
      include: { store: { select: { latitude: true, longitude: true } } },
    });
    if (!open) throw ApiError.conflict('You are not checked in.');
    const distance =
      request.lat !== undefined && request.lng !== undefined && open.store.latitude !== null && open.store.longitude !== null
        ? distanceMetres({ lat: request.lat, lng: request.lng }, { lat: open.store.latitude, lng: open.store.longitude })
        : null;
    const row = await this.prisma.attendanceRecord.update({
      where: { id: open.id },
      data: {
        checkOutAt: new Date(),
        checkOutLat: request.lat ?? null,
        checkOutLng: request.lng ?? null,
        checkOutDistance: distance,
      },
      include: recordInclude,
    });
    await this.notifyStore(row.businessId, row.storeId);
    return toRecord(row);
  }

  /** Managers' board: everyone's shifts for the day with on time / late / absent / on leave. */
  async day(actor: Actor, query: AttendanceDayQuery): Promise<AttendanceDayDto> {
    const covered = await this.covered(actor, 'task.manage', query.businessId);
    if (covered && covered.size === 0) throw ApiError.forbidden('Only store managers can see attendance.');
    if (query.storeId && covered && !covered.has(query.storeId)) throw ApiError.notFound('Store');
    const storeFilter = query.storeId ? { storeId: query.storeId } : covered ? { storeId: { in: [...covered] } } : {};
    const { start, end, date } = localDay(query.day);
    const [shifts, records, leave] = await Promise.all([
      this.prisma.shift.findMany({
        where: { businessId: query.businessId, ...storeFilter, startsAt: { gte: start, lt: end } },
        include: { user: { select: publicUserSelect }, store: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          businessId: query.businessId,
          ...storeFilter,
          checkInAt: { gte: new Date(start.getTime() - EARLY_WINDOW_MS), lt: end },
        },
        include: recordInclude,
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          businessId: query.businessId,
          ...storeFilter,
          status: 'APPROVED',
          startDate: { lte: date },
          endDate: { gte: date },
        },
        select: { userId: true },
      }),
    ]);
    const onLeave = new Set(leave.map((l) => l.userId));
    const used = new Set<string>();
    const now = Date.now();
    const rows: AttendanceRowDto[] = shifts.map((s) => {
      const record =
        records.find((r) => r.shiftId === s.id) ??
        records.find(
          (r) =>
            !used.has(r.id) &&
            r.userId === s.userId &&
            r.storeId === s.storeId &&
            r.checkInAt.getTime() >= s.startsAt.getTime() - EARLY_WINDOW_MS &&
            r.checkInAt < s.endsAt,
        );
      if (record) used.add(record.id);
      const dto = record ? { ...toRecord(record), shift: { id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() } } : null;
      if (dto && record) {
        const late = Math.round((record.checkInAt.getTime() - s.startsAt.getTime()) / 60_000);
        dto.lateMinutes = late > LATE_GRACE_MIN ? late : 0;
      }
      const status: AttendanceRowDto['status'] = onLeave.has(s.userId)
        ? 'ON_LEAVE'
        : dto
          ? dto.lateMinutes > 0
            ? 'LATE'
            : 'ON_TIME'
          : now < s.startsAt.getTime() + LATE_GRACE_MIN * 60_000
            ? 'NOT_YET'
            : 'ABSENT';
      return {
        user: toPublicUser(s.user),
        storeId: s.storeId,
        storeName: s.store.name,
        shift: { id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), title: s.title },
        record: dto,
        status,
      };
    });
    for (const r of records) {
      if (used.has(r.id) || r.checkInAt < start) continue;
      rows.push({ user: toPublicUser(r.user), storeId: r.storeId, storeName: r.store.name, shift: null, record: toRecord(r), status: 'NO_SHIFT' });
    }
    const count = (s: AttendanceRowDto['status']) => rows.filter((r) => r.status === s).length;
    return {
      day: query.day,
      rows,
      summary: {
        onTime: count('ON_TIME'),
        late: count('LATE'),
        absent: count('ABSENT'),
        notYet: count('NOT_YET'),
        onLeave: count('ON_LEAVE'),
        outside: rows.filter((r) => r.record?.outside).length,
      },
    };
  }

  // ───────────────────────────── Checklists ─────────────────────────────

  private templateDto(
    t: { id: string; businessId: string; storeId: string | null; name: string; items: Prisma.JsonValue; active: boolean },
    storeName: string | null,
    canEdit: boolean,
  ): ChecklistTemplateDto {
    return {
      id: t.id,
      businessId: t.businessId,
      storeId: t.storeId,
      storeName,
      name: t.name,
      items: (t.items as ChecklistTemplateDto['items']) ?? [],
      active: t.active,
      canEdit,
    };
  }

  async listTemplates(actor: Actor, businessId: string): Promise<ChecklistTemplateDto[]> {
    const work = await this.covered(actor, 'task.work', businessId);
    const manage = await this.covered(actor, 'task.manage', businessId);
    if (work && work.size === 0 && manage && manage.size === 0) throw ApiError.forbidden();
    const rows = await this.prisma.checklistTemplate.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const stores = new Map(
      (await this.prisma.store.findMany({ where: { businessId }, select: { id: true, name: true } })).map((s) => [s.id, s.name]),
    );
    return rows
      .filter((t) => !t.storeId || !work || work.has(t.storeId) || !manage || manage.has(t.storeId))
      .map((t) =>
        this.templateDto(
          t,
          t.storeId ? (stores.get(t.storeId) ?? null) : null,
          t.storeId ? manage === null || manage.has(t.storeId) : manage === null,
        ),
      );
  }

  private normaliseItems(items: ChecklistTemplateRequest['items']) {
    const seen = new Set<string>();
    return items.map((i, n) => {
      let key = (i.key ?? '').replace(/[^\w-]/g, '').slice(0, 40) || `item-${n + 1}`;
      while (seen.has(key)) key = `${key}-${randomUUID().slice(0, 4)}`;
      seen.add(key);
      return { key, label: i.label, photo: i.photo };
    });
  }

  async saveTemplate(actor: Actor, id: string | null, request: ChecklistTemplateRequest): Promise<ChecklistTemplateDto[]> {
    const storeId = request.storeId ?? null;
    if (storeId) {
      const store = await this.store(storeId);
      if (store.businessId !== request.businessId) throw ApiError.validation('Store not in this business.', 'storeId');
    }
    await this.authz.require(actor, 'task.manage', { businessId: request.businessId, storeId });
    const data = {
      businessId: request.businessId,
      storeId,
      name: request.name,
      items: this.normaliseItems(request.items) as unknown as Prisma.InputJsonValue,
      ...(request.active !== undefined ? { active: request.active } : {}),
    };
    if (id) {
      const updated = await this.prisma.checklistTemplate.updateMany({
        where: { id, businessId: request.businessId, deletedAt: null },
        data,
      });
      if (updated.count === 0) throw ApiError.notFound('Checklist');
    } else {
      await this.prisma.checklistTemplate.create({ data: { ...data, createdById: actor.userId } });
    }
    return this.listTemplates(actor, request.businessId);
  }

  async removeTemplate(actor: Actor, id: string): Promise<void> {
    const t = await this.prisma.checklistTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!t) throw ApiError.notFound('Checklist');
    await this.authz.require(actor, 'task.manage', { businessId: t.businessId, storeId: t.storeId });
    await this.prisma.checklistTemplate.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
  }

  private runInclude = {
    template: { select: { id: true, name: true, items: true } },
    items: { include: { media: { select: { ...attachmentMediaSelect, status: true } } } },
  } as const satisfies Prisma.ChecklistRunInclude;

  private async runDto(
    run: Prisma.ChecklistRunGetPayload<{ include: StaffService['runInclude'] }>,
    storeName: string,
    canWork: boolean,
  ): Promise<ChecklistRunDto> {
    const defs = (run.template.items as Array<{ key: string; label: string; photo: boolean }>) ?? [];
    const userIds = [...new Set([...run.items.map((i) => i.checkedById), run.completedById].filter((v): v is string => !!v))];
    const users = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: publicUserSelect })).map((u) => [u.id, toPublicUser(u)]),
    );
    const items = defs.map((d) => {
      const it = run.items.find((i) => i.itemKey === d.key);
      return {
        key: d.key,
        label: d.label,
        photo: d.photo,
        checked: it?.checked ?? false,
        checkedBy: it?.checkedById ? (users.get(it.checkedById) ?? null) : null,
        checkedAt: it?.checkedAt?.toISOString() ?? null,
        note: it?.note ?? null,
        media: it?.media && it.media.status === 'READY' ? toAttachmentDto(it.media) : null,
      };
    });
    return {
      id: run.id,
      template: { id: run.template.id, name: run.template.name },
      storeId: run.storeId,
      storeName,
      day: dateKey(run.day),
      items,
      done: items.filter((i) => i.checked).length,
      total: items.length,
      completedAt: run.completedAt?.toISOString() ?? null,
      completedBy: run.completedById ? (users.get(run.completedById) ?? null) : null,
      canWork,
    };
  }

  /** Today's (or a past day's) checklists for the actor's stores; runs are created on first view. */
  async runs(actor: Actor, businessId: string, storeId: string | undefined, day: string | undefined): Promise<ChecklistRunDto[]> {
    const work = await this.covered(actor, 'task.work', businessId);
    const manage = await this.covered(actor, 'task.manage', businessId);
    const allowed = (id: string) => !work || work.has(id) || !manage || manage.has(id);
    const stores = await this.prisma.store.findMany({
      where: { businessId, deletedAt: null, status: 'ACTIVE', ...(storeId ? { id: storeId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const visible = stores.filter((s) => allowed(s.id));
    if (visible.length === 0) return [];
    const key = day ?? todayKey();
    const { date } = localDay(key);
    const isToday = key === todayKey();
    const templates = await this.prisma.checklistTemplate.findMany({
      where: { businessId, deletedAt: null, active: true },
      select: { id: true, storeId: true },
    });
    const result: ChecklistRunDto[] = [];
    for (const store of visible) {
      for (const t of templates.filter((x) => !x.storeId || x.storeId === store.id)) {
        let run = await this.prisma.checklistRun.findUnique({
          where: { templateId_storeId_day: { templateId: t.id, storeId: store.id, day: date } },
          include: this.runInclude,
        });
        if (!run && isToday) {
          run = await this.prisma.checklistRun
            .create({
              data: { templateId: t.id, businessId, storeId: store.id, day: date },
              include: this.runInclude,
            })
            .catch(() =>
              this.prisma.checklistRun.findUnique({
                where: { templateId_storeId_day: { templateId: t.id, storeId: store.id, day: date } },
                include: this.runInclude,
              }),
            );
        }
        if (run) result.push(await this.runDto(run, store.name, isToday && allowed(store.id)));
      }
    }
    return result;
  }

  async tick(actor: Actor, runId: string, request: ChecklistTickRequest): Promise<ChecklistRunDto> {
    const run = await this.prisma.checklistRun.findUnique({ where: { id: runId }, include: this.runInclude });
    if (!run) throw ApiError.notFound('Checklist');
    await this.authz.require(actor, 'task.work', { businessId: run.businessId, storeId: run.storeId });
    if (dateKey(run.day) !== dateKey(localDay(todayKey()).date))
      throw ApiError.conflict('Only today’s checklist can be changed.');
    const def = (run.template.items as Array<{ key: string; photo: boolean }>).find((i) => i.key === request.itemKey);
    if (!def) throw ApiError.validation('That check is not on this list.', 'itemKey');
    const existing = run.items.find((i) => i.itemKey === request.itemKey);
    const mediaId = request.mediaId !== undefined ? request.mediaId : (existing?.mediaId ?? null);
    if (request.mediaId) {
      const media = await this.prisma.mediaAsset.findFirst({
        where: { id: request.mediaId, uploaderId: actor.userId, forOps: true, businessId: run.businessId },
        select: { status: true, kind: true },
      });
      if (!media || media.kind !== 'IMAGE') throw ApiError.validation('The photo was not found.', 'mediaId');
      if (media.status !== 'READY') throw ApiError.conflict('The photo is still being checked. Please wait a moment.');
    }
    if (request.checked && def.photo && !mediaId) throw ApiError.validation('This check needs a photo.', 'mediaId');
    await this.prisma.$transaction(async (tx) => {
      await tx.checklistRunItem.upsert({
        where: { runId_itemKey: { runId, itemKey: request.itemKey } },
        create: {
          runId,
          itemKey: request.itemKey,
          checked: request.checked,
          checkedById: request.checked ? actor.userId : null,
          checkedAt: request.checked ? new Date() : null,
          note: request.note ?? null,
          mediaId,
        },
        update: {
          checked: request.checked,
          checkedById: request.checked ? actor.userId : null,
          checkedAt: request.checked ? new Date() : null,
          ...(request.note !== undefined ? { note: request.note } : {}),
          mediaId,
        },
      });
      const items = await tx.checklistRunItem.findMany({ where: { runId, checked: true }, select: { itemKey: true } });
      const total = (run.template.items as unknown[]).length;
      const complete = items.length >= total;
      await tx.checklistRun.update({
        where: { id: runId },
        data: complete ? { completedAt: run.completedAt ?? new Date(), completedById: run.completedById ?? actor.userId } : { completedAt: null, completedById: null },
      });
    });
    await this.notifyStore(run.businessId, run.storeId);
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: run.storeId }, select: { name: true } });
    const fresh = await this.prisma.checklistRun.findUniqueOrThrow({ where: { id: runId }, include: this.runInclude });
    return this.runDto(fresh, store.name, true);
  }

  // ───────────────────────────── Leave ─────────────────────────────

  private leaveInclude = {
    store: { select: { name: true } },
    user: { select: publicUserSelect },
    decidedBy: { select: publicUserSelect },
  } as const satisfies Prisma.LeaveRequestInclude;

  async listLeave(actor: Actor, query: ListLeaveQuery): Promise<LeaveDto[]> {
    const manage = await this.covered(actor, 'task.manage', query.businessId);
    const canManageAny = manage === null || manage.size > 0;
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        businessId: query.businessId,
        ...(query.storeId ? { storeId: query.storeId } : {}),
        ...(query.status !== 'ALL' ? { status: query.status } : {}),
        ...(query.mine || !canManageAny
          ? { userId: actor.userId }
          : manage
            ? { OR: [{ storeId: { in: [...manage] } }, { userId: actor.userId }] }
            : {}),
      },
      include: this.leaveInclude,
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      take: 300,
    });
    return rows.map((r) => {
      const canDecide = r.userId !== actor.userId && (manage === null || manage.has(r.storeId)) && r.status === 'PENDING';
      return {
        id: r.id,
        storeId: r.storeId,
        storeName: r.store.name,
        user: toPublicUser(r.user),
        type: r.type,
        startDate: dateKey(r.startDate),
        endDate: dateKey(r.endDate),
        days: Math.round((r.endDate.getTime() - r.startDate.getTime()) / DAY) + 1,
        reason: r.reason,
        status: r.status,
        decidedBy: r.decidedBy ? toPublicUser(r.decidedBy) : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
        canDecide,
        canCancel:
          r.userId === actor.userId &&
          (r.status === 'PENDING' || (r.status === 'APPROVED' && dateKey(r.startDate) > todayKey())),
      };
    });
  }

  async requestLeave(actor: Actor, request: CreateLeaveRequest): Promise<LeaveDto[]> {
    const store = await this.store(request.storeId);
    await this.authz.require(actor, 'task.work', { businessId: store.businessId, storeId: store.id });
    const start = localDay(request.startDate).date;
    const end = localDay(request.endDate).date;
    if (end.getTime() - start.getTime() > 90 * DAY) throw ApiError.validation('At most 90 days at a time.', 'endDate');
    const overlap = await this.prisma.leaveRequest.count({
      where: { userId: actor.userId, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: end }, endDate: { gte: start } },
    });
    if (overlap > 0) throw ApiError.conflict('You already asked for leave on some of these days.');
    await this.prisma.leaveRequest.create({
      data: {
        businessId: store.businessId,
        storeId: store.id,
        userId: actor.userId,
        type: request.type,
        startDate: start,
        endDate: end,
        reason: request.reason ?? null,
      },
    });
    await this.notifyStore(store.businessId, store.id);
    return this.listLeave(actor, { businessId: store.businessId, status: 'ALL', mine: true });
  }

  async decide(actor: Actor, id: string, request: DecideLeaveRequest): Promise<void> {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) throw ApiError.notFound('Leave request');
    await this.authz.require(actor, 'task.manage', { businessId: leave.businessId, storeId: leave.storeId });
    if (leave.userId === actor.userId) throw ApiError.forbidden('Someone else must approve your own leave.');
    const updated = await this.prisma.leaveRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: request.status, decidedById: actor.userId, decidedAt: new Date(), decisionNote: request.note ?? null },
    });
    if (updated.count === 0) throw ApiError.conflict('This request was already decided.');
    await this.notifyStore(leave.businessId, leave.storeId, [leave.userId]);
  }

  async cancelLeave(actor: Actor, id: string): Promise<void> {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave || leave.userId !== actor.userId) throw ApiError.notFound('Leave request');
    const updated = await this.prisma.leaveRequest.updateMany({
      where: {
        id,
        OR: [{ status: 'PENDING' }, { status: 'APPROVED', startDate: { gt: localDay(todayKey()).date } }],
      },
      data: { status: 'CANCELLED' },
    });
    if (updated.count === 0) throw ApiError.conflict('This leave can no longer be cancelled.');
    await this.notifyStore(leave.businessId, leave.storeId);
  }
}
