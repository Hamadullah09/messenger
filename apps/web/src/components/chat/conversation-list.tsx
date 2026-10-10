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
  Plus,
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
import { Alert, Avatar, Button, cx, EmptyState, IconButton, Spinner } from '../ui';

type Filter = 'all' | 'unread' | 'groups' | 'archived';

const STATUS_ICON = {
  SENT: { Icon: Check, label: 'Sent', cls: 'text-muted' },
  DELIVERED: { Icon: CheckCheck, label: 'Delivered', cls: 'text-muted' },
  READ: { Icon: CheckCheck, label: 'Read', cls: 'text-brand' },
} as const;

export function ConversationList({
  selectedId,
  onSelect,
  onNewChat,
  onNewGroup,
  canCreateGroup,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  canCreateGroup: boolean;
}) {
  const { data, isPending, isLoading, isError, refetch } = useConversations();
  const activeBusinessId = useAuth((s) => s.activeBusinessId);
  const myId = useAuth((s) => s.me?.user.id);
  const typing = useLive((s) => s.typing);
  const presence = useLive((s) => s.presence);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

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
    { key: 'all', label: `All (${counts.all})` },
    { key: 'unread', label: `Unread (${counts.unread})` },
    { key: 'groups', label: 'Groups' },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
          <p className="text-muted">Check out your conversations</p>
        </div>
        <div className="flex gap-2">
          <IconButton
            label="Search chats"
            bordered
            onClick={() => setSearching((v) => !v)}
            aria-pressed={searching}
          >
            <Search className="size-5" aria-hidden />
          </IconButton>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Start a new conversation"
              title="Start a new conversation"
              className="inline-flex size-11 items-center justify-center rounded-xl bg-brand text-brand-contrast shadow-card hover:bg-brand-strong"
            >
              <Plus className="size-6" aria-hidden />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute top-full right-0 z-30 mt-2 w-60 rounded-2xl border border-line bg-surface p-2 shadow-pop"
              >
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    setMenuOpen(false);
                    onNewChat();
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left font-semibold hover:bg-surface-2"
                >
                  <MessageSquarePlus className="size-5 text-brand" aria-hidden /> New chat
                </button>
                {canCreateGroup && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewGroup();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left font-semibold hover:bg-surface-2"
                  >
                    <Users className="size-5 text-brand" aria-hidden /> New group
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {searching && (
        <div className="px-5 pb-3">
          <label className="relative block">
            <span className="sr-only">Search chats by name</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearching(false);
                }
              }}
              className="min-h-12 w-full rounded-xl border border-line-strong/60 bg-surface pr-11 pl-11 focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/20"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg hover:bg-surface-2"
              >
                <X className="size-5" aria-hidden />
              </button>
            )}
          </label>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Filter chats"
        className="scroll-thin flex shrink-0 overflow-x-auto border-b border-line px-2"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={filter === t.key}
            onClick={() => setFilter(t.key)}
            className={cx(
              'relative min-h-12 flex-1 px-3 text-sm font-semibold whitespace-nowrap transition-colors',
              filter === t.key ? 'text-brand' : 'text-muted hover:text-fg',
            )}
          >
            {t.label}
            {filter === t.key && (
              <span
                className="absolute right-2 bottom-0 left-2 h-0.5 rounded-full bg-brand"
                aria-hidden
              />
            )}
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
              ? 'Press the + button to message a colleague.'
              : 'Try another tab or search.'}
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
  const status = c.lastMessageStatus ? STATUS_ICON[c.lastMessageStatus] : null;
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'relative flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors',
          selected ? 'bg-brand-soft' : 'hover:bg-surface-2',
        )}
      >
        {selected && <span className="absolute top-0 bottom-0 left-0 w-1 bg-brand" aria-hidden />}
        {c.type === 'BROADCAST' ? (
          <span
            className="inline-flex size-[52px] shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"
            aria-hidden
          >
            <Megaphone className="size-6" />
          </span>
        ) : c.type === 'EMERGENCY' ? (
          <span
            className="inline-flex size-[52px] shrink-0 items-center justify-center rounded-full bg-danger text-danger-contrast"
            aria-hidden
          >
            <Siren className="size-6" />
          </span>
        ) : (
          <Avatar name={c.title} size={52} online={online} />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{c.title}</span>
            <span
              className={cx(
                'ml-auto shrink-0 text-xs',
                c.unreadCount > 0 ? 'font-bold text-brand' : 'text-muted',
              )}
            >
              {formatRelativeShort(c.lastActivityAt)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span
              className={cx(
                'truncate text-[0.95rem]',
                typers.length > 0 ? 'font-semibold text-brand' : 'text-muted',
              )}
            >
              {preview}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted">
              {c.me.pinnedAt && <Pin className="size-4" aria-label="Pinned" />}
              {muted && <BellOff className="size-4" aria-label="Muted" />}
              {c.me.archivedAt && <Archive className="size-4" aria-label="Archived" />}
              {c.unreadCount > 0 ? (
                <span className="inline-flex min-w-7 items-center justify-center rounded-lg bg-brand px-1.5 py-0.5 text-xs font-bold text-brand-contrast">
                  {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  <span className="sr-only"> unread</span>
                </span>
              ) : (
                status && (
                  <status.Icon className={cx('size-5', status.cls)} aria-label={status.label} />
                )
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
