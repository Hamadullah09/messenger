'use client';

import type { ShiftDto, StoreStaffDto, TaskDto, TaskPriority } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { AttendanceTab, ChecklistsTab, LeaveTab } from '@/components/ops/staff-tabs';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { formatDay, formatTime } from '@/lib/format';

const PRIORITY: Record<TaskPriority, { label: string; cls: string }> = {
  LOW: { label: 'Low', cls: 'bg-surface-3 text-muted' },
  NORMAL: { label: 'Normal', cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  HIGH: { label: 'High', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  URGENT: { label: 'Urgent', cls: 'bg-danger-surface text-danger' },
};

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function useStaff(storeId: string) {
  return useQuery({
    queryKey: ['store-staff', storeId],
    queryFn: () => api<StoreStaffDto>(`/stores/${storeId}/staff`),
    enabled: !!storeId,
  });
}

function TasksScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const TABS = ['tasks', 'shifts', 'attendance', 'checklists', 'leave'] as const;
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as (typeof TABS)[number])
    : 'tasks';
  const me = useAuth((s) => s.me)!;
  const businessId = useAuth((s) => s.activeBusinessId);
  const stores = me.businesses.find((b) => b.id === businessId)?.stores ?? [];
  const [storeId, setStoreId] = useState('');
  const canManage = hasPermission(me, 'task.manage', businessId);

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Store work"
          subtitle={
            canManage
              ? 'Give your stores to-dos and plan who works when.'
              : 'Your store’s to-dos and your shifts.'
          }
        />
        {!businessId ? (
          <EmptyState icon={<ClipboardList className="size-9" aria-hidden />} title="Choose a business" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-xl bg-surface-2 p-1" role="tablist" aria-label="Sections">
                {TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => router.replace(`/tasks?tab=${t}`)}
                    className={cx(
                      'min-h-10 rounded-lg px-4 text-sm font-semibold',
                      tab === t ? 'bg-surface shadow-card' : 'text-muted',
                    )}
                  >
                    {{ tasks: 'Tasks', shifts: 'Shifts', attendance: 'Attendance', checklists: 'Checklists', leave: 'Leave' }[t]}
                  </button>
                ))}
              </div>
              {stores.length > 1 && (
                <select
                  aria-label="Store"
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                  className="min-h-11 rounded-xl border border-line-strong/70 bg-surface px-3"
                >
                  <option value="">All my stores</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {tab === 'tasks' && (
              <TasksTab businessId={businessId} storeId={storeId} stores={stores} canManage={canManage} myId={me.user.id} />
            )}
            {tab === 'shifts' && (
              <ShiftsTab businessId={businessId} storeId={storeId} stores={stores} canManage={canManage} myId={me.user.id} />
            )}
            {tab === 'attendance' && (
              <AttendanceTab businessId={businessId} storeId={storeId} stores={stores} canManage={canManage} />
            )}
            {tab === 'checklists' && (
              <ChecklistsTab businessId={businessId} storeId={storeId} stores={stores} canManage={canManage} />
            )}
            {tab === 'leave' && <LeaveTab businessId={businessId} stores={stores} />}
          </>
        )}
      </div>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TasksScreen />
    </Suspense>
  );
}

type StoreRef = { id: string; name: string };

function TasksTab({
  businessId,
  storeId,
  stores,
  canManage,
  myId,
}: {
  businessId: string;
  storeId: string;
  stores: StoreRef[];
  canManage: boolean;
  myId: string;
}) {
  const client = useQueryClient();
  const [status, setStatus] = useState<'OPEN' | 'DONE' | 'ALL'>('OPEN');
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<TaskDto | 'new' | null>(null);
  const tasks = useQuery({
    queryKey: ['tasks', businessId, storeId, status, mine],
    queryFn: () =>
      api<TaskDto[]>('/tasks', {
        query: { businessId, storeId: storeId || undefined, status, mine: mine ? 'true' : undefined },
      }),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api<TaskDto>(`/tasks/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const now = Date.now();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Show">
          {(['OPEN', 'DONE', 'ALL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
              className={cx('min-h-10 rounded-lg px-3 text-sm font-semibold', status === s ? 'bg-surface shadow-card' : 'text-muted')}
            >
              {s === 'OPEN' ? 'To do' : s === 'DONE' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        <label className="flex min-h-11 items-center gap-2 px-2">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only mine
        </label>
        {canManage && (
          <Button className="ml-auto" icon={<Plus className="size-5" aria-hidden />} onClick={() => setEditing('new')}>
            New task
          </Button>
        )}
      </div>
      {(update.isError || remove.isError) && <Alert tone="error">{errorMessage(update.error ?? remove.error)}</Alert>}
      {tasks.isPending && <Spinner label="Loading tasks" />}
      {tasks.isError && <Alert tone="error">{errorMessage(tasks.error)}</Alert>}
      {tasks.data?.length === 0 && (
        <EmptyState icon={<ClipboardList className="size-9" aria-hidden />} title={status === 'DONE' ? 'Nothing done yet' : 'All clear'}>
          {canManage ? 'Add a task and give it to someone in the store.' : 'No tasks for you right now.'}
        </EmptyState>
      )}
      <ul className="flex flex-col gap-2">
        {tasks.data?.map((t) => {
          const overdue = t.status === 'OPEN' && t.dueAt && Date.parse(t.dueAt) < now;
          const done = t.status === 'DONE';
          return (
            <li key={t.id} className={cx('flex items-start gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card', done && 'opacity-70')}>
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                aria-label={done ? `Mark “${t.title}” as not done` : `Mark “${t.title}” as done`}
                disabled={!t.canComplete || update.isPending}
                onClick={() => update.mutate({ id: t.id, body: { status: done ? 'OPEN' : 'DONE' } })}
                className={cx(
                  'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40',
                  done ? 'border-success bg-success text-white' : 'border-line-strong hover:border-brand',
                )}
              >
                {done && <Check className="size-4" strokeWidth={3} aria-hidden />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx('font-semibold', done && 'line-through')}>{t.title}</span>
                  <span className={cx('rounded-full px-2 py-0.5 text-xs font-bold', PRIORITY[t.priority].cls)}>{PRIORITY[t.priority].label}</span>
                </div>
                {t.notes && <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted">{t.notes}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                  <span>{t.storeName}</span>
                  {t.dueAt && (
                    <span className={cx('flex items-center gap-1', overdue && 'font-semibold text-danger')}>
                      <CalendarClock className="size-4" aria-hidden /> {overdue ? 'Overdue · ' : 'Due '}
                      {formatDay(t.dueAt)}, {formatTime(t.dueAt)}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    {t.assignee ? (
                      <>
                        <Avatar name={t.assignee.displayName} size={18} />
                        {t.assignee.id === myId ? 'You' : t.assignee.displayName}
                      </>
                    ) : (
                      'Anyone in the store'
                    )}
                  </span>
                  {done && t.completedBy && <span>Done by {t.completedBy.id === myId ? 'you' : t.completedBy.displayName}</span>}
                </p>
              </div>
              {t.canEdit && (
                <div className="flex shrink-0 gap-1">
                  <button type="button" aria-label={`Edit ${t.title}`} onClick={() => setEditing(t)} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
                    <Pencil className="size-4" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Delete ${t.title}`} onClick={() => remove.mutate(t.id)} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger">
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          stores={stores}
          defaultStoreId={storeId || stores[0]?.id || ''}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TaskDialog({
  task,
  stores,
  defaultStoreId,
  onClose,
}: {
  task: TaskDto | null;
  stores: StoreRef[];
  defaultStoreId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [storeId, setStoreId] = useState(task?.storeId ?? defaultStoreId);
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'NORMAL');
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [assigneeId, setAssigneeId] = useState(task?.assignee?.id ?? '');
  const staff = useStaff(storeId);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        notes: notes.trim() || null,
        priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        assigneeId: assigneeId || null,
      };
      return task
        ? api<TaskDto>(`/tasks/${task.id}`, { method: 'PATCH', body })
        : api<TaskDto>('/tasks', { method: 'POST', body: { ...body, storeId } });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={task ? 'Edit task' : 'New task'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {!task && (
          <SelectField label="Store" required value={storeId} onChange={(e) => { setStoreId(e.target.value); setAssigneeId(''); }}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        )}
        <TextField label="Task" required maxLength={160} value={title} placeholder="e.g. Restock the drinks fridge" onChange={(e) => setTitle(e.target.value)} />
        <TextArea label="Details (optional)" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {(Object.keys(PRIORITY) as TaskPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY[p].label}
              </option>
            ))}
          </SelectField>
          <TextField label="Due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>
        <SelectField label="Give it to" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Anyone in the store</option>
          {staff.data?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </SelectField>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!title.trim() || !storeId}>
            {task ? 'Save' : 'Add task'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── Shifts ─────────────────────────────

function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7; // Monday first
  d.setDate(d.getDate() - day);
  return d;
}

function ShiftsTab({
  businessId,
  storeId,
  stores,
  canManage,
  myId,
}: {
  businessId: string;
  storeId: string;
  stores: StoreRef[];
  canManage: boolean;
  myId: string;
}) {
  const client = useQueryClient();
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [adding, setAdding] = useState<Date | null>(null);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(week.getFullYear(), week.getMonth(), week.getDate() + i)),
    [week],
  );
  const end = days[6] ? new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate() + 1) : week;
  const shifts = useQuery({
    queryKey: ['shifts', businessId, storeId, week.toISOString()],
    queryFn: () =>
      api<ShiftDto[]>('/shifts', {
        query: { businessId, storeId: storeId || undefined, from: week.toISOString(), to: end.toISOString() },
      }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/shifts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['shifts'] }),
  });
  const today = new Date().toDateString();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Previous week" onClick={() => setWeek(new Date(week.getTime() - 7 * 86_400_000))} className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-surface-2">
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <h2 className="min-w-52 text-center font-bold">
          {days[0]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} –{' '}
          {days[6]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
        </h2>
        <button type="button" aria-label="Next week" onClick={() => setWeek(new Date(week.getTime() + 7 * 86_400_000))} className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-surface-2">
          <ChevronRight className="size-5" aria-hidden />
        </button>
        <Button size="sm" variant="ghost" onClick={() => setWeek(startOfWeek(new Date()))}>
          This week
        </Button>
      </div>
      {(shifts.isError || remove.isError) && <Alert tone="error">{errorMessage(shifts.error ?? remove.error)}</Alert>}
      {shifts.isPending && <Spinner label="Loading shifts" />}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
        {days.map((day) => {
          const list = (shifts.data ?? []).filter((s) => new Date(s.startsAt).toDateString() === day.toDateString());
          return (
            <section
              key={day.toISOString()}
              className={cx(
                'flex min-h-32 flex-col gap-2 rounded-2xl border bg-surface p-2.5',
                day.toDateString() === today ? 'border-brand' : 'border-line',
              )}
            >
              <h3 className="flex items-center justify-between text-sm font-bold">
                <span>{day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span>
                {canManage && (
                  <button type="button" aria-label={`Add a shift on ${day.toLocaleDateString()}`} onClick={() => setAdding(day)} className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
                    <Plus className="size-4" aria-hidden />
                  </button>
                )}
              </h3>
              {list.map((s) => (
                <div
                  key={s.id}
                  className={cx(
                    'rounded-xl p-2 text-sm',
                    s.user.id === myId ? 'bg-brand-soft text-brand-strong' : 'bg-surface-2',
                  )}
                >
                  <p className="flex items-center gap-1 font-semibold">
                    <Clock className="size-3.5" aria-hidden />
                    {formatTime(s.startsAt)}–{formatTime(s.endsAt)}
                  </p>
                  <p className="truncate">{s.user.id === myId ? 'You' : s.user.displayName}</p>
                  <p className="truncate text-xs opacity-80">
                    {[s.title, !storeId ? s.storeName : null].filter(Boolean).join(' · ')}
                  </p>
                  {s.canEdit && (
                    <button type="button" onClick={() => remove.mutate(s.id)} className="mt-1 text-xs font-semibold text-danger">
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
      {adding && (
        <ShiftDialog
          day={adding}
          stores={stores}
          defaultStoreId={storeId || stores[0]?.id || ''}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}

function ShiftDialog({
  day,
  stores,
  defaultStoreId,
  onClose,
}: {
  day: Date;
  stores: StoreRef[];
  defaultStoreId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [userId, setUserId] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [title, setTitle] = useState('');
  const staff = useStaff(storeId);
  const at = (hhmm: string, nextDay = false) => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + (nextDay ? 1 : 0), h, m);
  };
  const startsAt = at(start);
  const endsAt = end <= start ? at(end, true) : at(end); // overnight shifts end the next day
  const save = useMutation({
    mutationFn: () =>
      api<ShiftDto>('/shifts', {
        method: 'POST',
        body: {
          storeId,
          userId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          ...(title.trim() ? { title: title.trim() } : {}),
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['shifts'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Shift on ${day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <SelectField label="Store" value={storeId} onChange={(e) => { setStoreId(e.target.value); setUserId(''); }}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Person" required value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose…</option>
          {staff.data?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Starts" type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Ends" type="time" required value={end} hint={end <= start ? 'Ends the next day' : undefined} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <TextField label="Role or note (optional)" maxLength={60} value={title} placeholder="e.g. Cashier, Morning" onChange={(e) => setTitle(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!userId || !storeId}>
            Add shift
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
