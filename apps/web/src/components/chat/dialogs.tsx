'use client';

import type {
  AdminUserDto,
  ConversationDetailDto,
  FileSharingPolicy,
  GroupCategory,
  MessageDto,
  MessageInfoDto,
  Page,
  PublicUserDto,
  StoreDto,
} from '@storeline/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { sortConversations } from '@/lib/chat-cache';
import { useConversations } from '@/lib/chat-hooks';
import { useDebounced } from '@/lib/use-debounced';
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
} from '../ui';

/** Start a direct chat with someone from the directory (server decides who is reachable). */
export function NewChatDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  onOpened: (id: string) => void;
}) {
  const businessId = useAuth((s) => s.activeBusinessId);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const directory = useQuery({
    queryKey: ['directory', businessId, search],
    queryFn: () =>
      api<PublicUserDto[]>('/directory', { query: { businessId, query: search, limit: 30 } }),
    enabled: open && !!businessId,
    placeholderData: keepPreviousData,
  });
  const start = useMutation({
    mutationFn: (userId: string) =>
      api<ConversationDetailDto>('/conversations/direct', {
        method: 'POST',
        body: { businessId, userId },
      }),
    onSuccess: (c) => {
      onOpened(c.id);
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New chat">
      <div className="flex flex-col gap-4">
        <TextField
          label="Search people"
          placeholder="Name or username"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {start.isError && <Alert tone="error">{errorMessage(start.error)}</Alert>}
        {!businessId && (
          <EmptyState title="No one to message from this account">
            Messaging is for people who belong to a business. This account is a platform
            administrator and is not a member of any business — sign in with a business account to
            chat.
          </EmptyState>
        )}
        {businessId && directory.isLoading && <Spinner label="Searching" />}
        {directory.isError && <Alert tone="error">{errorMessage(directory.error)}</Alert>}
        {directory.data?.length === 0 && (
          <EmptyState title="Nobody found">
            You can message people who work at your store.
          </EmptyState>
        )}
        <ul className="flex flex-col gap-1">
          {directory.data?.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => start.mutate(u.id)}
                disabled={start.isPending}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-surface-2"
              >
                <Avatar name={u.displayName} size={44} />
                <span>
                  <span className="block font-bold">{u.displayName}</span>
                  <span className="block text-sm text-muted">@{u.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

const CATEGORIES: Array<{ value: GroupCategory; label: string }> = [
  { value: 'GENERAL', label: 'General' },
  { value: 'OPERATIONS', label: 'Operations' },
  { value: 'SECURITY', label: 'Security' },
  { value: 'EMERGENCY_RESPONSE', label: 'Emergency response' },
  { value: 'MANAGEMENT', label: 'Management' },
  { value: 'ANNOUNCEMENTS', label: 'Announcements' },
];

export function MemberPicker({
  businessId,
  storeId,
  selected,
  onToggle,
  exclude = [],
}: {
  businessId: string;
  storeId: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  exclude?: string[];
}) {
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const users = useQuery({
    queryKey: ['business-users', businessId, storeId, search],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, {
        query: { query: search, storeId: storeId ?? undefined, status: 'ACTIVE', limit: 50 },
      }),
    placeholderData: keepPreviousData,
  });
  const myId = useAuth((s) => s.me?.user.id);
  const candidates = (users.data?.items ?? []).filter(
    (u) => u.id !== myId && !exclude.includes(u.id) && u.kind === 'INTERNAL',
  );
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
      {users.isLoading && <Spinner label="Loading people" />}
      {users.isError && <Alert tone="error">{errorMessage(users.error)}</Alert>}
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {candidates.map((u) => {
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
                  className="size-5 accent-[var(--brand)]"
                  checked={checked}
                  onChange={() => onToggle(u.id)}
                />
                <Avatar name={u.displayName} size={40} />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{u.displayName}</span>
                  <span className="block truncate text-sm text-muted">
                    {u.roles.map((r) => r.roleName).join(', ') || 'Member'} ·{' '}
                    {u.stores.map((s) => s.name).join(', ') || 'Whole business'}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewGroupDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const businessId = useAuth((s) => s.activeBusinessId);
  const me = useAuth((s) => s.me);
  const businessWide =
    hasPermission(me, 'group.manage', businessId) &&
    me?.grants.some((g) => g.scope.type !== 'STORE');
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
    enabled: open && !!businessId,
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [storeId, setStoreId] = useState<string>('');
  const [category, setCategory] = useState<GroupCategory>('GENERAL');
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [fileSharing, setFileSharing] = useState<FileSharingPolicy>('ALL_MEMBERS');
  const [members, setMembers] = useState<Set<string>>(new Set());
  const effectiveStore = storeId || (!businessWide ? (stores.data?.[0]?.id ?? '') : '');

  const create = useMutation({
    mutationFn: () =>
      api<ConversationDetailDto>('/conversations/groups', {
        method: 'POST',
        body: {
          businessId,
          storeId: effectiveStore || null,
          title,
          description: description || undefined,
          category,
          postingPolicy: adminsOnly ? 'ADMINS_ONLY' : 'ALL_MEMBERS',
          fileSharingPolicy: fileSharing,
          memberIds: [...members],
        },
      }),
    onSuccess: (c) => {
      onCreated(c.id);
      onClose();
      setTitle('');
      setDescription('');
      setMembers(new Set());
    },
  });

  return (
    <Dialog open={open} onClose={onClose} title="New group" wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <TextField
          label="Group name"
          required
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="For example: Store A Operations"
        />
        <TextArea
          label="Description (optional)"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Store"
            hint="Store groups can only include people from that store."
            value={effectiveStore}
            onChange={(e) => {
              setStoreId(e.target.value);
              setMembers(new Set());
            }}
          >
            {businessWide && <option value="">Whole business</option>}
            {stores.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value as GroupCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectField>
        </div>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={adminsOnly}
            onChange={(e) => setAdminsOnly(e.target.checked)}
          />
          <span>Only admins can send messages (announcements)</span>
        </label>
        <FileSharingSelect value={fileSharing} onChange={setFileSharing} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">Members ({members.size} selected)</legend>
          {businessId && (
            <MemberPicker
              businessId={businessId}
              storeId={effectiveStore || null}
              selected={members}
              onToggle={(id) =>
                setMembers((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          )}
        </fieldset>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending} disabled={!title.trim()}>
            Create group
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ForwardDialog({
  message,
  onClose,
}: {
  message: MessageDto | null;
  onClose: () => void;
}) {
  const { data } = useConversations();
  const businessId = useAuth((s) => s.activeBusinessId);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const list = useMemo(
    () =>
      sortConversations(data ?? []).filter(
        (c) => c.businessId === businessId && c.me.canPost && !c.me.archivedAt,
      ),
    [data, businessId],
  );
  const forward = useMutation({
    mutationFn: () =>
      api(`/messages/${message!.id}/forward`, {
        method: 'POST',
        body: {
          targets: [...targets].map((conversationId) => ({
            conversationId,
            clientMessageId: crypto.randomUUID(),
          })),
        },
      }),
    onSuccess: () => {
      setTargets(new Set());
      onClose();
    },
  });
  return (
    <Dialog open={!!message} onClose={onClose} title="Forward message">
      <div className="flex flex-col gap-4">
        {forward.isError && <Alert tone="error">{errorMessage(forward.error)}</Alert>}
        <p className="rounded-xl bg-surface-2 p-3 text-muted">{message?.body}</p>
        <p className="font-semibold">Choose up to 5 chats</p>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {list.map((c) => {
            const checked = targets.has(c.id);
            return (
              <li key={c.id}>
                <label
                  className={cx(
                    'flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3',
                    checked ? 'bg-surface-3' : 'hover:bg-surface-2',
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={checked}
                    disabled={!checked && targets.size >= 5}
                    onChange={() =>
                      setTargets((t) => {
                        const n = new Set(t);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                  />
                  <Avatar name={c.title} size={40} />
                  <span className="font-bold">{c.title}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <Button
          busy={forward.isPending}
          disabled={targets.size === 0}
          onClick={() => forward.mutate()}
        >
          Forward
        </Button>
      </div>
    </Dialog>
  );
}

const STATUS_LABEL = {
  PENDING: 'Waiting to send',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
} as const;

export function MessageInfoDialog({
  message,
  onClose,
}: {
  message: MessageDto | null;
  onClose: () => void;
}) {
  const info = useQuery({
    queryKey: ['message-info', message?.id],
    queryFn: () => api<MessageInfoDto>(`/messages/${message!.id}/info`),
    enabled: !!message,
  });
  return (
    <Dialog open={!!message} onClose={onClose} title="Message info">
      {info.isLoading && <Spinner />}
      {info.isError && <Alert tone="error">{errorMessage(info.error)}</Alert>}
      <ul className="flex flex-col gap-2">
        {info.data?.recipients.map((r) => (
          <li key={r.user.id} className="flex items-center gap-3">
            <Avatar name={r.user.displayName} size={40} />
            <span className="flex-1 font-semibold">{r.user.displayName}</span>
            <span
              className={cx(
                'flex items-center gap-1 text-sm font-semibold',
                r.status === 'READ' ? 'text-accent' : 'text-muted',
              )}
            >
              {r.status !== 'PENDING' && <Check className="size-4" aria-hidden />}
              {STATUS_LABEL[r.status]}
            </span>
          </li>
        ))}
      </ul>
      {info.data?.recipients.length === 0 && (
        <p className="text-muted">Nobody else is in this chat yet.</p>
      )}
    </Dialog>
  );
}

const FILE_SHARING_LABEL: Record<FileSharingPolicy, string> = {
  ALL_MEMBERS: 'Everyone can share files',
  ADMINS_ONLY: 'Only admins can share files',
  DISABLED: 'File sharing is off',
};

export function FileSharingSelect({
  value,
  onChange,
  disabled,
}: {
  value: FileSharingPolicy;
  onChange: (value: FileSharingPolicy) => void;
  disabled?: boolean;
}) {
  return (
    <SelectField
      label="Photos, videos and documents"
      hint="Who can share files in this group"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as FileSharingPolicy)}
    >
      {(Object.keys(FILE_SHARING_LABEL) as FileSharingPolicy[]).map((key) => (
        <option key={key} value={key}>
          {FILE_SHARING_LABEL[key]}
        </option>
      ))}
    </SelectField>
  );
}
