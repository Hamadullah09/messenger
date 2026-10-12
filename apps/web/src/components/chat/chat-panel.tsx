'use client';

import type { MessageDto, PresenceDto, SearchResultDto, Page } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  Info,
  MailWarning,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  X,
  Siren,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import {
  useConversationDetail,
  useLoadOlder,
  useMessageAction,
  useMediaSend,
  useMessages,
  useSendMessage,
  useUpdateMyState,
} from '@/lib/chat-hooks';
import { formatRelativeShort, formatTime } from '@/lib/format';
import { activeTypers, useLive } from '@/lib/live-store';
import { useSocket } from '@/lib/realtime';
import { Alert, Avatar, Button, ConfirmDialog, cx, Dialog, Spinner } from '../ui';
import { Composer } from './composer';
import { UploadTray } from './upload-tray';
import { ChatInfoPanel } from './chat-info';
import { ForwardDialog, MessageInfoDialog } from './dialogs';
import type { BubbleActions } from './message-bubble';
import { MessageList } from './message-list';

const MUTE_FOREVER = '9999-12-31T00:00:00.000Z';
const HEADER_ICON =
  'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-wa-icon transition-colors hover:bg-wa-hover';

export function ChatPanel({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const me = useAuth((s) => s.me)!;
  const socket = useSocket();
  const detail = useConversationDetail(conversationId);
  const messages = useMessages(conversationId);
  const loadOlder = useLoadOlder(conversationId);
  const { send, retry } = useSendMessage(conversationId);
  const uploads = useMediaSend(conversationId);
  const action = useMessageAction();
  const myState = useUpdateMyState(conversationId);
  const typing = useLive((s) => s.typing);
  const presence = useLive((s) => s.presence);
  const setOpen = useLive((s) => s.setOpenConversation);

  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const [editing, setEditing] = useState<MessageDto | null>(null);
  const [deleting, setDeleting] = useState<MessageDto | null>(null);
  const [forwarding, setForwarding] = useState<MessageDto | null>(null);
  const [infoFor, setInfoFor] = useState<MessageDto | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // Remember where unread started when the chat was opened, for the "Unread messages" marker.
  const unreadMarker = useRef<{ id: string; seq: number | null } | null>(null);

  const conversation = detail.data;
  if (conversation && unreadMarker.current?.id !== conversationId) {
    unreadMarker.current = {
      id: conversationId,
      seq:
        conversation.unreadCount > 0
          ? Math.max(conversation.me.lastReadSeq, conversation.me.historyFromSeq) + 1
          : null,
    };
  }

  useEffect(() => {
    setOpen(conversationId);
    setReplyTo(null);
    setEditing(null);
    return () => setOpen(null);
  }, [conversationId, setOpen]);

  // Mark everything up to the newest message as read while the chat is open and visible.
  const newestSeq =
    messages.data?.items.reduce((max, m) => (m.local ? max : Math.max(max, m.seq)), 0) ?? 0;
  useEffect(() => {
    if (!socket || newestSeq === 0 || document.visibilityState !== 'visible') return;
    socket.emit('message.read', { conversationId, seq: newestSeq }, () => undefined);
  }, [socket, conversationId, newestSeq]);

  // Presence for the other person in a direct chat (only visible to people who share a chat).
  const counterpartId = conversation?.counterpart?.id;
  useQuery({
    queryKey: ['presence', counterpartId],
    queryFn: async () => {
      const result = await api<PresenceDto[]>('/presence', { query: { userIds: counterpartId } });
      for (const p of result) useLive.getState().setPresence(p.userId, p.online, p.lastSeenAt);
      return result;
    },
    enabled: !!counterpartId,
  });

  const nameOf = useCallback(
    (id: string) => {
      if (id === me.user.id) return 'You';
      return conversation?.members.find((m) => m.user.id === id)?.user.displayName ?? 'Someone';
    },
    [conversation?.members, me.user.id],
  );

  const actions: BubbleActions = useMemo(
    () => ({
      onReply: (m) => {
        setEditing(null);
        setReplyTo(m);
      },
      onReact: (m, emoji) =>
        action.mutate({ message: m, kind: emoji ? 'react' : 'unreact', value: emoji ?? undefined }),
      onEdit: (m) => {
        setReplyTo(null);
        setEditing(m);
      },
      onDelete: (m) => setDeleting(m),
      onForward: (m) => setForwarding(m),
      onStar: (m, star) => action.mutate({ message: m, kind: star ? 'star' : 'unstar' }),
      onPin: (m, pin) => action.mutate({ message: m, kind: pin ? 'pin' : 'unpin' }),
      onInfo: (m) => setInfoFor(m),
      onRetry: (m) => void retry(m),
    }),
    [action, retry],
  );

  if (detail.isPending || messages.isPending) return <Spinner label="Opening chat" />;
  if (detail.isError || messages.isError || !conversation) {
    return (
      <div className="p-4">
        <Alert tone="error" title="This chat could not be opened">
          {errorMessage(detail.error ?? messages.error)}
        </Alert>
      </div>
    );
  }

  const typers = activeTypers(typing, conversationId).filter((n) => n !== me.user.displayName);
  const counterpartPresence = counterpartId ? presence[counterpartId] : undefined;
  const muted =
    conversation.me.mutedUntil !== null && new Date(conversation.me.mutedUntil) > new Date();
  const canManage =
    conversation.type === 'GROUP' &&
    (conversation.me.role === 'ADMIN' ||
      hasPermission(me, 'group.manage', conversation.businessId));
  const canModerate =
    conversation.me.role === 'ADMIN' ||
    hasPermission(me, 'message.delete', conversation.businessId);
  const subtitle =
    typers.length > 0
      ? `${typers.join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…`
      : conversation.type === 'DIRECT'
        ? counterpartPresence?.online
          ? 'Online'
          : counterpartPresence?.lastSeenAt
            ? `Last seen ${formatRelativeShort(counterpartPresence.lastSeenAt)}`
            : `@${conversation.counterpart?.username ?? ''}`
        : conversation.type === 'BROADCAST'
          ? `Announcements · ${conversation.memberCount} members`
          : conversation.members
              .slice(0, 6)
              .map((m) => (m.user.id === me.user.id ? 'You' : m.user.displayName))
              .join(', ') +
            (conversation.memberCount > 6 ? ` and ${conversation.memberCount - 6} more` : '');

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <section
        aria-label={`Chat with ${conversation.title}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header className="flex h-[60px] shrink-0 items-center gap-1 border-l border-wa-divider bg-wa-panel px-2 sm:px-4">
          <button
            type="button"
            aria-label="Back to chats"
            title="Back to chats"
            className={cx(HEADER_ICON, 'lg:hidden')}
            onClick={onBack}
          >
            <ArrowLeft className="size-6" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            title={conversation.type === 'DIRECT' ? 'Contact info' : 'Group info'}
            className="flex h-full min-w-0 flex-1 items-center gap-3 text-left"
          >
            <Avatar
              name={conversation.title}
              size={40}
              online={
                conversation.type === 'DIRECT' ? (counterpartPresence?.online ?? false) : undefined
              }
            />
            <span className="min-w-0">
              <span className="block truncate text-[1rem] font-medium">{conversation.title}</span>
              <span
                className={cx(
                  'block truncate text-[0.8rem]',
                  typers.length > 0 ? 'text-brand' : 'text-wa-meta-in',
                )}
                aria-live="polite"
              >
                {subtitle}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Search in chat"
            title="Search"
            className={HEADER_ICON}
            onClick={() => setSearching(true)}
          >
            <Search className="size-5" aria-hidden />
          </button>
          <ChatMenu
            items={[
              {
                label: muted ? 'Unmute notifications' : 'Mute notifications',
                Icon: muted ? Bell : BellOff,
                onSelect: () => myState.mutate({ mutedUntil: muted ? null : MUTE_FOREVER }),
              },
              {
                label: conversation.me.pinnedAt ? 'Unpin chat' : 'Pin chat to top',
                Icon: conversation.me.pinnedAt ? PinOff : Pin,
                onSelect: () => myState.mutate({ pinned: !conversation.me.pinnedAt }),
              },
              {
                label: conversation.me.archivedAt ? 'Move out of archive' : 'Archive chat',
                Icon: conversation.me.archivedAt ? ArchiveRestore : Archive,
                onSelect: () => myState.mutate({ archived: !conversation.me.archivedAt }),
              },
              {
                label: 'Mark as unread',
                Icon: MailWarning,
                onSelect: () => myState.mutate({ markedUnread: true }),
              },
              {
                label: conversation.type === 'DIRECT' ? 'Contact info' : 'Group info',
                Icon: Info,
                onSelect: () => setInfoOpen(true),
              },
            ]}
          />
        </header>
        {conversation.type === 'BROADCAST' && me.user.kind === 'EXTERNAL' && (
          <AnnouncementOptOut businessId={conversation.businessId} />
        )}
        {conversation.type === 'EMERGENCY' && (
          <Link
            href={`/emergency?conversation=${conversation.id}`}
            className="flex min-h-11 shrink-0 items-center gap-2 border-b border-danger/30 bg-danger-surface px-4 py-2 text-sm font-semibold text-danger sm:px-5"
          >
            <Siren className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Emergency conversation — status, who was alerted and the timeline
            </span>
            <span className="shrink-0 underline">View incident</span>
          </Link>
        )}
        {myState.isError && (
          <div className="p-2">
            <Alert tone="error">{errorMessage(myState.error)}</Alert>
          </div>
        )}
        {action.isError && (
          <div className="p-2">
            <Alert tone="error">{errorMessage(action.error)}</Alert>
          </div>
        )}

        <MessageList
          conversation={conversation}
          messages={messages.data.items}
          hasMoreBefore={messages.data.hasMoreBefore}
          loadingOlder={loadOlder.isPending}
          onLoadOlder={() => loadOlder.mutate()}
          myId={me.user.id}
          nameOf={nameOf}
          actions={actions}
          canModerate={canModerate}
          firstUnreadSeq={unreadMarker.current?.seq ?? null}
        />

        <UploadTray items={uploads.items} onCancel={uploads.cancel} onRetry={uploads.retry} />
        <Composer
          conversationId={conversationId}
          canShareFiles={conversation.me.canShareFiles}
          onSendFile={(file, caption) => uploads.send(file, caption)}
          disabledReason={
            conversation.me.canPost
              ? null
              : conversation.type === 'BROADCAST'
                ? 'Announcements are one-way. Replies are turned off.'
                : conversation.postingPolicy === 'ADMINS_ONLY'
                  ? 'Only group admins can send messages in this group.'
                  : 'You cannot send messages in this chat.'
          }
          replyTo={replyTo}
          editing={editing}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => setEditing(null)}
          onSend={(body) => {
            send(body, replyTo);
            setReplyTo(null);
          }}
          onSaveEdit={(body) => {
            if (editing) action.mutate({ message: editing, kind: 'edit', value: body });
            setEditing(null);
          }}
        />

        <ConfirmDialog
          open={!!deleting}
          title="Delete message?"
          message="This message will be deleted for everyone in the chat."
          confirmLabel="Delete for everyone"
          danger
          busy={action.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting)
              action.mutate(
                { message: deleting, kind: 'delete' },
                { onSettled: () => setDeleting(null) },
              );
          }}
        />
        <ForwardDialog message={forwarding} onClose={() => setForwarding(null)} />
        <MessageInfoDialog message={infoFor} onClose={() => setInfoFor(null)} />
        <ChatSearchDialog
          open={searching}
          conversationId={conversationId}
          onClose={() => setSearching(false)}
        />
      </section>
      {/* WhatsApp Web-style info panel: beside the chat on large screens, over it on smaller ones. */}
      {infoOpen && (
        <div className="absolute inset-0 z-20 lg:static lg:w-[38%] lg:max-w-[460px] lg:min-w-[340px] lg:shrink-0">
          <ChatInfoPanel
            conversation={conversation}
            canManage={canManage}
            onClose={() => setInfoOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function ChatSearchDialog({
  open,
  conversationId,
  onClose,
}: {
  open: boolean;
  conversationId: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['search', conversationId, q],
    queryFn: () => api<Page<SearchResultDto>>('/search/messages', { query: { q, conversationId } }),
    enabled: open && q.trim().length >= 2,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Search in chat">
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <span className="sr-only">Search messages</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type at least 2 letters"
            className="min-h-12 w-full rounded-xl border border-line bg-surface-2 pr-10 pl-10"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              onClick={() => setQ('')}
            >
              <X className="size-5" aria-hidden />
            </button>
          )}
        </label>
        {search.isFetching && <Spinner label="Searching" />}
        {search.isError && <Alert tone="error">{errorMessage(search.error)}</Alert>}
        {search.data?.items.length === 0 && <p className="text-muted">No messages found.</p>}
        <ul className="flex flex-col gap-2">
          {search.data?.items.map((r) => (
            <li key={r.message.id} className="rounded-xl border border-line p-3">
              <p className="text-sm font-bold text-brand">
                {r.message.sender.displayName} · {formatTime(r.message.createdAt)} ·{' '}
                {new Date(r.message.createdAt).toLocaleDateString()}
              </p>
              <p className="whitespace-pre-wrap">{r.message.body}</p>
            </li>
          ))}
        </ul>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function ChatMenu({
  items,
}: {
  items: Array<{ label: string; Icon: typeof Info; onSelect: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="More options"
        title="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx(HEADER_ICON, open && 'bg-wa-active')}
      >
        <MoreVertical className="size-5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg bg-surface py-2 shadow-pop"
        >
          {items.map(({ label, Icon, onSelect }, index) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
              className="flex min-h-11 w-full items-center gap-3 px-5 text-left hover:bg-wa-hover"
            >
              <Icon className="size-5 text-wa-icon" aria-hidden /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Customers can stop announcements from a business (staff cannot). */
function AnnouncementOptOut({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const key = ['announcement-opt-out', businessId];
  const status = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ optedOut: boolean; canOptOut: boolean }>(
        `/businesses/${businessId}/announcements/opt-out`,
      ),
  });
  const toggle = useMutation({
    mutationFn: (optOut: boolean) =>
      api<{ optedOut: boolean; canOptOut: boolean }>(
        `/businesses/${businessId}/announcements/opt-out`,
        { method: 'PUT', body: { optOut } },
      ),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  if (!status.data?.canOptOut) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-wa-divider bg-wa-panel px-4 py-2 text-sm sm:px-5">
      <span className="min-w-0 flex-1">
        {status.data.optedOut
          ? 'You will not receive new announcements from this business.'
          : 'You receive announcements from this business.'}
      </span>
      <Button
        size="sm"
        variant="secondary"
        busy={toggle.isPending}
        onClick={() => toggle.mutate(!status.data!.optedOut)}
      >
        {status.data.optedOut ? 'Turn announcements on' : 'Stop announcements'}
      </Button>
    </div>
  );
}
