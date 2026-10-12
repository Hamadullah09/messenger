'use client';

import type { BusinessDto, StoreDto } from '@storeline/shared';
import {
  CirclePause,
  CirclePlay,
  MapPin,
  Pencil,
  Settings2,
  Store,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar, Button, cx } from '../ui';
import { ActionMenu } from './action-menu';
import { PlaceLogo, placeLocation } from './place-details';

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-success-soft text-success'
      : status === 'SUSPENDED'
        ? 'bg-warning-surface text-warning'
        : 'bg-surface-3 text-muted';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold',
        tone,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status === 'ACTIVE' ? 'Active' : status === 'SUSPENDED' ? 'Suspended' : 'Archived'}
    </span>
  );
}

function Stat({ Icon, value, label }: { Icon: LucideIcon; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-lg font-bold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-muted">{label}</span>
      </span>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
      {children}
    </p>
  );
}

/** Super Admin's view of one business: profile, numbers, stores, admins and actions. */
export function BusinessCard({
  business: b,
  selected,
  onManage,
  onAddAdmin,
  onAddStore,
  onEdit,
  onSuspend,
  onReactivate,
  onDelete,
}: {
  business: BusinessDto;
  selected: boolean;
  onManage: () => void;
  onAddAdmin: () => void;
  onAddStore: () => void;
  onEdit: () => void;
  onSuspend: () => void;
  onReactivate: () => void;
  onDelete: () => void;
}) {
  const location = placeLocation(b);
  return (
    <article
      aria-label={b.name}
      className={cx(
        'flex flex-col overflow-hidden rounded-3xl border bg-surface shadow-card transition-colors',
        selected ? 'border-brand/60' : 'border-line',
      )}
    >
      <div className="flex items-start gap-4 bg-gradient-to-br from-brand-soft/70 to-transparent p-5">
        <PlaceLogo name={b.name} logoUrl={b.logoUrl} size={60} className="shadow-sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-xl font-bold">{b.name}</h3>
            <StatusBadge status={b.status} />
          </div>
          <p className="mt-0.5 truncate text-sm text-muted">
            {b.slug}
            {location ? ` · ${location}` : ''}
          </p>
          {b.description && <p className="mt-1 line-clamp-2 text-sm">{b.description}</p>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-5">
        <Stat Icon={Store} value={b.storeCount} label="Stores" />
        <Stat Icon={Users} value={b.memberCount} label="People" />
        <Stat Icon={UserCog} value={b.admins.length} label="Admins" />
      </div>

      <div className="grid flex-1 gap-5 p-5 sm:grid-cols-2">
        <div className="min-w-0">
          <Label>Stores</Label>
          {b.stores.length === 0 ? (
            <button
              type="button"
              onClick={onAddStore}
              className="text-sm font-semibold text-brand hover:underline"
            >
              + Add the first store
            </button>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {b.stores.map((s) => (
                <li
                  key={s.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm"
                >
                  <Store className="size-3.5 shrink-0 text-brand" aria-hidden />
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 font-mono text-[0.7rem] text-muted">{s.code}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <Label>Admins</Label>
          {b.admins.length === 0 ? (
            <p className="text-sm font-semibold text-warning">No admin yet</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {b.admins.map((a) => (
                <li key={`${a.id}-${a.roleName}`} className="flex items-center gap-2.5">
                  <Avatar name={a.displayName} size={32} />
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-sm font-semibold">{a.displayName}</span>
                    <span className="block truncate text-xs text-muted">
                      @{a.username} · {a.roleName}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <Button
          size="sm"
          variant={selected ? 'primary' : 'secondary'}
          icon={<Settings2 className="size-4" aria-hidden />}
          onClick={onManage}
        >
          {selected ? 'Managing' : 'Manage'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<UserPlus className="size-4" aria-hidden />}
          onClick={onAddAdmin}
        >
          Add admin
        </Button>
        <span className="flex-1" />
        <ActionMenu
          label={`More actions for ${b.name}`}
          actions={[
            { label: 'Add store', Icon: Store, onSelect: onAddStore },
            { label: 'Edit details', Icon: Pencil, onSelect: onEdit },
            {
              label: 'Suspend',
              Icon: CirclePause,
              onSelect: onSuspend,
              hidden: b.status !== 'ACTIVE',
            },
            {
              label: 'Reactivate',
              Icon: CirclePlay,
              onSelect: onReactivate,
              hidden: b.status !== 'SUSPENDED',
            },
            { label: 'Delete business', Icon: Trash2, onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </article>
  );
}

/** One store: logo, code, location, managers and actions. */
export function StoreCard({
  store: s,
  onEdit,
  onManagers,
  onDelete,
}: {
  store: StoreDto;
  onEdit?: () => void;
  onManagers?: () => void;
  onDelete?: () => void;
}) {
  const location = placeLocation(s);
  return (
    <article
      aria-label={s.name}
      className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <PlaceLogo name={s.name} logoUrl={s.logoUrl} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold">{s.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono font-semibold">
              {s.code}
            </span>
            <span className="inline-flex items-center gap-1 text-muted">
              <Users className="size-3.5" aria-hidden /> {s.memberCount}
            </span>
          </div>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
        <MapPin className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{location || 'No address yet'}</span>
      </p>
      <div className="mt-3 flex items-center gap-2">
        {s.managers.length > 0 ? (
          <>
            <span className="flex -space-x-2">
              {s.managers.slice(0, 3).map((m) => (
                <span key={m.id} className="rounded-full ring-2 ring-surface">
                  <Avatar name={m.displayName} size={26} />
                </span>
              ))}
            </span>
            <span className="min-w-0 truncate text-sm">
              {s.managers.map((m) => m.displayName).join(', ')}
            </span>
          </>
        ) : (
          <span className="text-sm text-warning">No manager yet</span>
        )}
      </div>
      {(onEdit || onManagers || onDelete) && (
        <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
          {onEdit && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil className="size-4" aria-hidden />}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
          {onManagers && (
            <Button
              size="sm"
              variant="secondary"
              icon={<UserCog className="size-4" aria-hidden />}
              onClick={onManagers}
            >
              Managers
            </Button>
          )}
          <span className="flex-1" />
          {onDelete && (
            <ActionMenu
              label={`More actions for ${s.name}`}
              actions={[{ label: 'Delete store', Icon: Trash2, onSelect: onDelete, danger: true }]}
            />
          )}
        </div>
      )}
    </article>
  );
}
