'use client';

import type { StoreCustomerDto, StoreCustomerSummaryDto, StoreDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Megaphone, Pencil, Plus, Search, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, downloadFile, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { formatDay } from '@/lib/format';
import { CustomerCampaignsPanel } from './customer-campaigns';
import {
  Alert,
  Avatar,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  EmptyState,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '../ui';

/**
 * Store customers: the business's own customers (not SMA's customers), recorded with marketing
 * consent, and the campaigns sent to them.
 */
export function StoreCustomersTab({ businessId }: { businessId: string }) {
  const me = useAuth((s) => s.me);
  const [view, setView] = useState<'customers' | 'campaigns'>('customers');
  // Campaigns are a business-wide marketing tool (owners, admins, business managers).
  const canCampaign = !!me?.grants.some(
    (g) =>
      (g.scope.type === 'PLATFORM' ||
        (g.scope.type === 'BUSINESS' && g.scope.businessId === businessId)) &&
      g.permissions.includes('bulk_message.send') &&
      g.permissions.includes('customer.manage'),
  );
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
    enabled: canCampaign,
  });
  return (
    <div className="flex flex-col gap-4">
      {canCampaign && (
        <div
          role="tablist"
          aria-label="Store customers"
          className="flex w-fit gap-1 rounded-2xl bg-surface-2 p-1"
        >
          {(
            [
              ['customers', 'Customers', UserRound],
              ['campaigns', 'Campaigns', Megaphone],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cx(
                'inline-flex min-h-10 items-center gap-2 rounded-xl px-4 font-semibold',
                view === key ? 'bg-surface text-brand shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
      )}
      {view === 'campaigns' && canCampaign ? (
        <CustomerCampaignsPanel businessId={businessId} stores={stores.data ?? []} />
      ) : (
        <CustomersList businessId={businessId} />
      )}
    </div>
  );
}

function CustomersList({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [q, setQ] = useState('');
  const [storeId, setStoreId] = useState('');
  const [optIn, setOptIn] = useState<'' | 'true' | 'false'>('');
  const [editing, setEditing] = useState<StoreCustomerDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StoreCustomerDto | null>(null);
  const canManage = hasPermission(me, 'customer.manage', businessId);
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const customers = useQuery({
    queryKey: ['store-customers', businessId, q, storeId, optIn],
    queryFn: () =>
      api<{ items: StoreCustomerDto[]; summary: StoreCustomerSummaryDto }>(
        `/businesses/${businessId}/customers`,
        {
          query: {
            q: q.trim() || undefined,
            storeId: storeId || undefined,
            optIn: optIn || undefined,
          },
        },
      ),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['store-customers', businessId] });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/customers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const exporting = useMutation({
    mutationFn: () =>
      downloadFile(`/businesses/${businessId}/customers-export.csv`, 'store-customers.csv'),
  });
  const summary = customers.data?.summary;

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title="Your store customers (not SMA customers)">
        Record the people who shop at your stores. Customers who agree to marketing can be exported
        for campaigns (SMS, email or WhatsApp tools). Only record people who know and agree.
      </Alert>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">Customers</p>
          <p className="text-2xl font-bold tabular-nums">{summary?.total ?? '…'}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Megaphone className="size-4" aria-hidden /> Agreed to marketing
          </p>
          <p className="text-2xl font-bold text-success tabular-nums">{summary?.optedIn ?? '…'}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="relative min-w-60 flex-1">
          <span className="mb-1.5 block font-semibold">Search</span>
          <Search
            className="pointer-events-none absolute bottom-3.5 left-3 size-5 text-muted"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, phone, email, city or tag"
            className="min-h-12 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-10"
          />
        </label>
        <SelectField label="Store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          <option value="">All stores</option>
          {stores.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Marketing"
          value={optIn}
          onChange={(e) => setOptIn(e.target.value as typeof optIn)}
        >
          <option value="">Everyone</option>
          <option value="true">Agreed to marketing</option>
          <option value="false">Not agreed</option>
        </SelectField>
        {canManage && (
          <>
            <Button
              variant="secondary"
              busy={exporting.isPending}
              disabled={!summary?.optedIn}
              icon={<Download className="size-5" aria-hidden />}
              onClick={() => exporting.mutate()}
            >
              Export for campaign
            </Button>
            <Button
              onClick={() => setEditing('new')}
              icon={<Plus className="size-5" aria-hidden />}
            >
              Add customer
            </Button>
          </>
        )}
      </div>
      {exporting.isError && <Alert tone="error">{errorMessage(exporting.error)}</Alert>}
      {customers.isLoading && <Spinner label="Loading customers" />}
      {customers.isError && <Alert tone="error">{errorMessage(customers.error)}</Alert>}
      {customers.data?.items.length === 0 && (
        <EmptyState icon={<UserRound className="size-9" aria-hidden />} title="No customers yet">
          {canManage ? 'Add your first store customer.' : 'Nothing to show.'}
        </EmptyState>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {customers.data?.items.map((c) => (
          <li
            key={c.id}
            className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card"
          >
            <div className="flex items-start gap-3">
              <Avatar name={c.name} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{c.name}</p>
                <p className="truncate text-sm text-muted">
                  {[c.phone, c.email].filter(Boolean).join(' · ')}
                </p>
              </div>
              <span
                className={cx(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-bold',
                  c.marketingOptIn ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted',
                )}
              >
                {c.marketingOptIn ? 'Marketing OK' : 'No marketing'}
              </span>
            </div>
            <p className="text-sm text-muted">
              {[c.store?.name, c.city].filter(Boolean).join(' · ') || 'No store'}
              {' · added '}
              {formatDay(c.createdAt)}
              {c.addedBy ? ` by ${c.addedBy}` : ''}
            </p>
            {c.tags.length > 0 && (
              <ul className="flex flex-wrap gap-1">
                {c.tags.map((t) => (
                  <li
                    key={t}
                    className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-semibold"
                  >
                    #{t}
                  </li>
                ))}
              </ul>
            )}
            {c.notes && <p className="line-clamp-2 text-sm">{c.notes}</p>}
            {canManage && (
              <div className="mt-auto flex gap-2 border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Pencil className="size-4" aria-hidden />}
                  onClick={() => setEditing(c)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  icon={<Trash2 className="size-4" aria-hidden />}
                  onClick={() => setDeleting(c)}
                >
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <CustomerDialog
          businessId={businessId}
          stores={stores.data ?? []}
          customer={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name ?? 'customer'}?`}
        message="Their details are erased and they are no longer exported for campaigns."
        confirmLabel="Delete customer"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function CustomerDialog({
  businessId,
  stores,
  customer,
  onClose,
  onSaved,
}: {
  businessId: string;
  stores: StoreDto[];
  customer?: StoreCustomerDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    city: customer?.city ?? '',
    storeId: customer?.store?.id ?? (stores.length === 1 ? stores[0]!.id : ''),
    tags: customer?.tags.join(', ') ?? '',
    notes: customer?.notes ?? '',
    marketingOptIn: customer?.marketingOptIn ?? false,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        city: form.city.trim() || null,
        storeId: form.storeId || null,
        notes: form.notes.trim() || null,
        tags: form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        marketingOptIn: form.marketingOptIn,
      };
      return customer
        ? api(`/customers/${customer.id}`, { method: 'PATCH', body })
        : api(`/businesses/${businessId}/customers`, { method: 'POST', body });
    },
    onSuccess: onSaved,
  });
  const err = (path: string) =>
    save.error instanceof ApiRequestError
      ? save.error.details.find((d) => d.path === path)?.message
      : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={customer ? `Edit ${customer.name}` : 'Add a store customer'}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            error={err('name')}
          />
          <SelectField
            label="Store"
            value={form.storeId}
            onChange={(e) => set({ storeId: e.target.value })}
          >
            <option value="">No particular store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Phone"
            type="tel"
            hint="International format, e.g. +923001234567"
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
            error={err('phone')}
          />
          <TextField
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            error={err('email')}
          />
          <TextField
            label="City"
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
          />
          <TextField
            label="Tags (optional)"
            hint="Comma separated, e.g. vip, wholesale"
            value={form.tags}
            onChange={(e) => set({ tags: e.target.value })}
          />
        </div>
        <TextArea
          label="Notes (optional)"
          rows={2}
          maxLength={1000}
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
        <label className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4">
          <input
            type="checkbox"
            className="mt-1 size-5"
            checked={form.marketingOptIn}
            onChange={(e) => set({ marketingOptIn: e.target.checked })}
          />
          <span>
            <span className="block font-semibold">The customer agreed to receive marketing</span>
            <span className="text-sm text-muted">
              Only tick this if they said yes. Only these customers are exported for campaigns.
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending}>
            {customer ? 'Save customer' : 'Add customer'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
