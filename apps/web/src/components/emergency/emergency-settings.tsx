'use client';

import {
  EMERGENCY_MAX_CONTACTS,
  type AdminUserDto,
  type EmergencySettingsDto,
  type Page,
  type PublicUserDto,
  type StoreDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Siren, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { emergencyKeys } from '@/lib/emergency';
import { Alert, Avatar, Button, EmptyState, IconButton, SelectField, Spinner } from '../ui';

const TIMEOUTS = [
  [30, '30 seconds'],
  [60, '1 minute'],
  [120, '2 minutes'],
  [180, '3 minutes'],
  [300, '5 minutes'],
  [600, '10 minutes'],
] as const;

const PRIORITY_LABEL = ['Primary', 'Backup', 'Third', 'Fourth', 'Fifth'];

/** Store emergency chain: ordered contacts and how long each level has to acknowledge. */
export function EmergencySettingsTab({ businessId }: { businessId: string }) {
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const [storeId, setStoreId] = useState('');
  const activeStores = (stores.data ?? []).filter((s) => s.status === 'ACTIVE');
  useEffect(() => {
    if (!storeId && activeStores[0]) setStoreId(activeStores[0].id);
  }, [activeStores, storeId]);

  if (stores.isPending) return <Spinner label="Loading stores" />;
  if (activeStores.length === 0) return <EmptyState title="Add a store first" />;
  return (
    <div className="flex flex-col gap-5">
      <SelectField
        label="Store"
        className="max-w-md"
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
      >
        {activeStores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      {storeId && (
        <StoreEmergencySettings key={storeId} businessId={businessId} storeId={storeId} />
      )}
    </div>
  );
}

function StoreEmergencySettings({ businessId, storeId }: { businessId: string; storeId: string }) {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: emergencyKeys.settings(storeId),
    queryFn: () => api<EmergencySettingsDto>(`/emergency/stores/${storeId}/settings`),
    retry: false,
  });
  const members = useQuery({
    queryKey: ['people', businessId, '', storeId],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, {
        query: { storeId, limit: 100 },
      }),
  });
  const [contacts, setContacts] = useState<PublicUserDto[]>([]);
  const [timeout, setTimeoutSeconds] = useState(120);
  const [adding, setAdding] = useState('');
  useEffect(() => {
    if (!settings.data) return;
    setContacts(settings.data.contacts.map((c) => c.user));
    setTimeoutSeconds(settings.data.ackTimeoutSeconds);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api<EmergencySettingsDto>(`/emergency/stores/${storeId}/settings`, {
        method: 'PUT',
        body: { ackTimeoutSeconds: timeout, contactUserIds: contacts.map((c) => c.id) },
      }),
    onSuccess: (data) => client.setQueryData(emergencyKeys.settings(storeId), data),
  });

  if (settings.isPending) return <Spinner label="Loading emergency settings" />;
  if (settings.error) return <Alert tone="error">{errorMessage(settings.error)}</Alert>;

  const ineligible = new Set(
    settings.data.contacts.filter((c) => !c.eligible).map((c) => c.user.id),
  );
  const candidates = (members.data?.items ?? []).filter(
    (u) => u.status === 'ACTIVE' && u.kind === 'INTERNAL' && !contacts.some((c) => c.id === u.id),
  );
  const move = (index: number, delta: number) =>
    setContacts((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });
  const dirty =
    timeout !== settings.data.ackTimeoutSeconds ||
    contacts.map((c) => c.id).join() !== settings.data.contacts.map((c) => c.user.id).join();
  const { fallback } = settings.data;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Siren className="size-5 text-danger" aria-hidden /> Emergency contacts
          </h2>
          <p className="text-muted">
            Alerted in this order when someone presses <strong>Emergency help</strong>. If the first
            person does not respond in time, the next one is alerted.
          </p>
        </div>
        {contacts.length === 0 ? (
          <Alert tone="warning" title="No contacts set">
            Alerts go to this store’s managers ({fallback.storeManagers}), then to business admins (
            {fallback.businessAdmins}).
          </Alert>
        ) : (
          <ol className="flex flex-col gap-2">
            {contacts.map((c, i) => (
              <li key={c.id} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                <span className="w-16 shrink-0 text-sm font-bold text-muted">
                  {PRIORITY_LABEL[i]}
                </span>
                <Avatar name={c.displayName} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{c.displayName}</span>
                  {ineligible.has(c.id) && (
                    <span className="text-sm font-semibold text-danger">
                      No longer active at this store — will be skipped
                    </span>
                  )}
                </span>
                <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-5" aria-hidden />
                </IconButton>
                <IconButton
                  label="Move down"
                  disabled={i === contacts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="size-5" aria-hidden />
                </IconButton>
                <IconButton
                  label={`Remove ${c.displayName}`}
                  onClick={() => setContacts((list) => list.filter((x) => x.id !== c.id))}
                >
                  <Trash2 className="size-5" aria-hidden />
                </IconButton>
              </li>
            ))}
          </ol>
        )}
        {contacts.length < EMERGENCY_MAX_CONTACTS && (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label="Add a contact"
              hint="Only active members of this store can be contacts."
              className="min-w-64 flex-1"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">Choose a person…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </SelectField>
            <Button
              variant="secondary"
              icon={<Plus className="size-5" aria-hidden />}
              disabled={!adding}
              onClick={() => {
                const user = candidates.find((u) => u.id === adding);
                if (user) setContacts((list) => [...list, user]);
                setAdding('');
              }}
            >
              Add
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <SelectField
          label="Time to respond"
          hint="How long each contact has to press “I’m responding” before the next is alerted."
          value={timeout}
          onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
        >
          {TIMEOUTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <p className="text-sm text-muted">
          After the last contact, business admins ({fallback.businessAdmins}) are alerted. Contact
          details are never shown to the person asking for help.
        </p>
        {save.error && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && !dirty && <Alert tone="success">Emergency settings saved.</Alert>}
        <Button busy={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </section>
    </div>
  );
}
