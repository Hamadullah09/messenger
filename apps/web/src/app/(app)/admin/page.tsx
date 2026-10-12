'use client';

import type {
  AdminUserDto,
  AuditLogDto,
  BusinessDto,
  MeDto,
  Page,
  StoreDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, ScrollText, Siren, Store, Trash2, UserCog, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { EmergencySettingsTab } from '@/components/emergency/emergency-settings';
import { BusinessCard, StoreCard } from '@/components/manage/cards';
import {
  assignableRoles,
  CreatePersonDialog,
  ManagePersonDialog,
  managesWholeBusiness,
} from '@/components/manage/people';
import {
  emptyPlaceForm,
  PlaceDetailsFields,
  PlaceLogo,
  placeLocation,
  placeRequest,
  type PlaceForm,
} from '@/components/manage/place-details';
import {
  AssignManagerDialog,
  BusinessDetailsDialog,
  StoreDialog,
} from '@/components/manage/places';
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
import { api, errorMessage } from '@/lib/api';
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
  const businessName = me.businesses.find((b) => b.id === businessId)?.name ?? '';
  // Super Admins manage every business: no single business in the title. On the per-business
  // tabs they still see which business they are looking at.
  const subtitle = platform
    ? tab !== 'businesses' && businessName
      ? `Showing ${businessName}. Choose another business in the Businesses tab.`
      : undefined
    : businessName
      ? `Manage ${businessName}`
      : undefined;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader title="Administration" subtitle={subtitle} />
        {me.security.mfaRequiredForAdmins && !me.session.mfaVerified && (
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
  const [editing, setEditing] = useState<BusinessDto | null>(null);
  // null: closed · '': ask which business · id: that business preselected.
  const [addingStore, setAddingStore] = useState<string | null>(null);
  const [addingAdmin, setAddingAdmin] = useState<BusinessDto | null>(null);
  const [deleting, setDeleting] = useState<BusinessDto | null>(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [details, setDetails] = useState<PlaceForm>(emptyPlaceForm());
  const [firstAdmin, setFirstAdmin] = useState({
    displayName: '',
    username: '',
    email: '',
    initialPassword: '',
  });
  const wantsAdmin = Object.values(firstAdmin).some((v) => v.trim());
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['admin-businesses'] });
    // The business switcher lists every business for platform admins.
    useAuth.getState().setMe(await api<MeDto>('/me'));
  };
  const create = useMutation({
    mutationFn: async () => {
      const business = await api<BusinessDto>('/businesses', {
        method: 'POST',
        body: { ...form, ...placeRequest(details) },
      });
      if (wantsAdmin) {
        await api(`/businesses/${business.id}/users`, {
          method: 'POST',
          body: {
            ...firstAdmin,
            username: firstAdmin.username.trim().toLowerCase(),
            roleKey: 'BUSINESS_ADMIN',
            storeIds: [],
            mustChangePassword: false,
          },
        });
      }
      return business;
    },
    onSuccess: () => {
      setCreating(false);
      setForm({ ...form, name: '', slug: '' });
      setDetails(emptyPlaceForm());
      setFirstAdmin({ displayName: '', username: '', email: '', initialPassword: '' });
      void refresh();
    },
    onError: () => void refresh(),
  });
  const status = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'suspend' | 'reactivate' }) =>
      api(`/businesses/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => refresh(),
  });
  const businesses = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={businesses.length === 0}
          onClick={() => setAddingStore('')}
          icon={<Store className="size-5" aria-hidden />}
        >
          Add store
        </Button>
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
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {businesses.map((b) => (
          <BusinessCard
            key={b.id}
            business={b}
            selected={selectedId === b.id}
            onManage={() => onManage(b.id)}
            onAddAdmin={() => setAddingAdmin(b)}
            onAddStore={() => setAddingStore(b.id)}
            onEdit={() => setEditing(b)}
            onSuspend={() => status.mutate({ id: b.id, action: 'suspend' })}
            onReactivate={() => status.mutate({ id: b.id, action: 'reactivate' })}
            onDelete={() => setDeleting(b)}
          />
        ))}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New business" wide>
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
          </div>
          <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <legend className="mb-1 font-bold">Business admin (recommended)</legend>
            <p className="text-sm text-muted sm:col-span-2">
              Every business should have its own admin. Leave these empty to add one later.
            </p>
            <TextField
              label="Full name"
              value={firstAdmin.displayName}
              onChange={(e) => setFirstAdmin({ ...firstAdmin, displayName: e.target.value })}
            />
            <TextField
              label="Username"
              hint="Used to sign in. No spaces."
              autoCapitalize="none"
              spellCheck={false}
              value={firstAdmin.username}
              onChange={(e) =>
                setFirstAdmin({ ...firstAdmin, username: e.target.value.replace(/\s/g, '') })
              }
            />
            <TextField
              label="Email"
              type="email"
              value={firstAdmin.email}
              onChange={(e) => setFirstAdmin({ ...firstAdmin, email: e.target.value })}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="new-password"
              value={firstAdmin.initialPassword}
              onChange={(e) => setFirstAdmin({ ...firstAdmin, initialPassword: e.target.value })}
            />
          </fieldset>
          <PlaceDetailsFields value={details} onChange={setDetails} />
          <p className="text-sm text-muted">
            You can add a logo and stores after the business is created.
          </p>
          <Button type="submit" busy={create.isPending}>
            Create business
          </Button>
        </form>
      </Dialog>
      {addingStore !== null && (
        <StoreDialog
          businessId={addingStore || undefined}
          businesses={businesses.filter((b) => b.status === 'ACTIVE')}
          onClose={() => setAddingStore(null)}
          onSaved={() => {
            setAddingStore(null);
            void client.invalidateQueries({ queryKey: ['stores'] });
            void refresh();
          }}
        />
      )}
      {addingAdmin && (
        <CreatePersonDialog
          businessId={addingAdmin.id}
          stores={[]}
          roles={['BUSINESS_ADMIN', 'BUSINESS_OWNER', 'BUSINESS_MANAGER']}
          title={`Add an admin to ${addingAdmin.name}`}
          onClose={() => setAddingAdmin(null)}
          onCreated={() => {
            setAddingAdmin(null);
            void refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteBusinessDialog
          business={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void refresh();
          }}
        />
      )}
      {editing && (
        <BusinessDetailsDialog
          business={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/** Deleting a business is permanent, so the name must be typed to confirm. */
function DeleteBusinessDialog({
  business,
  onClose,
  onDeleted,
}: {
  business: BusinessDto;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () => api(`/businesses/${business.id}`, { method: 'DELETE' }),
    onSuccess: onDeleted,
  });
  return (
    <Dialog open onClose={onClose} title={`Delete ${business.name}?`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          remove.mutate();
        }}
      >
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        <Alert tone="warning" title="This cannot be undone">
          {business.name}, its {business.storeCount} stores and its chats disappear from every list
          and become read-only history. Its {business.memberCount} people lose access; anyone who
          belongs to no other business is deactivated.
        </Alert>
        <TextField
          label={`Type “${business.name}” to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            busy={remove.isPending}
            disabled={typed.trim() !== business.name}
            icon={<Trash2 className="size-5" aria-hidden />}
          >
            Delete business
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StoresTab({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me)!;
  const platform = isPlatformAdmin(me);
  // Super Admins see every business, each in its own section; everyone else their business.
  const groups = me.businesses.filter((b) =>
    platform ? b.status !== 'ARCHIVED' : b.id === businessId,
  );
  const [dialog, setDialog] = useState<
    { kind: 'new'; businessId?: string } | { kind: 'edit'; store: StoreDto } | null
  >(null);
  const [managersOf, setManagersOf] = useState<StoreDto | null>(null);
  const [deleting, setDeleting] = useState<StoreDto | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['stores'] });
    void client.invalidateQueries({ queryKey: ['admin-businesses'] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api(`/stores/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });
  const storeBusinesses = groups.filter(
    (b) => b.status === 'ACTIVE' && hasPermission(me, 'store.create', b.id),
  );
  const totalStores = groups.reduce((n, b) => n + b.stores.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">
          {totalStores} {totalStores === 1 ? 'store' : 'stores'}
          {platform
            ? ` in ${groups.length} ${groups.length === 1 ? 'business' : 'businesses'}`
            : ''}
        </p>
        {storeBusinesses.length > 0 && (
          <Button
            onClick={() =>
              setDialog({ kind: 'new', businessId: platform ? undefined : businessId })
            }
            icon={<Plus className="size-5" aria-hidden />}
          >
            New store
          </Button>
        )}
      </div>

      {groups.map((b) => (
        <BusinessStoresSection
          key={b.id}
          businessId={b.id}
          name={b.name}
          canCreate={b.status === 'ACTIVE' && hasPermission(me, 'store.create', b.id)}
          canEdit={hasPermission(me, 'store.update', b.id)}
          canDelete={hasPermission(me, 'store.archive', b.id)}
          canAssign={managesWholeBusiness(me, b.id)}
          onAdd={() => setDialog({ kind: 'new', businessId: b.id })}
          onEdit={(store) => setDialog({ kind: 'edit', store })}
          onManagers={setManagersOf}
          onDelete={setDeleting}
        />
      ))}

      {dialog && (
        <StoreDialog
          businessId={dialog.kind === 'new' ? dialog.businessId : undefined}
          businesses={dialog.kind === 'new' ? storeBusinesses : undefined}
          store={dialog.kind === 'edit' ? dialog.store : undefined}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {managersOf && (
        <AssignManagerDialog
          businessId={managersOf.businessId}
          store={managersOf}
          onClose={() => setManagersOf(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name ?? 'store'}?`}
        message={
          <>
            {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
            <p>
              The store disappears from every list and its people leave it (their accounts stay).
              Its group chats become read-only history. This cannot be undone.
            </p>
          </>
        }
        confirmLabel="Delete store"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

/** One business with all its stores as cards. */
function BusinessStoresSection({
  businessId,
  name,
  canCreate,
  canEdit,
  canDelete,
  canAssign,
  onAdd,
  onEdit,
  onManagers,
  onDelete,
}: {
  businessId: string;
  name: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canAssign: boolean;
  onAdd: () => void;
  onEdit: (store: StoreDto) => void;
  onManagers: (store: StoreDto) => void;
  onDelete: (store: StoreDto) => void;
}) {
  const business = useQuery({
    queryKey: ['business', businessId],
    queryFn: () => api<BusinessDto>(`/businesses/${businessId}`),
  });
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const location = business.data ? placeLocation(business.data) : '';
  return (
    <section
      aria-label={`${name} stores`}
      className="rounded-3xl border border-line bg-surface-2/60 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <PlaceLogo name={name} logoUrl={business.data?.logoUrl ?? null} size={44} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-bold">{name}</h3>
          <p className="truncate text-sm text-muted">
            {stores.data
              ? `${stores.data.length} ${stores.data.length === 1 ? 'store' : 'stores'}`
              : '…'}
            {location ? ` · ${location}` : ''}
          </p>
        </div>
        {canCreate && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" aria-hidden />}
            onClick={onAdd}
          >
            Add store
          </Button>
        )}
      </header>
      {stores.isLoading && <Spinner label={`Loading ${name} stores`} />}
      {stores.isError && <Alert tone="error">{errorMessage(stores.error)}</Alert>}
      {stores.data?.length === 0 && (
        <button
          type="button"
          disabled={!canCreate}
          onClick={onAdd}
          className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line p-8 text-muted enabled:hover:border-brand/50 enabled:hover:text-brand"
        >
          <Store className="size-7" aria-hidden />
          <span className="font-semibold">
            No stores yet{canCreate ? ' — add the first one' : ''}
          </span>
        </button>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {stores.data?.map((s) => (
          <StoreCard
            key={s.id}
            store={s}
            onEdit={canEdit ? () => onEdit(s) : undefined}
            onManagers={canAssign ? () => onManagers(s) : undefined}
            onDelete={canDelete ? () => onDelete(s) : undefined}
          />
        ))}
      </div>
    </section>
  );
}

function PeopleTab({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [query, setQuery] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<AdminUserDto | null>(null);
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
  const full = managesWholeBusiness(me, businessId);
  const roles = assignableRoles(me, businessId);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['people', businessId] });
    void client.invalidateQueries({ queryKey: ['stores', businessId] });
  };
  // Store managers manage employees and security staff of their stores only.
  const canManage = (u: AdminUserDto) =>
    u.id !== me?.user.id &&
    (full || u.roles.every((r) => r.roleKey === 'EMPLOYEE' || r.roleKey === 'SECURITY'));

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
        {hasPermission(me, 'user.create', businessId) && roles.length > 0 && (
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
                {[...new Set(u.roles.map((r) => r.roleName))].join(', ') || 'No role'} ·{' '}
                {u.stores.map((s) => s.name).join(', ') || 'No store'}
              </p>
              {u.mfaEnabled !== null && (
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
            {canManage(u) && (
              <Button
                variant="secondary"
                onClick={() => setManaging(u)}
                icon={<UserCog className="size-5" aria-hidden />}
              >
                Manage
              </Button>
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
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
      {managing && (
        <ManagePersonDialog
          businessId={businessId}
          user={managing}
          stores={stores.data ?? []}
          roles={roles}
          full={full}
          onClose={() => setManaging(null)}
          onChanged={refresh}
        />
      )}
    </div>
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
