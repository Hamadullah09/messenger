'use client';

import type { ConversationSummaryDto, PresenceDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  BellOff,
  Check,
  CheckCheck,
  MessageSquarePlus,
  MessagesSquare,
  Pin,
  Search,
  Megaphone,
  Siren,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { sortConversations } from '@/lib/chat-cache';
import { useConversations } from '@/lib/chat-hooks';
import { formatRelativeShort, messagePreview } from '@/lib/format';
import { activeTypers, useLive } from '@/lib/live-store';
import { EmergencyButton } from '../emergency/raise-alert';
import { NotificationBanner } from './notification-banner';
import { Alert, Avatar, Button, cx, EmptyState, Spinner } from '../ui';

type Filter = 'all' | 'unread' | 'groups' | 'archived';

const STATUS_ICON = {
  SENT: { Icon: Check, label: 'Sent', cls: 'text-muted' },
  DELIVERED: { Icon: CheckCheck, label: 'Delivered', cls: 'text-muted' },
  READ: { Icon: CheckCheck, label: 'Read', cls: 'text-wa-read' },
} as const;

export function ConversationList({
  selectedId,
  onSelect,
  onNewChat,
  onNewGroup,
  onNewBroadcast,
  canCreateGroup,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onNewBroadcast?: () => void;
  canCreateGroup: boolean;
}) {
  const { data, isPending, isLoading, isError, refetch } = useConversations();
  const activeBusinessId = useAuth((s) => s.activeBusinessId);
  const myId = useAuth((s) => s.me?.user.id);
  const typing = useLive((s) => s.typing);
  const presence = useLive((s) => s.presence);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) =>
      !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const inWorkspace = useMemo(
    () =>
      sortConversations(data ?? []).filter(
        (c) => !activeBusinessId || c.businessId === activeBusinessId,
      ),
    [data, activeBusinessId],
  );

  // Presence dots for the people in direct chats (only visible to those who share a chat).
  const counterpartIds = useMemo(
    () =>
      [...new Set(inWorkspace.flatMap((c) => (c.counterpart ? [c.counterpart.id] : [])))].slice(
        0,
        100,
      ),
    [inWorkspace],
  );
  useQuery({
    queryKey: ['presence', counterpartIds.join(',')],
    queryFn: async () => {
      const result = await api<PresenceDto[]>('/presence', {
        query: { userIds: counterpartIds.join(',') },
      });
      for (const p of result) useLive.getState().setPresence(p.userId, p.online, p.lastSeenAt);
      return result;
    },
    enabled: counterpartIds.length > 0,
    staleTime: 60_000,
  });

  const counts = useMemo(
    () => ({
      all: inWorkspace.filter((c) => !c.me.archivedAt).length,
      unread: inWorkspace.filter((c) => !c.me.archivedAt && c.unreadCount > 0).length,
      groups: inWorkspace.filter((c) => !c.me.archivedAt && c.type !== 'DIRECT').length,
      archived: inWorkspace.filter((c) => c.me.archivedAt).length,
    }),
    [inWorkspace],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inWorkspace.filter((c) => {
      if (filter === 'archived' ? !c.me.archivedAt : c.me.archivedAt) return false;
      if (filter === 'unread' && c.unreadCount === 0) return false;
      if (filter === 'groups' && c.type === 'DIRECT') return false;
      return !q || c.title.toLowerCase().includes(q);
    });
  }, [inWorkspace, filter, query]);

  const tabs: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: counts.unread ? `Unread ${counts.unread}` : 'Unread' },
    { key: 'groups', label: 'Groups' },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-1 flex-col bg-wa-list">
      <header className="flex h-16 shrink-0 items-center gap-1 px-4">
        <h1 className="flex-1 text-[1.4rem] font-bold tracking-tight">
          <span className="text-brand md:hidden">SMA</span>
          <span className="hidden md:inline">Chats</span>
        </h1>
        <span className="md:hidden">
          <EmergencyButton round />
        </span>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="Start a new conversation"
            title="New chat"
            className="inline-flex size-10 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
          >
            <MessageSquarePlus className="size-6" aria-hidden />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute top-full right-0 z-30 mt-1 w-56 rounded-lg bg-surface py-2 shadow-pop"
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setMenuOpen(false);
                  onNewChat();
                }}
                className="flex min-h-11 w-full items-center gap-3 px-5 text-left hover:bg-wa-hover"
              >
                <MessageSquarePlus className="size-5 text-wa-icon" aria-hidden /> New chat
              </button>
              {canCreateGroup && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onNewGroup();
                  }}
                  className="flex min-h-11 w-full items-center gap-3 px-5 text-left hover:bg-wa-hover"
                >
                  <Users className="size-5 text-wa-icon" aria-hidden /> New group
                </button>
              )}
              {onNewBroadcast && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onNewBroadcast();
                  }}
                  className="flex min-h-11 w-full items-center gap-3 px-5 text-left hover:bg-wa-hover"
                >
                  <Megaphone className="size-5 text-wa-icon" aria-hidden /> New broadcast list
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setFilter('archived');
                }}
                className="flex min-h-11 w-full items-center gap-3 px-5 text-left hover:bg-wa-hover"
              >
                <Archive className="size-5 text-wa-icon" aria-hidden /> Archived chats
              </button>
            </div>
          )}
        </div>
      </header>

      <NotificationBanner />

      <div className="shrink-0 px-3 pb-2">
        <label className="relative block">
          <span className="sr-only">Search chats by name</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-wa-icon"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search or start a new chat"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            className="h-10 w-full rounded-lg bg-wa-panel pr-10 pl-12 text-[0.95rem] placeholder:text-wa-icon wa-field"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </label>
      </div>

      <div
        role="tablist"
        aria-label="Filter chats"
        className="scroll-thin flex shrink-0 gap-2 overflow-x-auto px-3 pb-2"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={filter === t.key}
            onClick={() => setFilter(t.key)}
            className={cx(
              'h-8 shrink-0 rounded-full px-3 text-sm whitespace-nowrap transition-colors',
              filter === t.key
                ? 'bg-brand-soft font-semibold text-brand-strong'
                : 'bg-wa-panel text-wa-chip-text hover:bg-wa-active',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Spinner label="Loading chats" />}
        {isError && (
          <div className="p-4">
            <Alert tone="error" title="Chats could not be loaded">
              <Button variant="secondary" onClick={() => void refetch()}>
                Try again
              </Button>
            </Alert>
          </div>
        )}
        {!isPending && !isError && visible.length === 0 && (
          <EmptyState
            icon={<MessagesSquare className="size-9" aria-hidden />}
            title={filter === 'all' && !query ? 'No chats yet' : 'Nothing here'}
          >
            {filter === 'all' && !query
              ? 'Start a new chat with the button above.'
              : 'Try another filter or search.'}
          </EmptyState>
        )}
        <ul>
          {visible.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={onSelect}
              myId={myId}
              typers={activeTypers(typing, c.id)}
              online={c.counterpart ? presence[c.counterpart.id]?.online : undefined}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ConversationRow({
  conversation: c,
  selected,
  onSelect,
  myId,
  typers,
  online,
}: {
  conversation: ConversationSummaryDto;
  selected: boolean;
  onSelect: (id: string) => void;
  myId?: string;
  typers: string[];
  online?: boolean;
}) {
  const muted = c.me.mutedUntil !== null && new Date(c.me.mutedUntil) > new Date();
  const preview =
    typers.length > 0
      ? `${typers[0]} is typing…`
      : messagePreview(c.lastMessage, () => 'Someone', myId);
  const status =
    c.lastMessageStatus && typers.length === 0 ? STATUS_ICON[c.lastMessageStatus] : null;
  const unread = c.unreadCount > 0 || c.me.markedUnread;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex h-[72px] w-full items-center gap-3 pl-3 text-left transition-colors',
          selected ? 'bg-wa-active' : 'hover:bg-wa-hover',
        )}
      >
        {c.type === 'BROADCAST' || c.type === 'BROADCAST_LIST' ? (
          <span
            className="inline-flex size-[49px] shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"
            aria-hidden
          >
            <Megaphone className="size-6" />
          </span>
        ) : c.type === 'EMERGENCY' ? (
          <span
            className="inline-flex size-[49px] shrink-0 items-center justify-center rounded-full bg-danger text-danger-contrast"
            aria-hidden
          >
            <Siren className="size-6" />
          </span>
        ) : (
          <Avatar name={c.title} size={49} online={online} />
        )}
        <span className="flex h-full min-w-0 flex-1 flex-col justify-center gap-0.5 border-b border-wa-divider pr-4">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[1.03rem]">{c.title}</span>
            <span
              className={cx(
                'ml-auto shrink-0 text-xs',
                unread ? 'font-semibold text-brand' : 'text-wa-meta-in',
              )}
            >
              {formatRelativeShort(c.lastActivityAt)}
            </span>
          </span>
          <span className="flex items-center gap-1">
            {status && (
              <status.Icon
                className={cx('size-[18px] shrink-0', status.cls)}
                aria-label={status.label}
              />
            )}
            <span
              className={cx(
                'truncate text-sm',
                typers.length > 0 ? 'font-semibold text-brand' : 'text-wa-meta-in',
              )}
            >
              {preview}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-wa-meta-in">
              {muted && <BellOff className="size-4" aria-label="Muted" />}
              {c.me.pinnedAt && <Pin className="size-4" aria-label="Pinned" />}
              {c.me.archivedAt && <Archive className="size-4" aria-label="Archived" />}
              {unread && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-bold text-brand-contrast">
                  {c.unreadCount > 0 ? (c.unreadCount > 99 ? '99+' : c.unreadCount) : ''}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
