'use client';

import type {
  CommonGroupDto,
  ConversationDetailDto,
  MessageDto,
  Page,
  PostingPolicy,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Ban,
  Bell,
  ChevronRight,
  ImageIcon,
  LogOut,
  MessageCircle,
  Pencil,
  Pin,
  Search,
  Settings2,
  Shield,
  Star,
  UserMinus,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { keys } from '@/lib/chat-cache';
import { useUpdateMyState } from '@/lib/chat-hooks';
import { formatDay, formatRelativeShort, formatTime } from '@/lib/format';
import { useLive } from '@/lib/live-store';
import { Alert, Avatar, Button, ConfirmDialog, cx, Spinner } from '../ui';
import { AttachmentView } from './attachment-view';
import { FileSharingSelect, MemberPicker } from './dialogs';

type View = 'main' | 'shared' | 'starred' | 'settings' | 'add';
type SharedKind = 'media' | 'docs' | 'links';

const MUTE_OPTIONS: Array<{ label: string; hours: number | null }> = [
  { label: '8 hours', hours: 8 },
  { label: '1 week', hours: 24 * 7 },
  { label: 'Always', hours: null },
];
const MUTE_FOREVER = '9999-12-31T00:00:00.000Z';

const POLICY_OPTIONS: Array<{ value: PostingPolicy; label: string }> = [
  { value: 'ALL_MEMBERS', label: 'All members' },
  { value: 'ADMINS_ONLY', label: 'Only admins' },
];

function Switch({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line-strong/60',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** One tappable row, like WhatsApp's info lists. */
function Row({
  Icon,
  label,
  hint,
  onClick,
  right,
  danger,
}: {
  Icon: LucideIcon;
  label: string;
  hint?: ReactNode;
  onClick?: () => void;
  right?: ReactNode;
  danger?: boolean;
}) {
  const body = (
    <>
      <Icon
        className={cx('size-5 shrink-0', danger ? 'text-danger' : 'text-wa-icon')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-left">
        <span className={cx('block', danger && 'text-danger')}>{label}</span>
        {hint && <span className="block truncate text-sm text-wa-meta-in">{hint}</span>}
      </span>
      {right}
    </>
  );
  const cls = 'flex min-h-14 w-full items-center gap-5 px-6 py-2';
  return onClick ? (
    <button type="button" onClick={onClick} className={cx(cls, 'hover:bg-wa-hover')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Block({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <section className="bg-wa-list py-2 shadow-[0_1px_2px_rgb(11_20_26/0.06)]">
      {title && <h3 className="px-6 pt-2 pb-1 text-sm text-wa-meta-in">{title}</h3>}
      {children}
    </section>
  );
}

/**
 * WhatsApp Web-style "Contact info" / "Group info" side panel: profile, media, starred
 * messages, notifications, group settings, members and chat actions.
 */
export function ChatInfoPanel({
  conversation,
  canManage,
  onClose,
}: {
  conversation: ConversationDetailDto;
  canManage: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const me = useAuth((s) => s.me)!;
  const presence = useLive((s) => s.presence);
  const myState = useUpdateMyState(conversation.id);
  const [view, setView] = useState<View>('main');
  const [sharedKind, setSharedKind] = useState<SharedKind>('media');
  const [confirm, setConfirm] = useState<'clear' | 'exit' | null>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const isGroup = conversation.type === 'GROUP';
  const isDirect = conversation.type === 'DIRECT';
  const canEditInfo = canManage || conversation.me.canEditInfo;
  const canAdd = canManage || conversation.me.canAddMembers;
  const muted =
    conversation.me.mutedUntil !== null && new Date(conversation.me.mutedUntil) > new Date();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.conversation(conversation.id) });
    void client.invalidateQueries({ queryKey: keys.conversations });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/conversations/${conversation.id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });
  const leave = useMutation({
    mutationFn: () =>
      api(`/conversations/${conversation.id}/members/${me.user.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      onClose();
      void client.invalidateQueries({ queryKey: keys.conversations });
      router.push('/chats');
    },
  });

  const title =
    view === 'shared'
      ? 'Media, links and docs'
      : view === 'starred'
        ? 'Starred messages'
        : view === 'settings'
          ? 'Group settings'
          : view === 'add'
            ? 'Add members'
            : isDirect
              ? 'Contact info'
              : 'Group info';

  return (
    <aside
      aria-label={title}
      className="flex h-full min-h-0 w-full flex-col border-l border-wa-divider bg-wa-panel"
    >
      <header className="flex h-[60px] shrink-0 items-center gap-6 bg-wa-panel px-4">
        <button
          type="button"
          aria-label={view === 'main' ? 'Close' : 'Back'}
          title={view === 'main' ? 'Close' : 'Back'}
          onClick={() => (view === 'main' ? onClose() : setView('main'))}
          className="inline-flex size-10 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
        >
          {view === 'main' ? (
            <X className="size-6" aria-hidden />
          ) : (
            <ArrowLeft className="size-6" aria-hidden />
          )}
        </button>
        <h2 className="text-[1.05rem] font-medium">{title}</h2>
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {(update.isError || myState.isError || leave.isError) && (
          <div className="p-3">
            <Alert tone="error">{errorMessage(update.error ?? myState.error ?? leave.error)}</Alert>
          </div>
        )}

        {view === 'main' && (
          <div className="flex flex-col gap-2.5 pb-6">
            <Profile
              conversation={conversation}
              canEdit={isGroup && canEditInfo}
              online={
                conversation.counterpart ? presence[conversation.counterpart.id]?.online : undefined
              }
              lastSeenAt={
                conversation.counterpart
                  ? presence[conversation.counterpart.id]?.lastSeenAt
                  : undefined
              }
              saving={update.isPending}
              onSave={(body) => update.mutate(body)}
            />

            <Block>
              <SharedPreview
                conversationId={conversation.id}
                onOpen={(kind) => {
                  setSharedKind(kind);
                  setView('shared');
                }}
              />
            </Block>

            <Block>
              <Row
                Icon={Star}
                label="Starred messages"
                onClick={() => setView('starred')}
                right={<ChevronRight className="size-5 text-wa-icon" aria-hidden />}
              />
              <Row
                Icon={Bell}
                label="Mute notifications"
                hint={
                  muted
                    ? conversation.me.mutedUntil!.startsWith('9999')
                      ? 'Muted always'
                      : `Muted until ${formatDay(conversation.me.mutedUntil!)} ${formatTime(conversation.me.mutedUntil!)}`
                    : undefined
                }
                right={
                  <Switch
                    label="Mute notifications"
                    checked={muted}
                    disabled={myState.isPending}
                    onChange={(next) =>
                      next ? setMuteOpen(true) : myState.mutate({ mutedUntil: null })
                    }
                  />
                }
              />
              {muteOpen && (
                <div className="mx-6 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-wa-panel p-3">
                  <span className="w-full text-sm text-wa-meta-in">Mute notifications for…</span>
                  {MUTE_OPTIONS.map((o) => (
                    <Button
                      key={o.label}
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setMuteOpen(false);
                        myState.mutate({
                          mutedUntil: o.hours
                            ? new Date(Date.now() + o.hours * 3_600_000).toISOString()
                            : MUTE_FOREVER,
                        });
                      }}
                    >
                      {o.label}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => setMuteOpen(false)}>
                    Cancel
                  </Button>
                </div>
              )}
              <Row
                Icon={Pin}
                label="Pin chat"
                right={
                  <Switch
                    label="Pin chat"
                    checked={!!conversation.me.pinnedAt}
                    disabled={myState.isPending}
                    onChange={(next) => myState.mutate({ pinned: next })}
                  />
                }
              />
              {isGroup && canManage && (
                <Row
                  Icon={Settings2}
                  label="Group settings"
                  hint="Who can edit info, send messages and add members"
                  onClick={() => setView('settings')}
                  right={<ChevronRight className="size-5 text-wa-icon" aria-hidden />}
                />
              )}
            </Block>

            {!isDirect && (
              <Members
                conversation={conversation}
                canManage={canManage}
                canAdd={canAdd}
                onAdd={() => setView('add')}
                onChanged={refresh}
              />
            )}

            {isDirect && <CommonGroups conversationId={conversation.id} />}

            <Block>
              <Row
                Icon={Archive}
                label={conversation.me.archivedAt ? 'Unarchive chat' : 'Archive chat'}
                onClick={() => myState.mutate({ archived: !conversation.me.archivedAt })}
              />
              <Row Icon={Ban} label="Clear chat" danger onClick={() => setConfirm('clear')} />
              {isGroup && (
                <Row Icon={LogOut} label="Exit group" danger onClick={() => setConfirm('exit')} />
              )}
            </Block>
          </div>
        )}

        {view === 'shared' && (
          <SharedItems conversationId={conversation.id} kind={sharedKind} onKind={setSharedKind} />
        )}
        {view === 'starred' && <Starred conversationId={conversation.id} />}
        {view === 'settings' && (
          <GroupSettings
            conversation={conversation}
            busy={update.isPending}
            onChange={(body) => update.mutate(body)}
          />
        )}
        {view === 'add' && (
          <AddMembers
            conversation={conversation}
            onDone={() => {
              refresh();
              setView('main');
            }}
          />
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'exit' ? `Exit "${conversation.title}"?` : 'Clear this chat?'}
        message={
          confirm === 'exit'
            ? 'You will stop receiving messages from this group. An admin can add you again.'
            : 'All messages so far disappear from this chat for you. Other people still see them.'
        }
        confirmLabel={confirm === 'exit' ? 'Exit group' : 'Clear chat'}
        danger
        busy={leave.isPending || myState.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === 'exit') leave.mutate();
          else myState.mutate({ clearHistory: true }, { onSuccess: () => setConfirm(null) });
        }}
      />
    </aside>
  );
}

function Profile({
  conversation,
  canEdit,
  online,
  lastSeenAt,
  saving,
  onSave,
}: {
  conversation: ConversationDetailDto;
  canEdit: boolean;
  online?: boolean;
  lastSeenAt?: string | null;
  saving: boolean;
  onSave: (body: { title?: string; description?: string | null }) => void;
}) {
  const [editing, setEditing] = useState<'title' | 'description' | null>(null);
  const [value, setValue] = useState('');
  const isDirect = conversation.type === 'DIRECT';
  const start = (field: 'title' | 'description') => {
    setValue(field === 'title' ? conversation.title : (conversation.description ?? ''));
    setEditing(field);
  };
  const save = () => {
    if (editing === 'title' && value.trim()) onSave({ title: value.trim() });
    if (editing === 'description') onSave({ description: value.trim() || null });
    setEditing(null);
  };
  const subtitle = isDirect
    ? online
      ? 'online'
      : lastSeenAt
        ? `last seen ${formatRelativeShort(lastSeenAt)}`
        : `@${conversation.counterpart?.username ?? ''}`
    : conversation.type === 'BROADCAST'
      ? 'Announcements'
      : `Group · ${conversation.memberCount} members`;

  return (
    <>
      <section className="flex flex-col items-center bg-wa-list px-6 pt-7 pb-5 text-center shadow-[0_1px_2px_rgb(11_20_26/0.06)]">
        <Avatar name={conversation.title} size={160} />
        {editing === 'title' ? (
          <InlineEdit
            label="Group name"
            value={value}
            maxLength={100}
            onChange={setValue}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <h3 className="mt-4 flex items-center gap-2 text-2xl">
            {conversation.title}
            {canEdit && (
              <button
                type="button"
                aria-label="Edit group name"
                title="Edit group name"
                onClick={() => start('title')}
                className="inline-flex size-8 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
              >
                <Pencil className="size-4" aria-hidden />
              </button>
            )}
          </h3>
        )}
        <p className="mt-1 text-wa-meta-in">{subtitle}</p>
        {isDirect && conversation.counterpart && (
          <p className="text-sm text-wa-meta-in">@{conversation.counterpart.username}</p>
        )}
      </section>
      {!isDirect && (
        <Block>
          {editing === 'description' ? (
            <div className="px-6 py-2">
              <InlineEdit
                label="Group description"
                value={value}
                maxLength={500}
                multiline
                onChange={setValue}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <div className="flex items-start gap-3 px-6 py-3">
              <p
                className={cx(
                  'flex-1 whitespace-pre-wrap',
                  !conversation.description && 'text-wa-meta-in',
                )}
              >
                {conversation.description || (canEdit ? 'Add group description' : 'No description')}
              </p>
              {canEdit && (
                <button
                  type="button"
                  aria-label="Edit group description"
                  title="Edit group description"
                  disabled={saving}
                  onClick={() => start('description')}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
                >
                  <Pencil className="size-4" aria-hidden />
                </button>
              )}
            </div>
          )}
          <p className="px-6 pb-2 text-sm text-wa-meta-in">
            Created {formatDay(conversation.createdAt)}
            {conversation.createdBy ? ` by ${conversation.createdBy.displayName}` : ''}
          </p>
        </Block>
      )}
    </>
  );
}

function InlineEdit({
  label,
  value,
  maxLength,
  multiline,
  onChange,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  maxLength: number;
  multiline?: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = 'w-full border-b-2 border-brand bg-transparent py-1.5 text-left focus:outline-none';
  return (
    <form
      className="mt-4 flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label className="sr-only" htmlFor="chat-info-edit">
        {label}
      </label>
      {multiline ? (
        <textarea
          id="chat-info-edit"
          autoFocus
          rows={3}
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cx(field, 'resize-none')}
        />
      ) : (
        <input
          id="chat-info-edit"
          autoFocus
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          className={field}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}

function SharedPreview({
  conversationId,
  onOpen,
}: {
  conversationId: string;
  onOpen: (kind: SharedKind) => void;
}) {
  const media = useQuery({
    queryKey: ['shared', conversationId, 'media'],
    queryFn: () =>
      api<MessageDto[]>(`/conversations/${conversationId}/shared`, {
        query: { kind: 'media', limit: 3 },
      }),
  });
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen('media')}
        className="flex w-full items-center gap-5 px-6 py-3 hover:bg-wa-hover"
      >
        <ImageIcon className="size-5 text-wa-icon" aria-hidden />
        <span className="flex-1 text-left">Media, links and docs</span>
        <ChevronRight className="size-5 text-wa-icon" aria-hidden />
      </button>
      {media.data && media.data.length > 0 && (
        <div className="grid grid-cols-3 gap-2 px-6 pb-3">
          {media.data.map((m) =>
            m.attachment ? (
              <div key={m.id} className="aspect-square overflow-hidden rounded-md">
                <AttachmentView attachment={m.attachment} />
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function SharedItems({
  conversationId,
  kind,
  onKind,
}: {
  conversationId: string;
  kind: SharedKind;
  onKind: (k: SharedKind) => void;
}) {
  const items = useQuery({
    queryKey: ['shared', conversationId, kind],
    queryFn: () =>
      api<MessageDto[]>(`/conversations/${conversationId}/shared`, { query: { kind } }),
  });
  const links = useMemo(
    () =>
      kind === 'links'
        ? (items.data ?? []).flatMap((m) =>
            [...(m.body ?? '').matchAll(/https?:\/\/[^\s<>"]+/gi)].map((match) => ({
              id: `${m.id}-${match.index}`,
              url: match[0],
              message: m,
            })),
          )
        : [],
    [items.data, kind],
  );
  return (
    <div className="flex flex-col">
      <div role="tablist" aria-label="Shared items" className="flex bg-wa-list">
        {(['media', 'docs', 'links'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => onKind(k)}
            className={cx(
              'flex-1 border-b-[3px] py-3 font-medium capitalize',
              kind === k ? 'border-brand text-brand' : 'border-transparent text-wa-meta-in',
            )}
          >
            {k === 'docs' ? 'Docs' : k === 'media' ? 'Media' : 'Links'}
          </button>
        ))}
      </div>
      <div className="p-4">
        {items.isLoading && <Spinner label="Loading" />}
        {items.isError && <Alert tone="error">{errorMessage(items.error)}</Alert>}
        {items.data?.length === 0 && (
          <p className="py-10 text-center text-wa-meta-in">
            No {kind === 'docs' ? 'documents' : kind} shared yet
          </p>
        )}
        {kind === 'media' && (
          <div className="grid grid-cols-3 gap-2">
            {items.data?.map((m) =>
              m.attachment ? (
                <div key={m.id} className="aspect-square overflow-hidden rounded-md">
                  <AttachmentView attachment={m.attachment} />
                </div>
              ) : null,
            )}
          </div>
        )}
        {kind === 'docs' && (
          <ul className="flex flex-col gap-2">
            {items.data?.map((m) =>
              m.attachment ? (
                <li key={m.id}>
                  <AttachmentView attachment={m.attachment} />
                  <p className="mt-1 text-xs text-wa-meta-in">
                    {m.sender.displayName} · {formatDay(m.createdAt)}
                  </p>
                </li>
              ) : null,
            )}
          </ul>
        )}
        {kind === 'links' && (
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li key={l.id} className="rounded-lg bg-wa-list p-3">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="font-medium break-all text-brand hover:underline"
                >
                  {l.url}
                </a>
                <p className="mt-1 text-xs text-wa-meta-in">
                  {l.message.sender.displayName} · {formatDay(l.message.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Starred({ conversationId }: { conversationId: string }) {
  const starred = useQuery({
    queryKey: ['starred'],
    queryFn: () => api<Page<MessageDto>>('/messages/starred', { query: { limit: 100 } }),
  });
  const items = (starred.data?.items ?? []).filter((m) => m.conversationId === conversationId);
  return (
    <div className="flex flex-col gap-2 p-4">
      {starred.isLoading && <Spinner label="Loading starred messages" />}
      {starred.isError && <Alert tone="error">{errorMessage(starred.error)}</Alert>}
      {starred.isSuccess && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10 text-center text-wa-meta-in">
          <Star className="size-10" aria-hidden />
          <p>No starred messages. Open a message’s menu and choose Star to find it here later.</p>
        </div>
      )}
      {items.map((m) => (
        <article key={m.id} className="wa-bubble rounded-lg bg-wa-in p-3">
          <p className="text-sm font-semibold text-brand">{m.sender.displayName}</p>
          {m.attachment && <AttachmentView attachment={m.attachment} />}
          {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
          <p className="mt-1 text-right text-xs text-wa-meta-in">
            {formatDay(m.createdAt)} {formatTime(m.createdAt)}
          </p>
        </article>
      ))}
    </div>
  );
}

function PolicyChoice({
  legend,
  hint,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  hint: string;
  value: PostingPolicy;
  disabled: boolean;
  onChange: (v: PostingPolicy) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1 px-6 py-3">
      <legend className="font-medium">{legend}</legend>
      <p className="mb-1 text-sm text-wa-meta-in">{hint}</p>
      {POLICY_OPTIONS.map((o) => (
        <label key={o.value} className="flex min-h-10 cursor-pointer items-center gap-3">
          <input
            type="radio"
            className="size-5 accent-[var(--brand)]"
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function GroupSettings({
  conversation,
  busy,
  onChange,
}: {
  conversation: ConversationDetailDto;
  busy: boolean;
  onChange: (body: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 py-2.5">
      <Block title="Members can">
        <PolicyChoice
          legend="Edit group info"
          hint="Change the group name and description."
          value={conversation.editInfoPolicy}
          disabled={busy}
          onChange={(v) => onChange({ editInfoPolicy: v })}
        />
        <PolicyChoice
          legend="Send messages"
          hint="Only admins: the group works like an announcement channel."
          value={conversation.postingPolicy}
          disabled={busy}
          onChange={(v) => onChange({ postingPolicy: v })}
        />
        <PolicyChoice
          legend="Add other members"
          hint="Who can add people to this group."
          value={conversation.addMembersPolicy}
          disabled={busy}
          onChange={(v) => onChange({ addMembersPolicy: v })}
        />
        <div className="px-6 py-3">
          <FileSharingSelect
            value={conversation.fileSharingPolicy}
            disabled={busy}
            onChange={(v) => onChange({ fileSharingPolicy: v })}
          />
        </div>
      </Block>
    </div>
  );
}

function Members({
  conversation,
  canManage,
  canAdd,
  onAdd,
  onChanged,
}: {
  conversation: ConversationDetailDto;
  canManage: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const myId = useAuth((s) => s.me?.user.id);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'MEMBER' }) =>
      api(`/conversations/${conversation.id}/members/${userId}`, {
        method: 'PATCH',
        body: { role },
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/conversations/${conversation.id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  const message = useMutation({
    mutationFn: (userId: string) =>
      api<ConversationDetailDto>('/conversations/direct', {
        method: 'POST',
        body: { businessId: conversation.businessId, userId },
      }),
    onSuccess: (chat) => router.push(`/chats?c=${chat.id}`),
  });
  const q = query.trim().toLowerCase();
  const members = [...conversation.members]
    .filter(
      (m) => !q || m.user.displayName.toLowerCase().includes(q) || m.user.username.includes(q),
    )
    .sort((a, b) =>
      a.user.id === myId
        ? -1
        : b.user.id === myId
          ? 1
          : a.role === b.role
            ? a.user.displayName.localeCompare(b.user.displayName)
            : a.role === 'ADMIN'
              ? -1
              : 1,
    );
  const error = setRole.error ?? remove.error ?? message.error;

  return (
    <Block>
      <div className="flex items-center justify-between px-6 pt-2 pb-1">
        <h3 className="text-sm text-wa-meta-in">{conversation.memberCount} members</h3>
        <button
          type="button"
          aria-label="Search members"
          title="Search members"
          onClick={() => setSearching((v) => !v)}
          className="inline-flex size-9 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
        >
          <Search className="size-5" aria-hidden />
        </button>
      </div>
      {searching && (
        <div className="px-6 pb-2">
          <label className="sr-only" htmlFor="member-search">
            Search members
          </label>
          <input
            id="member-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            className="wa-field h-9 w-full rounded-lg bg-wa-panel px-3"
          />
        </div>
      )}
      {error && (
        <div className="px-6 pb-2">
          <Alert tone="error">{errorMessage(error)}</Alert>
        </div>
      )}
      {canAdd && conversation.type === 'GROUP' && (
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center gap-4 px-6 py-2.5 hover:bg-wa-hover"
        >
          <span className="inline-flex size-10 items-center justify-center rounded-full bg-brand text-brand-contrast">
            <UserPlus className="size-5" aria-hidden />
          </span>
          <span>Add member</span>
        </button>
      )}
      <ul>
        {members.map((m) => {
          const mine = m.user.id === myId;
          const open = openFor === m.user.id;
          return (
            <li key={m.user.id}>
              <button
                type="button"
                disabled={mine}
                aria-expanded={open}
                onClick={() => setOpenFor(open ? null : m.user.id)}
                className="flex w-full items-center gap-4 px-6 py-2.5 text-left hover:bg-wa-hover disabled:hover:bg-transparent"
              >
                <Avatar name={m.user.displayName} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{mine ? 'You' : m.user.displayName}</span>
                  <span className="block truncate text-sm text-wa-meta-in">@{m.user.username}</span>
                </span>
                {m.role === 'ADMIN' && (
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-strong">
                    <Shield className="size-3.5" aria-hidden /> Group admin
                  </span>
                )}
              </button>
              {open && !mine && (
                <div className="mx-6 mb-2 flex flex-wrap gap-2 rounded-lg bg-wa-panel p-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<MessageCircle className="size-4" aria-hidden />}
                    busy={message.isPending}
                    onClick={() => message.mutate(m.user.id)}
                  >
                    Message {m.user.displayName.split(' ')[0]}
                  </Button>
                  {canManage && conversation.type === 'GROUP' && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Shield className="size-4" aria-hidden />}
                        busy={setRole.isPending}
                        onClick={() =>
                          setRole.mutate({
                            userId: m.user.id,
                            role: m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                          })
                        }
                      >
                        {m.role === 'ADMIN' ? 'Dismiss as admin' : 'Make group admin'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        icon={<UserMinus className="size-4" aria-hidden />}
                        busy={remove.isPending}
                        onClick={() => remove.mutate(m.user.id)}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {conversation.membersTruncated && (
        <p className="px-6 py-2 text-sm text-wa-meta-in">Showing the first 500 members.</p>
      )}
    </Block>
  );
}

function AddMembers({
  conversation,
  onDone,
}: {
  conversation: ConversationDetailDto;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const add = useMutation({
    mutationFn: () =>
      api(`/conversations/${conversation.id}/members`, {
        method: 'POST',
        body: { userIds: [...selected] },
      }),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-col gap-3 p-4">
      {add.isError && <Alert tone="error">{errorMessage(add.error)}</Alert>}
      <MemberPicker
        businessId={conversation.businessId}
        storeId={conversation.storeId}
        exclude={conversation.members.map((m) => m.user.id)}
        selected={selected}
        onToggle={(id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
      <p className="text-sm text-wa-meta-in">
        New members see messages from the moment they are added.
      </p>
      <Button
        busy={add.isPending}
        disabled={selected.size === 0}
        icon={<UserPlus className="size-5" aria-hidden />}
        onClick={() => add.mutate()}
      >
        Add {selected.size > 0 ? selected.size : ''} {selected.size === 1 ? 'member' : 'members'}
      </Button>
    </div>
  );
}

function CommonGroups({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const groups = useQuery({
    queryKey: ['common-groups', conversationId],
    queryFn: () => api<CommonGroupDto[]>(`/conversations/${conversationId}/common-groups`),
  });
  if (!groups.data || groups.data.length === 0) return null;
  return (
    <Block
      title={`${groups.data.length} ${groups.data.length === 1 ? 'group' : 'groups'} in common`}
    >
      {groups.data.map((g) => (
        <Row
          key={g.id}
          Icon={Users}
          label={g.title}
          hint={`${g.memberCount} members`}
          onClick={() => router.push(`/chats?c=${g.id}`)}
        />
      ))}
    </Block>
  );
}
