'use client';

import type { AdminUserDto, BusinessDto, Page, StoreDto } from '@storeline/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { Alert, Avatar, Button, Dialog, SelectField, Spinner, TextField } from '../ui';
import {
  emptyPlaceForm,
  LogoField,
  PlaceDetailsFields,
  placeFormFrom,
  placeRequest,
  type PlaceForm,
} from './place-details';

function fieldErrors(error: unknown) {
  return (path: string) =>
    error instanceof ApiRequestError
      ? error.details.find((d) => d.path === path)?.message
      : undefined;
}

/**
 * Create a store, or edit one (name, code, location, links and logo). Pass `businesses`
 * instead of a fixed business to let the person choose which business the store belongs to.
 */
export function StoreDialog({
  businessId: fixedBusinessId,
  businesses,
  store,
  onClose,
  onSaved,
}: {
  businessId?: string;
  businesses?: Array<{ id: string; name: string }>;
  store?: StoreDto;
  onClose: () => void;
  onSaved: (store: StoreDto) => void;
}) {
  const [businessId, setBusinessId] = useState(fixedBusinessId ?? store?.businessId ?? '');
  const [name, setName] = useState(store?.name ?? '');
  const [code, setCode] = useState(store?.code ?? '');
  const [details, setDetails] = useState<PlaceForm>(
    store ? placeFormFrom(store) : emptyPlaceForm(),
  );
  const [logoUrl, setLogoUrl] = useState(store?.logoUrl ?? null);
  const save = useMutation({
    mutationFn: () =>
      api<StoreDto>(store ? `/stores/${store.id}` : `/businesses/${businessId}/stores`, {
        method: store ? 'PATCH' : 'POST',
        body: { name: name.trim(), code: code.trim(), ...placeRequest(details) },
      }),
    onSuccess: onSaved,
  });
  const error = fieldErrors(save.error);
  return (
    <Dialog open onClose={onClose} title={store ? `Edit ${store.name}` : 'New store'} wide>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {!store && businesses && (
          <SelectField
            label="Which business is this store for?"
            required
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
          >
            <option value="">Choose a business</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Store name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error('name')}
          />
          <TextField
            label="Store code"
            hint="Short code, for example A or LHR-01"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={error('code')}
          />
        </div>
        {store && (
          <LogoField
            name={store.name}
            logoUrl={logoUrl}
            uploadPath={`/stores/${store.id}/logo`}
            onChanged={(next) => setLogoUrl(next.logoUrl)}
          />
        )}
        <PlaceDetailsFields value={details} onChange={setDetails} fieldError={error} />
        {!store && (
          <p className="text-sm text-muted">You can add a logo after the store is created.</p>
        )}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!businessId}>
            {store ? 'Save store' : 'Create store'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Business profile: name, logo, location, contact and social links. */
export function BusinessDetailsDialog({
  business,
  onClose,
  onSaved,
}: {
  business: BusinessDto;
  onClose: () => void;
  onSaved: (business: BusinessDto) => void;
}) {
  const [name, setName] = useState(business.name);
  const [details, setDetails] = useState<PlaceForm>(placeFormFrom(business));
  const [logoUrl, setLogoUrl] = useState(business.logoUrl);
  const save = useMutation({
    mutationFn: () =>
      api<BusinessDto>(`/businesses/${business.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), ...placeRequest(details) },
      }),
    onSuccess: onSaved,
  });
  const error = fieldErrors(save.error);
  return (
    <Dialog open onClose={onClose} title="Business details" wide>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <TextField
          label="Business name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error('name')}
        />
        <LogoField
          name={business.name}
          logoUrl={logoUrl}
          uploadPath={`/businesses/${business.id}/logo`}
          onChanged={(next) => setLogoUrl(next.logoUrl)}
        />
        <PlaceDetailsFields value={details} onChange={setDetails} fieldError={error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending}>
            Save details
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const managedStores = (u: AdminUserDto) =>
  u.roles.filter((r) => r.roleKey === 'STORE_MANAGER' && r.storeId).map((r) => r.storeId!);

/**
 * Makes someone manager of a store. A person can manage several stores: their other stores
 * and roles are kept; removing a manager keeps them as an employee of the store. Business-level people (owners, admins) already manage every store.
 */
export function AssignManagerDialog({
  businessId,
  store,
  onClose,
  onSaved,
}: {
  businessId: string;
  store: StoreDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState('');
  const people = useQuery({
    queryKey: ['people', businessId, query, 'assign-manager'],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, {
        query: { query, status: 'ACTIVE', limit: 50 },
      }),
  });
  const change = useMutation({
    mutationFn: ({ user, add }: { user: AdminUserDto; add: boolean }) =>
      api(`/businesses/${businessId}/users/${user.id}/managed-stores/${store.id}`, {
        method: add ? 'PUT' : 'DELETE',
      }),
    onSuccess: () => {
      onSaved();
      void people.refetch();
    },
  });
  const candidates = (people.data?.items ?? []).filter((u) => u.kind === 'INTERNAL');
  return (
    <Dialog open onClose={onClose} title={`Managers of ${store.name}`} wide>
      <div className="flex flex-col gap-4">
        {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
        <p className="text-muted">
          Store managers add and deactivate staff, run the store’s groups and answer emergencies. A
          person can manage several stores.
        </p>
        <TextField label="Search people" value={query} onChange={(e) => setQuery(e.target.value)} />
        {people.isLoading && <Spinner label="Loading people" />}
        <ul className="flex flex-col gap-2">
          {candidates.map((u) => {
            const isManager = managedStores(u).includes(store.id);
            const businessLevel = u.roles.some((r) => r.scopeType !== 'STORE');
            return (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-3"
              >
                <Avatar name={u.displayName} size={40} />
                <span className="min-w-40 flex-1">
                  <span className="block font-semibold">{u.displayName}</span>
                  <span className="text-sm text-muted">
                    @{u.username} · {u.roles.map((r) => r.roleName).join(', ') || 'No role'}
                  </span>
                </span>
                {businessLevel ? (
                  <span className="text-sm text-muted">Manages all stores</span>
                ) : isManager ? (
                  <Button
                    variant="secondary"
                    icon={<UserMinus className="size-5" aria-hidden />}
                    busy={change.isPending && change.variables?.user.id === u.id}
                    onClick={() => change.mutate({ user: u, add: false })}
                  >
                    Remove as manager
                  </Button>
                ) : (
                  <Button
                    icon={<UserPlus className="size-5" aria-hidden />}
                    busy={change.isPending && change.variables?.user.id === u.id}
                    onClick={() => change.mutate({ user: u, add: true })}
                  >
                    Make manager
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}
