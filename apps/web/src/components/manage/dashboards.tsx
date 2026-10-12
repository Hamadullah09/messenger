'use client';

import {
  SYSTEM_ROLE_ORDER,
  type AdminUserDto,
  type BusinessDto,
  type BusinessGroupDto,
  type MeDto,
  type Page,
  type StoreDto,
  type SystemRoleKey,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Store, UserCog, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { formatRelativeShort } from '@/lib/format';
import { NewGroupDialog } from '../chat/dialogs';
import { Alert, Avatar, Button, Card, ConfirmDialog, cx, EmptyState, Spinner } from '../ui';
import { assignableRoles, CreatePersonDialog, ManagePersonDialog, ROLE_LABELS } from './people';
import { PlaceLogo, placeLocation, PlaceSummary } from './place-details';
import { StoreCard } from './cards';
import { AssignManagerDialog, BusinessDetailsDialog, StoreDialog } from './places';

export type DashboardKind =
  { kind: 'business'; role: SystemRoleKey } | { kind: 'store'; storeIds: string[] } | null;

/** Which management dashboard the signed-in person gets in this business, if any. */
export function dashboardKind(me: MeDto | null, businessId: string | null): DashboardKind {
  if (!me || !businessId) return null;
  const here = me.grants.filter((g) => g.scope.businessId === businessId);
  const businessRoles = here
    .filter((g) => g.scope.type === 'BUSINESS' && g.permissions.includes('store.read'))
    .map((g) => g.roleKey as SystemRoleKey)
    .filter((k) => SYSTEM_ROLE_ORDER.includes(k))
    .sort((a, b) => SYSTEM_ROLE_ORDER.indexOf(a) - SYSTEM_ROLE_ORDER.indexOf(b));
  if (businessRoles[0] && businessRoles[0] !== 'CUSTOMER')
    return { kind: 'business', role: businessRoles[0] };
  const storeIds = here
    .filter((g) => g.roleKey === 'STORE_MANAGER' && g.scope.storeId)
    .map((g) => g.scope.storeId!);
  return storeIds.length > 0 ? { kind: 'store', storeIds } : null;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cx(
        'rounded-full border border-current px-2.5 py-0.5 text-xs font-bold',
        status === 'ACTIVE' ? 'text-success' : 'text-muted',
      )}
    >
      {status === 'ACTIVE' ? 'active' : 'deactivated'}
    </span>
  );
}

/** Store managers: their stores, staff, and adding or deactivating staff. */
export function StoreManagerDashboard({
  businessId,
  storeIds,
}: {
  businessId: string;
  storeIds: string[];
}) {
  const me = useAuth((s) => s.me);
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const mine = (stores.data ?? []).filter((s) => storeIds.includes(s.id));
  return (
    <section aria-labelledby="manager-title" className="flex flex-col gap-4">
      <div>
        <h2 id="manager-title" className="text-2xl font-bold">
          Store manager dashboard
        </h2>
        <p className="text-muted">
          {mine.length === 1 ? 'Your store' : `Your ${mine.length} stores`}: add staff, set
          passwords and deactivate people who leave.
        </p>
      </div>
      {stores.isLoading && <Spinner label="Loading your stores" />}
      {stores.isError && <Alert tone="error">{errorMessage(stores.error)}</Alert>}
      {mine.map((store) => (
        <StoreStaffCard
          key={store.id}
          businessId={businessId}
          store={store}
          stores={mine}
          roles={assignableRoles(me, businessId)}
        />
      ))}
    </section>
  );
}

function StoreStaffCard({
  businessId,
  store,
  stores,
  roles,
}: {
  businessId: string;
  store: StoreDto;
  stores: StoreDto[];
  roles: SystemRoleKey[];
}) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<AdminUserDto | null>(null);
  const people = useQuery({
    queryKey: ['people', businessId, '', store.id],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, {
        query: { storeId: store.id, limit: 100 },
      }),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['people', businessId] });
    void client.invalidateQueries({ queryKey: ['stores', businessId] });
  };
  const staff = people.data?.items ?? [];
  return (
    <Card aria-label={store.name}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PlaceLogo name={store.name} logoUrl={store.logoUrl} size={52} />
        <div className="min-w-40 flex-1">
          <h3 className="text-xl font-bold">{store.name}</h3>
          <p className="text-sm text-muted">
            Code {store.code} · {store.memberCount} people
            {placeLocation(store) ? ` · ${placeLocation(store)}` : ''}
          </p>
        </div>
        <Button onClick={() => setAdding(true)} icon={<UserPlus className="size-5" aria-hidden />}>
          Add staff
        </Button>
      </div>
      {people.isLoading && <Spinner label="Loading staff" />}
      {people.isError && <Alert tone="error">{errorMessage(people.error)}</Alert>}
      <ul className="divide-y divide-line">
        {staff.map((u) => {
          const canManage =
            u.id !== me?.user.id &&
            u.roles.every((r) => r.roleKey === 'EMPLOYEE' || r.roleKey === 'SECURITY');
          return (
            <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
              <Avatar name={u.displayName} size={40} />
              <span className="min-w-40 flex-1">
                <span className="block font-semibold">
                  {u.displayName} <span className="font-normal text-muted">@{u.username}</span>
                </span>
                <span className="text-sm text-muted">
                  {u.roles.map((r) => r.roleName).join(', ') || 'No role'}
                </span>
              </span>
              <StatusPill status={u.status} />
              {canManage && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<UserCog className="size-4" aria-hidden />}
                  onClick={() => setManaging(u)}
                >
                  Manage
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {adding && (
        <CreatePersonDialog
          businessId={businessId}
          stores={stores}
          roles={roles}
          defaultStoreId={store.id}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {managing && (
        <ManagePersonDialog
          businessId={businessId}
          user={managing}
          stores={stores}
          roles={roles}
          full={false}
          onClose={() => setManaging(null)}
          onChanged={refresh}
        />
      )}
    </Card>
  );
}

const DASHBOARD_TITLES: Partial<Record<SystemRoleKey, string>> = {
  BUSINESS_OWNER: 'Business owner dashboard',
  BUSINESS_ADMIN: 'Business admin dashboard',
  BUSINESS_MANAGER: 'Business manager dashboard',
};

/**
 * Owners, admins and business managers: the business profile, every store with its managers,
 * and the business's groups. Business managers see the profile but cannot edit it.
 */
export function BusinessDashboard({
  businessId,
  role,
}: {
  businessId: string;
  role: SystemRoleKey;
}) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [editingBusiness, setEditingBusiness] = useState(false);
  const [storeDialog, setStoreDialog] = useState<StoreDto | 'new' | null>(null);
  const [managersOf, setManagersOf] = useState<StoreDto | null>(null);
  const [deleting, setDeleting] = useState<StoreDto | null>(null);
  const removeStore = useMutation({
    mutationFn: (id: string) => api(`/stores/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void client.invalidateQueries({ queryKey: ['stores', businessId] });
      void client.invalidateQueries({ queryKey: ['business', businessId] });
    },
  });
  const business = useQuery({
    queryKey: ['business', businessId],
    queryFn: () => api<BusinessDto>(`/businesses/${businessId}`),
  });
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const canEditBusiness = hasPermission(me, 'business.update', businessId);
  const canAddStore = hasPermission(me, 'store.create', businessId);
  const canAssign = hasPermission(me, 'user.update', businessId);
  const refreshStores = () => client.invalidateQueries({ queryKey: ['stores', businessId] });

  return (
    <section aria-labelledby="business-title" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="business-title" className="text-2xl font-bold">
            {DASHBOARD_TITLES[role] ?? 'Business dashboard'}
          </h2>
          <p className="text-muted">
            {ROLE_LABELS[role]} of {business.data?.name ?? 'your business'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin?tab=people"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-strong/60 bg-surface px-4 font-semibold hover:bg-surface-2"
          >
            <Users className="size-5" aria-hidden /> People
          </Link>
          {canAddStore && (
            <Button
              onClick={() => setStoreDialog('new')}
              icon={<Plus className="size-5" aria-hidden />}
            >
              Add store
            </Button>
          )}
        </div>
      </div>

      {business.data && (
        <Card aria-label="Business profile">
          <div className="flex flex-wrap items-start gap-4">
            <PlaceLogo name={business.data.name} logoUrl={business.data.logoUrl} size={72} />
            <div className="min-w-56 flex-1">
              <h3 className="text-xl font-bold">{business.data.name}</h3>
              <p className="mb-2 text-sm text-muted">
                {business.data.storeCount} stores · {business.data.memberCount} people
              </p>
              <PlaceSummary place={business.data} />
            </div>
            {canEditBusiness && (
              <Button
                variant="secondary"
                icon={<Pencil className="size-5" aria-hidden />}
                onClick={() => setEditingBusiness(true)}
              >
                Edit details
              </Button>
            )}
          </div>
        </Card>
      )}

      <div>
        <h3 className="mb-3 text-xl font-bold">Stores</h3>
        {stores.isLoading && <Spinner label="Loading stores" />}
        {stores.data?.length === 0 && (
          <EmptyState icon={<Store className="size-9" aria-hidden />} title="No stores yet">
            Add your first store or branch.
          </EmptyState>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {stores.data?.map((s) => (
            <StoreCard
              key={s.id}
              store={s}
              onEdit={
                hasPermission(me, 'store.update', businessId) ? () => setStoreDialog(s) : undefined
              }
              onManagers={canAssign ? () => setManagersOf(s) : undefined}
              onDelete={
                hasPermission(me, 'store.archive', businessId) ? () => setDeleting(s) : undefined
              }
            />
          ))}
        </div>
      </div>

      <GroupsCard businessId={businessId} />

      {editingBusiness && business.data && (
        <BusinessDetailsDialog
          business={business.data}
          onClose={() => setEditingBusiness(false)}
          onSaved={(next) => {
            client.setQueryData(['business', businessId], next);
            void client.invalidateQueries({ queryKey: ['business', businessId] });
            setEditingBusiness(false);
          }}
        />
      )}
      {storeDialog && (
        <StoreDialog
          businessId={businessId}
          businesses={
            storeDialog === 'new'
              ? (me?.businesses ?? []).filter(
                  (b) => b.status === 'ACTIVE' && hasPermission(me, 'store.create', b.id),
                )
              : undefined
          }
          store={storeDialog === 'new' ? undefined : storeDialog}
          onClose={() => {
            setStoreDialog(null);
            void refreshStores();
          }}
          onSaved={() => {
            setStoreDialog(null);
            void refreshStores();
            void client.invalidateQueries({ queryKey: ['business', businessId] });
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name ?? 'store'}?`}
        message={
          <>
            {removeStore.isError && <Alert tone="error">{errorMessage(removeStore.error)}</Alert>}
            <p>
              The store disappears from every list and its people leave it (their accounts stay).
              Its group chats become read-only history. This cannot be undone.
            </p>
          </>
        }
        confirmLabel="Delete store"
        danger
        busy={removeStore.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && removeStore.mutate(deleting.id)}
      />
      {managersOf && (
        <AssignManagerDialog
          businessId={businessId}
          store={managersOf}
          onClose={() => setManagersOf(null)}
          onSaved={() => void refreshStores()}
        />
      )}
    </section>
  );
}

/** The business's groups. Owners and admins can join any group to read and post in it. */
function GroupsCard({ businessId }: { businessId: string }) {
  const router = useRouter();
  const me = useAuth((s) => s.me);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const groups = useQuery({
    queryKey: ['business-groups', businessId],
    queryFn: () => api<BusinessGroupDto[]>(`/businesses/${businessId}/groups`),
  });
  const join = useMutation({
    mutationFn: (id: string) =>
      api(`/conversations/${id}/members`, { method: 'POST', body: { userIds: [me!.user.id] } }),
    onSuccess: (_, id) => {
      void client.invalidateQueries({ queryKey: ['business-groups', businessId] });
      void client.invalidateQueries({ queryKey: ['conversations'] });
      router.push(`/chats?c=${id}`);
    },
  });
  return (
    <Card aria-labelledby="groups-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="groups-title" className="text-xl font-bold">
          Group chats
        </h3>
        {hasPermission(me, 'group.create', businessId) && (
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            icon={<Plus className="size-4" aria-hidden />}
          >
            New group
          </Button>
        )}
      </div>
      {groups.isLoading && <Spinner label="Loading groups" />}
      {groups.isError && <Alert tone="error">{errorMessage(groups.error)}</Alert>}
      {join.isError && <Alert tone="error">{errorMessage(join.error)}</Alert>}
      {groups.data?.length === 0 && <p className="text-muted">No groups yet.</p>}
      <ul className="divide-y divide-line">
        {groups.data?.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-3 py-3">
            <Avatar name={g.title} size={40} />
            <span className="min-w-40 flex-1">
              <span className="block font-semibold">{g.title}</span>
              <span className="text-sm text-muted">
                {g.storeName ?? 'Whole business'} · {g.memberCount} members · active{' '}
                {formatRelativeShort(g.lastActivityAt)}
              </span>
            </span>
            {g.isMember ? (
              <Link
                href={`/chats?c=${g.id}`}
                className="rounded-lg px-3 py-2 font-semibold text-brand hover:bg-brand-soft"
              >
                Open
              </Link>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                busy={join.isPending && join.variables === g.id}
                onClick={() => join.mutate(g.id)}
              >
                Join
              </Button>
            )}
          </li>
        ))}
      </ul>
      <NewGroupDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => router.push(`/chats?c=${id}`)}
      />
    </Card>
  );
}
