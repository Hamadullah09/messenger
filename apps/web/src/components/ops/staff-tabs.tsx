'use client';

import {
  LEAVE_TYPES,
  type AttendanceDayDto,
  type AttendanceRecordDto,
  type AttendanceStatus,
  type ChecklistRunDto,
  type ChecklistTemplateDto,
  type LeaveDto,
  type LeaveType,
  type MyAttendanceDto,
  type StoreDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  LogIn,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { coordinatesFromMapUrl } from '@/components/chat/attach-menu';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDay, formatTime } from '@/lib/format';
import { useMediaUrl } from '@/lib/media-store';
import { uploadFile } from '@/lib/uploads';

type StoreRef = { id: string; name: string };

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Current position (best effort: attendance still works without it). */
function getPosition(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!window.isSecureContext || !('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 30_000,
    });
  });
}

function hoursBetween(from: string, to: string | null): string {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_STYLE: Record<AttendanceStatus, { label: string; cls: string }> = {
  ON_TIME: { label: 'On time', cls: 'bg-success-soft text-success' },
  LATE: { label: 'Late', cls: 'bg-warning-surface text-warning' },
  ABSENT: { label: 'Absent', cls: 'bg-danger-surface text-danger' },
  NOT_YET: { label: 'Not started', cls: 'bg-surface-3 text-muted' },
  ON_LEAVE: { label: 'On leave', cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  NO_SHIFT: { label: 'No shift', cls: 'bg-surface-3 text-fg' },
};

// ───────────────────────────── Attendance ─────────────────────────────

export function AttendanceTab({
  businessId,
  storeId,
  stores,
  canManage,
}: {
  businessId: string;
  storeId: string;
  stores: StoreRef[];
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <MyAttendance businessId={businessId} />
      {canManage && <AttendanceBoard businessId={businessId} storeId={storeId} />}
      {canManage && <StoreLocations businessId={businessId} stores={stores} />}
    </div>
  );
}

function MyAttendance({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['attendance', 'me', businessId],
    queryFn: () => api<MyAttendanceDto>('/attendance/me', { query: { businessId } }),
    refetchInterval: 60_000,
  });
  const [storeId, setStoreId] = useState('');
  const [last, setLast] = useState<AttendanceRecordDto | null>(null);
  const act = useMutation({
    mutationFn: async (kind: 'in' | 'out') => {
      const pos = await getPosition();
      const point = pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) } : {};
      return kind === 'in'
        ? api<AttendanceRecordDto>('/attendance/check-in', {
            method: 'POST',
            body: { storeId: storeId || me.data?.shifts[0]?.storeId || me.data?.stores[0]?.id, ...point },
          })
        : api<AttendanceRecordDto>('/attendance/check-out', {
            method: 'POST',
            body: pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : {},
          });
    },
    onSuccess: (r) => {
      setLast(r);
      void client.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
  if (me.isPending) return <Spinner />;
  if (me.isError) return <Alert tone="error">{errorMessage(me.error)}</Alert>;
  const m = me.data;
  const selected = storeId || m.shifts[0]?.storeId || m.stores[0]?.id || '';
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <h2 className="mb-1 text-lg font-bold">My attendance</h2>
      <p className="mb-3 text-sm text-muted">
        {m.shifts.length > 0
          ? `Today: ${m.shifts.map((s) => `${s.storeName} ${formatTime(s.startsAt)}–${formatTime(s.endsAt)}`).join(', ')}`
          : 'No shift planned for you today.'}
      </p>
      {act.isError && <Alert tone="error">{errorMessage(act.error)}</Alert>}
      {last?.outside && (
        <Alert tone="warning" title="You seem to be away from the store">
          About {last.checkInDistance} m from {last.storeName}. Your manager will see this.
        </Alert>
      )}
      {m.open ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-success-soft text-success">
            <Clock className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Checked in at {m.open.storeName} · {formatTime(m.open.checkInAt)}
            </p>
            <p className="text-sm text-muted">
              Working {hoursBetween(m.open.checkInAt, null)}
              {m.open.lateMinutes > 0 ? ` · ${m.open.lateMinutes} min late` : ''}
            </p>
          </div>
          <Button size="lg" variant="danger" icon={<LogOut className="size-5" aria-hidden />} busy={act.isPending} onClick={() => act.mutate('out')}>
            Check out
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {m.stores.length > 1 && (
            <SelectField label="Store" value={selected} onChange={(e) => setStoreId(e.target.value)} className="min-w-52">
              {m.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
          )}
          <Button size="lg" icon={<LogIn className="size-5" aria-hidden />} busy={act.isPending} disabled={!selected} onClick={() => act.mutate('in')}>
            Check in
          </Button>
          <p className="text-sm text-muted">Your location is used once to confirm you are at the store.</p>
        </div>
      )}
      {m.recent.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer font-semibold">Recent days</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {m.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3">
                <span className="w-28 font-semibold">{formatDay(r.checkInAt)}</span>
                <span>
                  {r.storeName} · {formatTime(r.checkInAt)}–{r.checkOutAt ? formatTime(r.checkOutAt) : '…'} ({hoursBetween(r.checkInAt, r.checkOutAt)})
                </span>
                {r.lateMinutes > 0 && <span className="text-warning">{r.lateMinutes} min late</span>}
                {r.outside && <span className="text-danger">away from the store</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function AttendanceBoard({ businessId, storeId }: { businessId: string; storeId: string }) {
  const [day, setDay] = useState(todayInput());
  const board = useQuery({
    queryKey: ['attendance', 'day', businessId, storeId, day],
    queryFn: () => api<AttendanceDayDto>('/attendance/day', { query: { businessId, storeId: storeId || undefined, day } }),
    refetchInterval: 60_000,
  });
  const b = board.data;
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-bold">Who came in</h2>
        <TextField label="Day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      {board.isPending && <Spinner />}
      {board.isError && <Alert tone="error">{errorMessage(board.error)}</Alert>}
      {b && (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {(
              [
                ['On time', b.summary.onTime, 'ON_TIME'],
                ['Late', b.summary.late, 'LATE'],
                ['Absent', b.summary.absent, 'ABSENT'],
                ['Not started', b.summary.notYet, 'NOT_YET'],
                ['On leave', b.summary.onLeave, 'ON_LEAVE'],
              ] as const
            ).map(([label, n, key]) => (
              <span key={label} className={cx('rounded-full px-3 py-1 font-semibold', STATUS_STYLE[key].cls)}>
                {label}: {n}
              </span>
            ))}
            {b.summary.outside > 0 && (
              <span className="rounded-full bg-danger-surface px-3 py-1 font-semibold text-danger">Away from store: {b.summary.outside}</span>
            )}
          </div>
          {b.rows.length === 0 ? (
            <EmptyState icon={<Clock className="size-9" aria-hidden />} title="No shifts or check-ins this day">
              Plan shifts in the Shifts tab to see who is late or absent.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th className="py-2 font-semibold">Person</th>
                    <th className="py-2 font-semibold">Shift</th>
                    <th className="py-2 font-semibold">In</th>
                    <th className="py-2 font-semibold">Out</th>
                    <th className="py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, i) => (
                    <tr key={`${r.user.id}-${r.shift?.id ?? r.record?.id ?? i}`} className="border-b border-line/60">
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <Avatar name={r.user.displayName} size={28} />
                          <span>
                            <span className="block font-semibold">{r.user.displayName}</span>
                            <span className="block text-xs text-muted">{r.storeName}</span>
                          </span>
                        </span>
                      </td>
                      <td className="py-2">{r.shift ? `${formatTime(r.shift.startsAt)}–${formatTime(r.shift.endsAt)}` : '—'}</td>
                      <td className="py-2">
                        {r.record ? (
                          <>
                            {formatTime(r.record.checkInAt)}
                            {r.record.lateMinutes > 0 && <span className="block text-xs text-warning">{r.record.lateMinutes} min late</span>}
                            {r.record.checkInDistance !== null && (
                              <span className={cx('block text-xs', r.record.outside ? 'font-semibold text-danger' : 'text-muted')}>
                                {r.record.outside ? 'Away · ' : ''}
                                {r.record.checkInDistance} m from store
                              </span>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2">{r.record?.checkOutAt ? formatTime(r.record.checkOutAt) : r.record ? 'Working' : '—'}</td>
                      <td className="py-2">
                        <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', STATUS_STYLE[r.status].cls)}>{STATUS_STYLE[r.status].label}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StoreLocations({ businessId, stores }: { businessId: string; stores: StoreRef[] }) {
  const details = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const [editing, setEditing] = useState<StoreDto | null>(null);
  const list = (details.data ?? []).filter((s) => stores.some((x) => x.id === s.id));
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <h2 className="mb-1 text-lg font-bold">Store locations</h2>
      <p className="mb-3 text-sm text-muted">Check-ins farther than the allowed distance are marked “away from the store”.</p>
      <ul className="flex flex-col gap-2">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 p-3">
            <MapPin className={cx('size-5', s.latitude !== null ? 'text-success' : 'text-muted')} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{s.name}</span>
              <span className="block text-sm text-muted">
                {s.latitude !== null ? `${s.latitude.toFixed(5)}, ${s.longitude!.toFixed(5)} · within ${s.geofenceMeters} m` : 'Location not set'}
              </span>
            </span>
            <Button size="sm" variant="secondary" icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(s)}>
              Set
            </Button>
          </li>
        ))}
      </ul>
      {editing && <StoreLocationDialog store={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function StoreLocationDialog({ store, onClose }: { store: StoreDto; onClose: () => void }) {
  const client = useQueryClient();
  const fromLink = coordinatesFromMapUrl(store.mapUrl);
  const [lat, setLat] = useState(store.latitude?.toString() ?? fromLink?.lat.toString() ?? '');
  const [lng, setLng] = useState(store.longitude?.toString() ?? fromLink?.lng.toString() ?? '');
  const [radius, setRadius] = useState(store.geofenceMeters);
  const [locating, setLocating] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(`/stores/${store.id}/location`, {
        method: 'PUT',
        body: { latitude: lat ? Number(lat) : null, longitude: lng ? Number(lng) : null, geofenceMeters: radius },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['stores'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Location of ${store.name}`}>
      <div className="flex flex-col gap-4">
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <Button
          variant="secondary"
          icon={<MapPin className="size-5" aria-hidden />}
          busy={locating}
          onClick={() => {
            setLocating(true);
            void getPosition().then((p) => {
              setLocating(false);
              if (p) {
                setLat(p.coords.latitude.toFixed(6));
                setLng(p.coords.longitude.toFixed(6));
              }
            });
          }}
        >
          Use where I am now (stand inside the store)
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Latitude" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          <TextField label="Longitude" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
        <TextField
          label="Allowed distance (metres)"
          type="number"
          min={20}
          max={5000}
          value={radius}
          onChange={(e) => setRadius(Math.min(5000, Math.max(20, Number(e.target.value) || 200)))}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Checklists ─────────────────────────────

function Thumb({ mediaId }: { mediaId: string }) {
  const url = useMediaUrl(mediaId, 'thumbnail');
  const full = useMediaUrl(mediaId, 'original', false);
  return url.data ? (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        void full.refetch().then((r) => r.data && window.open(r.data.url, '_blank', 'noopener'));
      }}
      className="block size-14 overflow-hidden rounded-lg border border-line"
    >
      <img src={url.data.url} alt="Photo proof" className="h-full w-full object-cover" />
    </a>
  ) : (
    <span className="block size-14 animate-pulse rounded-lg bg-surface-3" />
  );
}

function RunCard({ run }: { run: ChecklistRunDto }) {
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoFor, setPhotoFor] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const tick = useMutation({
    mutationFn: (body: { itemKey: string; checked: boolean; mediaId?: string | null }) =>
      api<ChecklistRunDto>(`/checklists/runs/${run.id}/items`, { method: 'PUT', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['checklists'] }),
  });
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardCheck className="size-5 text-brand" aria-hidden />
        <h3 className="flex-1 font-bold">
          {run.template.name} · {run.storeName}
        </h3>
        <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', run.completedAt ? 'bg-success-soft text-success' : 'bg-surface-3 text-fg')}>
          {run.completedAt ? `Done ${formatTime(run.completedAt)}` : `${run.done}/${run.total}`}
        </span>
      </div>
      <span className="mt-2 block h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className={cx('block h-full rounded-full', run.completedAt ? 'bg-success' : 'bg-brand')} style={{ width: `${pct}%` }} />
      </span>
      {tick.isError && <div className="mt-2"><Alert tone="error">{errorMessage(tick.error)}</Alert></div>}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          const key = photoFor;
          if (!file || !key) return;
          setUploading(key);
          try {
            const media = await uploadFile(file, { opsStoreId: run.storeId }, file.type, () => undefined, new AbortController().signal);
            tick.mutate({ itemKey: key, checked: true, mediaId: media.id });
          } catch (error) {
            window.alert(errorMessage(error));
          } finally {
            setUploading(null);
          }
        }}
      />
      <ul className="mt-3 flex flex-col gap-2">
        {run.items.map((it) => (
          <li key={it.key} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-2.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={it.checked}
              aria-label={it.label}
              disabled={!run.canWork || tick.isPending || (it.photo && !it.media && !it.checked)}
              onClick={() => tick.mutate({ itemKey: it.key, checked: !it.checked })}
              className={cx(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 disabled:opacity-50',
                it.checked ? 'border-success bg-success text-white' : 'border-line-strong',
              )}
            >
              {it.checked && <Check className="size-4" strokeWidth={3} aria-hidden />}
            </button>
            <div className="min-w-0 flex-1">
              <p className={cx('font-medium', it.checked && 'text-muted line-through')}>{it.label}</p>
              <p className="text-xs text-muted">
                {it.checked && it.checkedBy ? `${it.checkedBy.displayName} · ${formatTime(it.checkedAt!)}` : it.photo ? 'Photo needed' : ''}
              </p>
            </div>
            {it.media && <Thumb mediaId={it.media.mediaId} />}
            {it.photo && run.canWork && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Camera className="size-4" aria-hidden />}
                busy={uploading === it.key}
                onClick={() => {
                  setPhotoFor(it.key);
                  fileRef.current?.click();
                }}
              >
                {it.media ? 'Retake' : 'Photo'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChecklistsTab({
  businessId,
  storeId,
  stores,
  canManage,
}: {
  businessId: string;
  storeId: string;
  stores: StoreRef[];
  canManage: boolean;
}) {
  const [day, setDay] = useState(todayInput());
  const [editing, setEditing] = useState<ChecklistTemplateDto | 'new' | null>(null);
  const runs = useQuery({
    queryKey: ['checklists', 'runs', businessId, storeId, day],
    queryFn: () => api<ChecklistRunDto[]>('/checklists/runs', { query: { businessId, storeId: storeId || undefined, day } }),
  });
  const templates = useQuery({
    queryKey: ['checklists', 'templates', businessId],
    queryFn: () => api<ChecklistTemplateDto[]>('/checklists/templates', { query: { businessId } }),
    enabled: canManage,
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <TextField label="Day" type="date" value={day} max={todayInput()} onChange={(e) => setDay(e.target.value)} />
        {canManage && (
          <Button className="ml-auto" variant="secondary" icon={<Plus className="size-5" aria-hidden />} onClick={() => setEditing('new')}>
            New checklist
          </Button>
        )}
      </div>
      {runs.isPending && <Spinner label="Loading checklists" />}
      {runs.isError && <Alert tone="error">{errorMessage(runs.error)}</Alert>}
      {runs.data?.length === 0 && (
        <EmptyState icon={<ClipboardCheck className="size-9" aria-hidden />} title={day === todayInput() ? 'No checklists yet' : 'No checklists that day'}>
          {canManage ? 'Create an opening or closing checklist; it then appears here every day.' : 'Your manager has not set up checklists yet.'}
        </EmptyState>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {runs.data?.map((r) => <RunCard key={r.id} run={r} />)}
      </div>
      {canManage && templates.data && templates.data.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Checklists</h2>
          <ul className="flex flex-col gap-2">
            {templates.data.map((t) => (
              <li key={t.id} className={cx('flex items-center gap-3 rounded-2xl border border-line bg-surface p-3', !t.active && 'opacity-60')}>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{t.name}</span>
                  <span className="block text-sm text-muted">
                    {t.storeName ?? 'Every store'} · {t.items.length} checks · {t.items.filter((i) => i.photo).length} with photo
                    {t.active ? '' : ' · switched off'}
                  </span>
                </span>
                {t.canEdit && (
                  <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {editing && (
        <TemplateDialog businessId={businessId} stores={stores} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function TemplateDialog({
  businessId,
  stores,
  template,
  onClose,
}: {
  businessId: string;
  stores: StoreRef[];
  template: ChecklistTemplateDto | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(template?.name ?? 'Opening checklist');
  const [storeId, setStoreId] = useState(template?.storeId ?? '');
  const [active, setActive] = useState(template?.active ?? true);
  const [items, setItems] = useState(
    template?.items ?? [
      { key: '', label: 'Lights, AC and music on', photo: false },
      { key: '', label: 'Shelves stocked and tidy', photo: true },
      { key: '', label: 'Cash float counted', photo: false },
      { key: '', label: 'Fridge temperature checked', photo: true },
    ],
  );
  const save = useMutation({
    mutationFn: () =>
      api<ChecklistTemplateDto[]>(template ? `/checklists/templates/${template.id}` : '/checklists/templates', {
        method: template ? 'PATCH' : 'POST',
        body: {
          businessId,
          storeId: storeId || null,
          name: name.trim(),
          active,
          items: items.filter((i) => i.label.trim()).map((i) => ({ ...(i.key ? { key: i.key } : {}), label: i.label.trim(), photo: i.photo })),
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['checklists'] });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/checklists/templates/${template!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['checklists'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={template ? 'Edit checklist' : 'New checklist'} wide>
      <div className="flex flex-col gap-4">
        {(save.isError || remove.isError) && <Alert tone="error">{errorMessage(save.error ?? remove.error)}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField label="Store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Every store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">Checks</legend>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={`Check ${i + 1}`}
                value={it.label}
                maxLength={160}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className="min-h-11 flex-1 rounded-xl border border-line-strong/70 bg-surface px-3"
              />
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={it.photo} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, photo: e.target.checked } : x)))} />
                Photo
              </label>
              <button type="button" aria-label={`Remove check ${i + 1}`} onClick={() => setItems(items.filter((_, j) => j !== i))} className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setItems([...items, { key: '', label: '', photo: false }])}>
            Add a check
          </Button>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
          In use (shows every day)
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          {template && (
            <Button variant="ghost" className="text-danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.isPending} disabled={!name.trim() || !items.some((i) => i.label.trim())} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Leave ─────────────────────────────

const LEAVE_LABEL: Record<LeaveType, string> = {
  ANNUAL: 'Annual leave',
  SICK: 'Sick leave',
  CASUAL: 'Casual leave',
  UNPAID: 'Unpaid leave',
  OTHER: 'Other',
};
const LEAVE_STATUS: Record<LeaveDto['status'], string> = {
  PENDING: 'bg-warning-surface text-warning',
  APPROVED: 'bg-success-soft text-success',
  REJECTED: 'bg-danger-surface text-danger',
  CANCELLED: 'bg-surface-3 text-muted',
};

export function LeaveTab({ businessId, stores }: { businessId: string; stores: StoreRef[] }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const leave = useQuery({
    queryKey: ['leave', businessId],
    queryFn: () => api<LeaveDto[]>('/leave', { query: { businessId, status: 'ALL' } }),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; status: 'APPROVED' | 'REJECTED' }) => api(`/leave/${v.id}/decide`, { method: 'POST', body: { status: v.status } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['leave'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/leave/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['leave'] }),
  });
  const pending = (leave.data ?? []).filter((l) => l.canDecide);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button icon={<Plus className="size-5" aria-hidden />} onClick={() => setAsking(true)}>
          Ask for leave
        </Button>
      </div>
      {(leave.isError || decide.isError || cancel.isError) && <Alert tone="error">{errorMessage(leave.error ?? decide.error ?? cancel.error)}</Alert>}
      {pending.length > 0 && (
        <section className="rounded-3xl border border-warning/40 bg-warning-surface p-4">
          <h2 className="mb-2 font-bold">Waiting for your answer ({pending.length})</h2>
          <ul className="flex flex-col gap-2">
            {pending.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-3">
                <Avatar name={l.user.displayName} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">
                    {l.user.displayName} · {LEAVE_LABEL[l.type]} · {l.days} day{l.days > 1 ? 's' : ''}
                  </span>
                  <span className="block text-sm text-muted">
                    {l.startDate}
                    {l.endDate !== l.startDate ? ` to ${l.endDate}` : ''} · {l.storeName}
                    {l.reason ? ` · “${l.reason}”` : ''}
                  </span>
                </span>
                <Button size="sm" icon={<CheckCircle2 className="size-4" aria-hidden />} busy={decide.isPending} onClick={() => decide.mutate({ id: l.id, status: 'APPROVED' })}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" icon={<XCircle className="size-4" aria-hidden />} onClick={() => decide.mutate({ id: l.id, status: 'REJECTED' })}>
                  Reject
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {leave.isPending && <Spinner />}
      {leave.data?.length === 0 && <EmptyState title="No leave requests" />}
      <ul className="flex flex-col gap-2">
        {leave.data
          ?.filter((l) => !l.canDecide)
          .map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {l.user.displayName} · {LEAVE_LABEL[l.type]} · {l.days} day{l.days > 1 ? 's' : ''}
                </span>
                <span className="block text-sm text-muted">
                  {l.startDate}
                  {l.endDate !== l.startDate ? ` to ${l.endDate}` : ''} · {l.storeName}
                  {l.decidedBy ? ` · ${l.status.toLowerCase()} by ${l.decidedBy.displayName}` : ''}
                </span>
              </span>
              <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', LEAVE_STATUS[l.status])}>
                {l.status === 'PENDING' ? 'Waiting' : l.status.charAt(0) + l.status.slice(1).toLowerCase()}
              </span>
              {l.canCancel && (
                <Button size="sm" variant="ghost" busy={cancel.isPending} onClick={() => cancel.mutate(l.id)}>
                  Cancel
                </Button>
              )}
            </li>
          ))}
      </ul>
      {asking && <LeaveDialog stores={stores} onClose={() => setAsking(false)} />}
    </div>
  );
}

function LeaveDialog({ stores, onClose }: { stores: StoreRef[]; onClose: () => void }) {
  const client = useQueryClient();
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [type, setType] = useState<LeaveType>('ANNUAL');
  const [start, setStart] = useState(todayInput());
  const [end, setEnd] = useState(todayInput());
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<LeaveDto[]>('/leave', {
        method: 'POST',
        body: { storeId, type, startDate: start, endDate: end, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['leave'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Ask for leave">
      <div className="flex flex-col gap-4">
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {stores.length > 1 && (
          <SelectField label="Store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Kind of leave" value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
          {LEAVE_TYPES.map((t) => (
            <option key={t} value={t}>
              {LEAVE_LABEL[t]}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="First day" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} />
          <TextField label="Last day" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <TextArea label="Reason (optional)" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.isPending} disabled={!storeId || end < start} onClick={() => save.mutate()}>
            Send request
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
