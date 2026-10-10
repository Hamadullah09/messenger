'use client';

import type { ConversationSummaryDto } from '@storeline/shared';
import {
  Bell,
  ChevronDown,
  HelpCircle,
  LogOut,
  Menu,
  Search,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { logout } from '@/lib/api';
import { primaryRoleName, useAuth } from '@/lib/auth-store';
import { formatRelativeShort, messagePreview } from '@/lib/format';
import { useLive } from '@/lib/live-store';
import { Avatar, cx, EmptyState, IconButton } from '../ui';
import { BRAND, BrandMark } from '../brand';
import { EmergencyButton } from '../emergency/raise-alert';

/** Small popover anchored to a trigger; closes on outside click and Escape. */
function Popover({
  trigger,
  label,
  children,
  align = 'right',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
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
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cx(
            'absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface p-2 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function SearchBox({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-xl">
      <label className="relative block">
        <span className="sr-only">Search messages and people</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages and files…"
          className="min-h-12 w-full rounded-xl border border-line bg-surface-2 pr-28 pl-11 text-fg placeholder:text-muted focus:border-brand focus:bg-surface focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/20"
        />
      </label>
      <span
        className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-1 text-xs text-muted lg:flex"
        aria-hidden
      >
        <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans">Ctrl</kbd>
        +<kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans">K</kbd>
      </span>
    </form>
  );
}

export function Topbar({
  onOpenMenu,
  unreadConversations,
}: {
  onOpenMenu: () => void;
  unreadConversations: ConversationSummaryDto[];
}) {
  const router = useRouter();
  const me = useAuth((s) => s.me)!;
  const { activeBusinessId, setActiveBusiness } = useAuth();
  const connected = useLive((s) => s.connected);
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd + K jumps to search (on small screens it opens the search page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (searchRef.current && searchRef.current.offsetParent !== null) searchRef.current.focus();
        else router.push('/search');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <header className="flex min-h-16 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3 sm:px-5">
      <IconButton label="Open menu" className="md:hidden" onClick={onOpenMenu}>
        <Menu className="size-6" aria-hidden />
      </IconButton>
      <Link href="/dashboard" className="md:hidden" aria-label={`${BRAND.company} home`}>
        <BrandMark compact size={40} />
      </Link>

      <div className="hidden flex-1 sm:block">
        <SearchBox inputRef={searchRef} />
      </div>
      <div className="flex-1 sm:hidden" />

      {me.businesses.length > 1 && (
        <label className="hidden lg:block">
          <span className="sr-only">Workspace</span>
          <select
            className="min-h-11 max-w-56 rounded-xl border border-line-strong/60 bg-surface px-3 font-semibold"
            value={activeBusinessId ?? ''}
            onChange={(e) => setActiveBusiness(e.target.value)}
          >
            {me.businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <span
        role="status"
        className={cx(
          'hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold md:flex',
          connected ? 'bg-success-soft text-success' : 'bg-warning-surface text-warning',
        )}
      >
        {connected ? (
          <Wifi className="size-4" aria-hidden />
        ) : (
          <WifiOff className="size-4" aria-hidden />
        )}
        {connected ? 'Online' : 'Reconnecting…'}
      </span>
      {!connected && (
        <span role="status" className="md:hidden" title="Reconnecting…">
          <WifiOff className="size-5 text-warning" aria-label="Reconnecting" />
        </span>
      )}

      <span className="sm:hidden">
        <EmergencyButton compact />
      </span>
      <span className="hidden sm:inline-flex">
        <EmergencyButton />
      </span>

      <IconButton
        label="Search"
        bordered
        className="sm:hidden"
        onClick={() => router.push('/search')}
      >
        <Search className="size-5" aria-hidden />
      </IconButton>

      <Popover
        label="Unread messages"
        trigger={({ open, toggle }) => (
          <IconButton
            label={
              unreadConversations.length
                ? `Unread messages: ${unreadConversations.length} chats`
                : 'No unread messages'
            }
            bordered
            aria-expanded={open}
            onClick={toggle}
            className="relative"
          >
            <Bell className="size-5" aria-hidden />
            {unreadConversations.length > 0 && (
              <span className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-full bg-warm-strong px-1 text-xs font-bold text-warm-contrast">
                {unreadConversations.length > 9 ? '9+' : unreadConversations.length}
              </span>
            )}
          </IconButton>
        )}
      >
        {(close) => (
          <div>
            <p className="px-3 pt-2 pb-1 font-bold">Unread messages</p>
            {unreadConversations.length === 0 ? (
              <EmptyState title="You’re all caught up">New messages will show here.</EmptyState>
            ) : (
              <ul className="scroll-thin max-h-96 overflow-y-auto">
                {unreadConversations.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/chats?c=${c.id}`}
                      onClick={close}
                      className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2"
                    >
                      <Avatar name={c.title} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-semibold">{c.title}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted">
                            {formatRelativeShort(c.lastActivityAt)}
                          </span>
                        </span>
                        <span className="block truncate text-sm text-muted">
                          {messagePreview(c.lastMessage, () => 'Someone', me.user.id)}
                        </span>
                      </span>
                      <span className="rounded-lg bg-brand px-1.5 py-0.5 text-xs font-bold text-brand-contrast">
                        {c.unreadCount}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/chats"
              onClick={close}
              className="mt-1 block rounded-xl p-2 text-center font-semibold text-brand hover:bg-surface-2"
            >
              Open messages
            </Link>
          </div>
        )}
      </Popover>

      <Popover
        label="Your account"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="flex min-h-11 items-center gap-3 rounded-xl px-1.5 hover:bg-surface-2 sm:pr-3"
          >
            <Avatar name={me.user.displayName} size={40} />
            <span className="hidden text-left leading-tight lg:block">
              <span className="block max-w-40 truncate font-semibold">{me.user.displayName}</span>
              <span className="block max-w-40 truncate text-sm text-muted">
                {primaryRoleName(me, activeBusinessId)}
              </span>
            </span>
            <ChevronDown className="hidden size-4 text-muted lg:block" aria-hidden />
          </button>
        )}
      >
        {(close) => (
          <div className="flex flex-col">
            <div className="flex items-center gap-3 p-3">
              <Avatar name={me.user.displayName} size={48} />
              <div className="min-w-0">
                <p className="truncate font-bold">{me.user.displayName}</p>
                <p className="truncate text-sm text-muted">
                  @{me.user.username} · {primaryRoleName(me, activeBusinessId)}
                </p>
              </div>
            </div>
            {me.businesses.length > 1 && (
              <label className="px-3 pb-2 lg:hidden">
                <span className="mb-1 block text-sm font-semibold">Workspace</span>
                <select
                  className="min-h-11 w-full rounded-xl border border-line-strong/60 bg-surface px-3 font-semibold"
                  value={activeBusinessId ?? ''}
                  onChange={(e) => setActiveBusiness(e.target.value)}
                >
                  {me.businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <hr className="my-1 border-line" />
            <Link
              href="/settings"
              onClick={close}
              className="flex min-h-12 items-center gap-3 rounded-xl px-3 hover:bg-surface-2"
            >
              <Settings className="size-5" aria-hidden /> Settings & privacy
            </Link>
            <Link
              href="/help"
              onClick={close}
              className="flex min-h-12 items-center gap-3 rounded-xl px-3 hover:bg-surface-2"
            >
              <HelpCircle className="size-5" aria-hidden /> Help
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-left text-danger hover:bg-danger-surface"
            >
              <LogOut className="size-5" aria-hidden /> Sign out
            </button>
          </div>
        )}
      </Popover>
    </header>
  );
}
