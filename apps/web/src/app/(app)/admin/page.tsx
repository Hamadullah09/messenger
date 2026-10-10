'use client';

import type { AdminUserDto, AuditLogDto, BusinessDto, Page, StoreDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Building2,
  KeyRound,
  LogOut,
  Plus,
  ScrollText,
  Siren,
  Store,
  UserX,
  Users,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { EmergencySettingsTab } from '@/components/emergency/emergency-settings';
import {
  Alert,
  Avatar,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '@/components/ui';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { hasPermission, isPlatformAdmin, useAuth } from '@/lib/auth-store';

type Tab = 'businesses' | 'stores' | 'people' | 'emergency' | 'audit';

const TAB_KEYS: Tab[] = ['businesses', 'stores', 'people', 'emergency', 'audit'];

function AdminScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useAuth((s) => s.me)!;
  const platform = isPlatformAdmin(me);
  const activeBusinessId = useAuth((s) => s.activeBusinessId);
  const [businessId, setBusinessId] = useState<string | null>(activeBusinessId);
  const requested = params.get('tab') as Tab | null;
  const tab: Tab =
    requested && TAB_KEYS.includes(requested) ? requested : platform ? 'businesses' : 'stores';
  const setTab = (next: Tab) => router.replace(`/admin?tab=${next}`);

  useEffect(() => {
    if (activeBusinessId) setBusinessId(activeBusinessId);
  }, [activeBusinessId]);

  const tabs: Array<{ key: Tab; label: string; Icon: typeof Store; show: boolean }> = [
    { key: 'businesses', label: 'Businesses', Icon: Building2, show: platform },
    { key: 'stores', label: 'Stores', Icon: Store, show: !!businessId },
    { key: 'people', label: 'People', Icon: Users, show: !!businessId },
    {
      key: 'emergency',
      label: 'Emergency',
      Icon: Siren,
      show: !!businessId && hasPermission(me, 'emergency_contact.manage', businessId),
    },
    {
      key: 'audit',
      label: 'Audit log',
      Icon: ScrollText,
      show: !!businessId && hasPermission(me, 'audit.read', businessId),
    },
  ];
  const businessName =
    me.businesses.find((b) => b.id === businessId)?.name ?? (platform ? 'Platform' : '');

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Administration"
          subtitle={businessName ? `Manage ${businessName}` : undefined}
        />
        {!me.session.mfaVerified && (
          <Alert tone="warning" title="Two-step verification needed">
            Most administrator actions need a session verified with two-step verification. Set it up
            in Settings, then sign in again.
          </Alert>
        )}
        <div
          role="tablist"
          aria-label="Administration sections"
          className="scroll-thin flex gap-1 overflow-x-auto border-b border-line"
        >
          {tabs
            .filter((t) => t.show)
            .map(({ key, label, Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cx(
                  'relative flex min-h-12 items-center gap-2 px-4 font-semibold whitespace-nowrap transition-colors',
                  tab === key ? 'text-brand' : 'text-muted hover:text-fg',
                )}
              >
                <Icon className="size-5" aria-hidden /> {label}
                {tab === key && (
                  <span
                    className="absolute right-3 bottom-0 left-3 h-0.5 rounded-full bg-brand"
                    aria-hidden
                  />
                )}
              </button>
            ))}
        </div>
        <div role="tabpanel">
          {tab === 'businesses' && (
            <BusinessesTab
              selectedId={businessId}
              onManage={(id) => {
                setBusinessId(id);
                setTab('stores');
              }}
            />
          )}
          {tab === 'stores' && businessId && <StoresTab businessId={businessId} />}
          {tab === 'people' && businessId && <PeopleTab businessId={businessId} />}
          {tab === 'emergency' && businessId && <EmergencySettingsTab businessId={businessId} />}
          {tab === 'audit' && businessId && <AuditTab businessId={businessId} />}
          {!businessId && tab !== 'businesses' && <EmptyState title="Choose a business first" />}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <AdminScreen />
    </Suspense>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-line bg-surface p-5 shadow-card">{children}</div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE' ? 'text-success' : status === 'SUSPENDED' ? 'text-warning' : 'text-muted';
  return (
    <span className={cx('rounded-full border border-current px-3 py-0.5 text-sm font-bold', tone)}>
      {status.toLowerCase()}
    </span>
  );
}

function BusinessesTab({
  selectedId,
  onManage,
}: {
  selectedId: string | null;
  onManage: (id: string) => void;
}) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['admin-businesses'],
    queryFn: () => api<Page<BusinessDto>>('/businesses', { query: { limit: 100 } }),
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const create = useMutation({
    mutationFn: () => api<BusinessDto>('/businesses', { method: 'POST', body: form }),
    onSuccess: () => {
      setCreating(false);
      setForm({ ...form, name: '', slug: '' });
      void client.invalidateQueries({ queryKey: ['admin-businesses'] });
    },
  });
  const status = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'suspend' | 'reactivate' }) =>
      api(`/businesses/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin-businesses'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)} icon={<Plus className="size-5" aria-hidden />}>
          New business
        </Button>
      </div>
      {status.isError && <Alert tone="error">{errorMessage(status.error)}</Alert>}
      {list.isLoading && <Spinner label="Loading businesses" />}
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      {list.data?.items.length === 0 && (
        <EmptyState title="No businesses yet">Create the first business to get started.</EmptyState>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.data?.items.map((b) => (
          <Card key={b.id}>
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-bold">{b.name}</p>
                  <p className="text-sm text-muted">
                    {b.slug} · {b.storeCount} stores · {b.memberCount} people
                  </p>
                </div>
                <StatusPill status={b.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedId === b.id ? 'primary' : 'secondary'}
                  onClick={() => onManage(b.id)}
                >
                  Manage
                </Button>
                {b.status === 'ACTIVE' ? (
                  <Button
                    variant="secondary"
                    onClick={() => status.mutate({ id: b.id, action: 'suspend' })}
                  >
                    Suspend
                  </Button>
                ) : b.status === 'SUSPENDED' ? (
                  <Button
                    variant="secondary"
                    onClick={() => status.mutate({ id: b.id, action: 'reactivate' })}
                  >
                    Reactivate
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New business">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
          <TextField
            label="Business name"
            required
            value={form.name}
            onChange={(e) =>
              setForm({
                ...form,
                name: e.target.value,
                slug: e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 48),
              })
            }
          />
          <TextField
            label="Short name"
            hint="Lowercase letters, numbers and dashes"
            required
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
          <TextField
            label="Time zone"
            value={form.timeZone}
            onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
          />
          <Button type="submit" busy={create.isPending}>
            Create business
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

function StoresTab({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<StoreDto | null>(null);
  const [form, setForm] = useState({ name: '', code: '', city: '' });
  const refresh = () => client.invalidateQueries({ queryKey: ['stores', businessId] });
  const create = useMutation({
    mutationFn: () =>
      api<StoreDto>(`/businesses/${businessId}/stores`, {
        method: 'POST',
        body: {
          name: form.name,
          code: form.code,
          address: form.city ? { city: form.city } : undefined,
        },
      }),
    onSuccess: () => {
      setCreating(false);
      setForm({ name: '', code: '', city: '' });
      void refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api(`/stores/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      setArchiving(null);
      void refresh();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)} icon={<Plus className="size-5" aria-hidden />}>
          New store
        </Button>
      </div>
      {stores.isLoading && <Spinner label="Loading stores" />}
      {stores.isError && <Alert tone="error">{errorMessage(stores.error)}</Alert>}
      {stores.data?.length === 0 && (
        <EmptyState title="No stores yet">Add your first store or branch.</EmptyState>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {stores.data?.map((s) => (
          <Card key={s.id}>
            <p className="text-lg font-bold">{s.name}</p>
            <p className="text-sm text-muted">
              Code {s.code} · {s.memberCount} people{s.address?.city ? ` · ${s.address.city}` : ''}
            </p>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => setArchiving(s)}
                icon={<Archive className="size-5" aria-hidden />}
              >
                Archive
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New store">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
          <TextField
            label="Store name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label="Store code"
            hint="Short code, for example A or NYC-01"
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
          <TextField
            label="City (optional)"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <Button type="submit" busy={create.isPending}>
            Create store
          </Button>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!archiving}
        title={`Archive ${archiving?.name ?? 'store'}?`}
        message={
          <>
            {archive.isError && <Alert tone="error">{errorMessage(archive.error)}</Alert>}
            <p>The store and its group chats become read-only. People keep their accounts.</p>
          </>
        }
        confirmLabel="Archive store"
        danger
        busy={archive.isPending}
        onClose={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate(archiving.id)}
      />
    </div>
  );
}

const ROLE_OPTIONS = [
  { key: 'EMPLOYEE', label: 'Employee' },
  { key: 'STORE_MANAGER', label: 'Store Manager' },
  { key: 'SECURITY', label: 'Security / Surveillance' },
  { key: 'BUSINESS_ADMIN', label: 'Business Admin' },
] as const;

function PeopleTab({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [query, setQuery] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{
    user: AdminUserDto;
    action: 'remove' | 'deactivate' | 'sessions';
  } | null>(null);
  const [editingStores, setEditingStores] = useState<AdminUserDto | null>(null);
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const people = useQuery({
    queryKey: ['people', businessId, query, storeFilter],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, {
        query: { query, storeId: storeFilter || undefined, limit: 100 },
      }),
  });
  const canManage = hasPermission(me, 'user.update', businessId);
  const refresh = () => client.invalidateQueries({ queryKey: ['people', businessId] });

  const act = useMutation({
    mutationFn: ({
      user,
      action,
    }: {
      user: AdminUserDto;
      action: 'remove' | 'deactivate' | 'sessions';
    }) => {
      if (action === 'remove')
        return api(`/businesses/${businessId}/users/${user.id}`, { method: 'DELETE' });
      if (action === 'deactivate') return api(`/users/${user.id}/deactivate`, { method: 'POST' });
      return api(`/businesses/${businessId}/users/${user.id}/sessions/revoke`, { method: 'POST' });
    },
    onSuccess: () => {
      setConfirm(null);
      void refresh();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          className="min-w-60 flex-1"
          label="Search people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectField
          label="Store"
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
        >
          <option value="">All stores</option>
          {stores.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        {hasPermission(me, 'user.create', businessId) && (
          <Button onClick={() => setCreating(true)} icon={<Plus className="size-5" aria-hidden />}>
            Add person
          </Button>
        )}
      </div>
      {people.isLoading && <Spinner label="Loading people" />}
      {people.isError && <Alert tone="error">{errorMessage(people.error)}</Alert>}
      {people.data?.items.length === 0 && <EmptyState title="Nobody found" />}
      <ul className="flex flex-col gap-2">
        {people.data?.items.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-3 rounded-3xl border border-line bg-surface p-4 shadow-card"
          >
            <Avatar name={u.displayName} size={48} />
            <div className="min-w-48 flex-1">
              <p className="font-bold">
                {u.displayName} <span className="font-normal text-muted">@{u.username}</span>
              </p>
              <p className="text-sm text-muted">
                {u.roles.map((r) => r.roleName).join(', ') || 'No role'} ·{' '}
                {u.stores.map((s) => s.name).join(', ') || 'No store'}
              </p>
              {canManage && (
                <p className="text-sm text-muted">
                  {u.mfaEnabled ? 'Two-step on' : 'Two-step off'}
                  {u.mustChangePassword ? ' · Has not chosen a password yet' : ''}
                  {u.lastActiveAt
                    ? ` · Last active ${new Date(u.lastActiveAt).toLocaleDateString()}`
                    : ''}
                </p>
              )}
            </div>
            <StatusPill status={u.status} />
            {canManage && u.id !== me?.user.id && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setEditingStores(u)}
                  icon={<Store className="size-5" aria-hidden />}
                >
                  Stores
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirm({ user: u, action: 'sessions' })}
                  icon={<LogOut className="size-5" aria-hidden />}
                >
                  Sign out everywhere
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirm({ user: u, action: 'remove' })}
                  icon={<UserX className="size-5" aria-hidden />}
                >
                  Remove
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {people.data?.nextCursor && (
        <p className="text-sm text-muted">
          Showing the first 100 people. Use search to narrow the list.
        </p>
      )}

      {creating && (
        <CreatePersonDialog
          businessId={businessId}
          stores={stores.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}
      {editingStores && (
        <EditStoresDialog
          businessId={businessId}
          user={editingStores}
          stores={stores.data ?? []}
          onClose={() => setEditingStores(null)}
          onSaved={() => {
            setEditingStores(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.action === 'remove'
            ? `Remove ${confirm.user.displayName}?`
            : confirm?.action === 'deactivate'
              ? `Deactivate ${confirm.user.displayName}?`
              : `Sign ${confirm?.user.displayName ?? ''} out everywhere?`
        }
        message={
          <>
            {act.isError && <Alert tone="error">{errorMessage(act.error)}</Alert>}
            <p>
              {confirm?.action === 'remove'
                ? 'They lose access to this business, its stores and its chats. Their past messages stay in the history.'
                : 'All their devices will be signed out immediately.'}
            </p>
          </>
        }
        confirmLabel={confirm?.action === 'remove' ? 'Remove from business' : 'Sign out everywhere'}
        danger
        busy={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && act.mutate(confirm)}
      />
    </div>
  );
}

function CreatePersonDialog({
  businessId,
  stores,
  onClose,
  onCreated,
}: {
  businessId: string;
  stores: StoreDto[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    initialPassword: '',
    roleKey: 'EMPLOYEE' as (typeof ROLE_OPTIONS)[number]['key'],
    email: '',
    phone: '',
  });
  const [storeIds, setStoreIds] = useState<Set<string>>(new Set());
  const create = useMutation({
    mutationFn: () =>
      api<AdminUserDto>(`/businesses/${businessId}/users`, {
        method: 'POST',
        body: {
          ...form,
          email: form.email || undefined,
          phone: form.phone || undefined,
          storeIds: form.roleKey === 'BUSINESS_ADMIN' ? [] : [...storeIds],
        },
      }),
    onSuccess: onCreated,
  });
  const fieldError = (path: string) =>
    create.error instanceof ApiRequestError
      ? create.error.details.find((d) => d.path === path)?.message
      : undefined;

  return (
    <Dialog open onClose={onClose} title="Add a person" wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Full name"
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            error={fieldError('displayName')}
          />
          <TextField
            label="Username"
            hint="Used to sign in"
            required
            autoCapitalize="none"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            error={fieldError('username')}
          />
          <TextField
            label="Temporary password"
            hint="At least 12 characters. They choose their own at first sign-in."
            required
            value={form.initialPassword}
            onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
            error={fieldError('initialPassword')}
          />
          <SelectField
            label="Role"
            value={form.roleKey}
            onChange={(e) => setForm({ ...form, roleKey: e.target.value as typeof form.roleKey })}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Email (private, optional)"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={fieldError('email')}
          />
          <TextField
            label="Phone (private, optional)"
            hint="International format, e.g. +14155550123"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            error={fieldError('phone')}
          />
        </div>
        {form.roleKey !== 'BUSINESS_ADMIN' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold">Works at</legend>
            {stores.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={storeIds.has(s.id)}
                  onChange={() =>
                    setStoreIds((c) => {
                      const n = new Set(c);
                      if (n.has(s.id)) n.delete(s.id);
                      else n.add(s.id);
                      return n;
                    })
                  }
                />
                {s.name}
              </label>
            ))}
          </fieldset>
        )}
        <p className="flex items-start gap-2 text-sm text-muted">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          Email and phone are never shown in chats. Only administrators with two-step verification
          can see them, and each view is logged.
        </p>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending}>
            Add person
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditStoresDialog({
  businessId,
  user,
  stores,
  onClose,
  onSaved,
}: {
  businessId: string;
  user: AdminUserDto;
  stores: StoreDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(new Set(user.stores.map((s) => s.id)));
  const save = useMutation({
    mutationFn: () =>
      api(`/businesses/${businessId}/users/${user.id}/stores`, {
        method: 'PUT',
        body: { storeIds: [...selected] },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog open onClose={onClose} title={`Stores for ${user.displayName}`}>
      <div className="flex flex-col gap-4">
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <Alert tone="warning">
          Removing a store also removes this person from that store’s group chats and store roles.
        </Alert>
        {stores.map((s) => (
          <label key={s.id} className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-5"
              checked={selected.has(s.id)}
              onChange={() =>
                setSelected((c) => {
                  const n = new Set(c);
                  if (n.has(s.id)) n.delete(s.id);
                  else n.add(s.id);
                  return n;
                })
              }
            />
            {s.name}
          </label>
        ))}
        <Button busy={save.isPending} onClick={() => save.mutate()}>
          Save stores
        </Button>
      </div>
    </Dialog>
  );
}

function AuditTab({ businessId }: { businessId: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const audit = useQuery({
    queryKey: ['audit', businessId, cursor],
    queryFn: () => api<Page<AuditLogDto>>('/audit', { query: { businessId, cursor, limit: 50 } }),
  });
  if (audit.isPending) return <Spinner label="Loading audit log" />;
  if (audit.isError) return <Alert tone="error">{errorMessage(audit.error)}</Alert>;
  return (
    <div className="flex flex-col gap-3">
      <div className="scroll-thin overflow-x-auto rounded-3xl border border-line bg-surface shadow-card">
        <table className="w-full text-left">
          <caption className="sr-only">Audit log</caption>
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className="p-3">
                When
              </th>
              <th scope="col" className="p-3">
                Who
              </th>
              <th scope="col" className="p-3">
                What
              </th>
              <th scope="col" className="p-3">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {audit.data.items.map((a) => (
              <tr key={a.id} className="border-t border-line">
                <td className="p-3 whitespace-nowrap">{new Date(a.occurredAt).toLocaleString()}</td>
                <td className="p-3">{a.actor?.displayName ?? 'System'}</td>
                <td className="p-3 font-mono text-sm">{a.action}</td>
                <td className="p-3">{a.outcome.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        {cursor && (
          <Button variant="secondary" onClick={() => setCursor(undefined)}>
            Newest
          </Button>
        )}
        {audit.data.nextCursor && (
          <Button variant="secondary" onClick={() => setCursor(audit.data.nextCursor ?? undefined)}>
            Older entries
          </Button>
        )}
      </div>
    </div>
  );
}
