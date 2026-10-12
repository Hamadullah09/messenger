/**
 * Store operations, second part: attendance (check in / out with location), daily checklists
 * with photo proof, and leave requests.
 */
import { z } from 'zod';
import type { AttachmentDto, PublicUserDto } from './dto';
import { idSchema } from './schemas/common';

const text = (max: number) => z.string().trim().max(max);

// ── Attendance ──

export const checkInRequestSchema = z.object({
  storeId: idSchema,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().min(0).max(100_000).optional(),
  note: text(300).optional(),
});
export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

export const checkOutRequestSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export type CheckOutRequest = z.infer<typeof checkOutRequestSchema>;

export interface AttendanceRecordDto {
  id: string;
  storeId: string;
  storeName: string;
  user: PublicUserDto;
  checkInAt: string;
  checkOutAt: string | null;
  /** Metres from the store; null when the store or phone gave no location. */
  checkInDistance: number | null;
  checkOutDistance: number | null;
  /** Farther from the store than its allowed distance. */
  outside: boolean;
  shift: { id: string; startsAt: string; endsAt: string } | null;
  /** Minutes after the shift start (0 when on time). */
  lateMinutes: number;
  note: string | null;
}

export type AttendanceStatus =
  | 'ON_TIME'
  | 'LATE'
  | 'ABSENT'
  | 'NOT_YET'
  | 'ON_LEAVE'
  | 'NO_SHIFT';

/** One person on one day at a store: their shift and what happened. */
export interface AttendanceRowDto {
  user: PublicUserDto;
  storeId: string;
  storeName: string;
  shift: { id: string; startsAt: string; endsAt: string; title: string | null } | null;
  record: AttendanceRecordDto | null;
  status: AttendanceStatus;
}

export interface AttendanceDayDto {
  day: string;
  rows: AttendanceRowDto[];
  summary: { onTime: number; late: number; absent: number; notYet: number; onLeave: number; outside: number };
}

export interface MyAttendanceDto {
  /** Checked in and not yet out. */
  open: AttendanceRecordDto | null;
  /** Today's shifts for me. */
  shifts: Array<{ id: string; storeId: string; storeName: string; startsAt: string; endsAt: string }>;
  /** Stores I can check in at, with their location. */
  stores: Array<{ id: string; name: string; latitude: number | null; longitude: number | null; geofenceMeters: number }>;
  recent: AttendanceRecordDto[];
}

export const attendanceDayQuerySchema = z.object({
  businessId: idSchema,
  storeId: idSchema.optional(),
  /** YYYY-MM-DD (local day of the store). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type AttendanceDayQuery = z.infer<typeof attendanceDayQuerySchema>;

export const storeLocationRequestSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  geofenceMeters: z.number().int().min(20).max(5000).default(200),
});
export type StoreLocationRequest = z.infer<typeof storeLocationRequestSchema>;

// ── Checklists ──

export const checklistTemplateRequestSchema = z.object({
  businessId: idSchema,
  /** null = every store. */
  storeId: idSchema.nullable().optional(),
  name: text(80).min(1, 'Name the checklist'),
  items: z
    .array(
      z.object({
        key: text(40).optional(),
        label: text(160).min(1, 'Describe the check'),
        /** A photo is required to tick it. */
        photo: z.boolean().default(false),
      }),
    )
    .min(1, 'Add at least one check')
    .max(40),
  active: z.boolean().optional(),
});
export type ChecklistTemplateRequest = z.infer<typeof checklistTemplateRequestSchema>;

export interface ChecklistTemplateDto {
  id: string;
  businessId: string;
  storeId: string | null;
  storeName: string | null;
  name: string;
  items: Array<{ key: string; label: string; photo: boolean }>;
  active: boolean;
  canEdit: boolean;
}

export interface ChecklistRunDto {
  id: string;
  template: { id: string; name: string };
  storeId: string;
  storeName: string;
  day: string;
  items: Array<{
    key: string;
    label: string;
    photo: boolean;
    checked: boolean;
    checkedBy: PublicUserDto | null;
    checkedAt: string | null;
    note: string | null;
    media: AttachmentDto | null;
  }>;
  done: number;
  total: number;
  completedAt: string | null;
  completedBy: PublicUserDto | null;
  canWork: boolean;
}

export const checklistTickRequestSchema = z.object({
  itemKey: text(40).min(1),
  checked: z.boolean(),
  note: text(300).nullable().optional(),
  /** Photo proof uploaded with opsStoreId. */
  mediaId: idSchema.nullable().optional(),
});
export type ChecklistTickRequest = z.infer<typeof checklistTickRequestSchema>;

// ── Leave ──

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'UNPAID', 'OTHER'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const createLeaveRequestSchema = z
  .object({
    storeId: idSchema,
    type: z.enum(LEAVE_TYPES),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: text(500).optional(),
  })
  .refine((l) => l.endDate >= l.startDate, {
    message: 'The last day must be on or after the first day',
    path: ['endDate'],
  });
export type CreateLeaveRequest = z.infer<typeof createLeaveRequestSchema>;

export const decideLeaveRequestSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  note: text(300).optional(),
});
export type DecideLeaveRequest = z.infer<typeof decideLeaveRequestSchema>;

export interface LeaveDto {
  id: string;
  storeId: string;
  storeName: string;
  user: PublicUserDto;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  decidedBy: PublicUserDto | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  canDecide: boolean;
  canCancel: boolean;
}

export const listLeaveQuerySchema = z.object({
  businessId: idSchema,
  storeId: idSchema.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']).default('ALL'),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListLeaveQuery = z.infer<typeof listLeaveQuerySchema>;
