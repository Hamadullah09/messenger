'use client';

import {
  BROADCAST_LIST_MAX_RECIPIENTS,
  type BroadcastListDto,
  type PublicUserDto,
} from '@storeline/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Search, Trash2, UserMinus, X } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { keys } from '@/lib/chat-cache';
import { useDebounced } from '@/lib/use-debounced';
import { Alert, Avatar, Button, cx, Dialog, Spinner, TextField } from '../ui';

/** People the current user may message directly (the server decides). */
function PeoplePicker({
  businessId,
  selected,
  onToggle,
  exclude = [],
}: {
  businessId: string;
  selected: Map<string, PublicUserDto>;
  onToggle: (user: PublicUserDto) => void;
  exclude?: string[];
}) {
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const people = useQuery({
    queryKey: ['directory', businessId, search, 50],
    queryFn: () =>
      api<PublicUserDto[]>('/directory', { query: { businessId, query: search, limit: 50 } }),
    placeholderData: keepPreviousData,
  });
  const list = (people.data ?? []).filter((u) => !exclude.includes(u.id));
  return (
    <div className="flex flex-col gap-2">
      <label className="relative block">
        <span className="sr-only">Search people</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          placeholder="Search people"
          onChange={(e) => setQuery(e.target.value)}
          className="min-h-12 w-full rounded-xl border border-line bg-surface-2 pr-3 pl-10"
        />
      </label>
      {people.isLoading && <Spinner label="Loading people" />}
      {people.isError && <Alert tone="error">{errorMessage(people.error)}</Alert>}
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {list.map((u) => {
          const checked = selected.has(u.id);
          return (
            <li key={u.id}>
              <label
                className={cx(
                  'flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3',
                  checked ? 'bg-surface-3' : 'hover:bg-surface-2',
                )}
              >
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--color-brand)]"
                  checked={checked}
                  onChange={() => onToggle(u)}
                />
                <Avatar name={u.displayName} size={40} />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{u.displayName}</span>
                  <span className="block truncate text-sm text-muted">@{u.username}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewBroadcastDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const businessId = useAuth((s) => s.activeBusinessId);
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(new Map<string, PublicUserDto>());
  const create = useMutation({
    mutationFn: () =>
      api<BroadcastListDto>('/broadcast-lists', {
        method: 'POST',
        body: { businessId, name: name.trim(), userIds: [...selected.keys()] },
      }),
    onSuccess: (list) => {
      void client.invalidateQueries({ queryKey: keys.conversations });
      setName('');
      setSelected(new Map());
      onCreated(list.conversationId);
      onClose();
    },
  });
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="New broadcast list">
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          Each person gets your message as a private chat with you. They don’t see each other.
        </Alert>
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        {!businessId ? (
          <p className="text-muted">Choose a business first.</p>
        ) : (
          <>
            <TextField
              label="List name"
              required
              maxLength={100}
              value={name}
              placeholder="e.g. All store managers"
              onChange={(e) => setName(e.target.value)}
            />
            {selected.size > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[...selected.values()].map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      const next = new Map(selected);
                      next.delete(u.id);
                      setSelected(next);
                    }}
                    className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-sm font-semibold text-brand-strong"
                  >
                    {u.displayName} <X className="size-3.5" aria-label="Remove" />
                  </button>
                ))}
              </div>
            )}
            <PeoplePicker
              businessId={businessId}
              selected={selected}
              onToggle={(u) => {
                const next = new Map(selected);
                if (next.has(u.id)) next.delete(u.id);
                else if (next.size < BROADCAST_LIST_MAX_RECIPIENTS) next.set(u.id, u);
                setSelected(next);
              }}
            />
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={create.isPending}
            disabled={!name.trim() || selected.size === 0}
            icon={<Megaphone className="size-5" aria-hidden />}
            onClick={() => create.mutate()}
          >
            Create list ({selected.size})
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function useBroadcastList(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['broadcast-list', conversationId],
    queryFn: () => api<BroadcastListDto>(`/broadcast-lists/${conversationId}`),
    enabled,
  });
}

/** Side panel for a broadcast list: rename, add or remove recipients, delete. */
export function BroadcastInfoPanel({
  conversationId,
  onClose,
  onDeleted,
}: {
  conversationId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const list = useBroadcastList(conversationId, true);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(new Map<string, PublicUserDto>());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useMutation({
    mutationFn: (body: { name?: string; addUserIds?: string[]; removeUserIds?: string[] }) =>
      api<BroadcastListDto>(`/broadcast-lists/${conversationId}`, { method: 'PATCH', body }),
    onSuccess: (data) => {
      client.setQueryData(['broadcast-list', conversationId], data);
      void client.invalidateQueries({ queryKey: keys.conversations });
      setAdding(false);
      setAdded(new Map());
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/broadcast-lists/${conversationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.conversations });
      onDeleted();
    },
  });
  const l = list.data;
  return (
    <aside
      className="flex h-full flex-col border-l border-wa-divider bg-wa-list"
      aria-label="Broadcast list info"
    >
      <header className="flex h-[60px] shrink-0 items-center gap-3 bg-wa-panel px-4">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-10 items-center justify-center rounded-full hover:bg-wa-hover"
        >
          <X className="size-5" aria-hidden />
        </button>
        <h2 className="font-medium">Broadcast list info</h2>
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {list.isPending && <Spinner />}
        {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
        {(update.isError || remove.isError) && (
          <Alert tone="error">{errorMessage(update.error ?? remove.error)}</Alert>
        )}
        {l && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <span className="inline-flex size-24 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Megaphone className="size-11" aria-hidden />
              </span>
              <p className="text-xl font-semibold">{l.name}</p>
              <p className="text-sm text-muted">{l.recipients.length} recipients</p>
            </div>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">Recipients</h3>
                <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Cancel' : 'Add people'}
                </Button>
              </div>
              {adding && (
                <div className="mb-3 flex flex-col gap-2 rounded-2xl border border-line p-3">
                  <PeoplePicker
                    businessId={l.businessId}
                    selected={added}
                    exclude={l.recipients.map((r) => r.id)}
                    onToggle={(u) => {
                      const next = new Map(added);
                      if (next.has(u.id)) next.delete(u.id);
                      else next.set(u.id, u);
                      setAdded(next);
                    }}
                  />
                  <Button
                    disabled={added.size === 0}
                    busy={update.isPending}
                    onClick={() => update.mutate({ addUserIds: [...added.keys()] })}
                  >
                    Add {added.size || ''}
                  </Button>
                </div>
              )}
              <ul className="flex flex-col gap-1">
                {l.recipients.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-wa-hover"
                  >
                    <Avatar name={r.displayName} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.displayName}</span>
                      <span className="block truncate text-sm text-muted">@{r.username}</span>
                    </span>
                    {l.recipients.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove ${r.displayName}`}
                        onClick={() => update.mutate({ removeUserIds: [r.id] })}
                        className="inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-wa-active hover:text-danger"
                      >
                        <UserMinus className="size-4" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            {confirmDelete ? (
              <Alert tone="warning" title="Delete this broadcast list?">
                Messages already sent stay in each private chat.
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    busy={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Delete list
                  </Button>
                </div>
              </Alert>
            ) : (
              <Button
                variant="ghost"
                className="text-danger"
                icon={<Trash2 className="size-5" aria-hidden />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete broadcast list
              </Button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
