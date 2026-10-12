'use client';

import type { AuditLogDto, BusinessDto, Page, SessionDto, StoreDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BellRing,
  Building2,
  HelpCircle,
  Laptop,
  MessageCircle,
  MessageSquarePlus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Store,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { NewChatDialog, NewGroupDialog } from '@/components/chat/dialogs';
import {
  BusinessDashboard,
  dashboardKind,
  StoreManagerDashboard,
} from '@/components/manage/dashboards';
import { Avatar, Card, cx, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { hasPermission, isPlatformAdmin, useAuth } from '@/lib/auth-store';
import { sortConversations } from '@/lib/chat-cache';
import { useConversations } from '@/lib/chat-hooks';
import { formatRelativeShort, messagePreview } from '@/lib/format';
import { useLive } from '@/lib/live-store';
import { useRouter } from 'next/navigation';

function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function StatTile({
  label,
  value,
  Icon,
  href,
  hint,
  tone = 'brand',
}: {
  label: string;
  value: ReactNode;
  Icon: LucideIcon;
  href?: string;
  hint?: string;
  tone?: 'brand' | 'warm' | 'success';
}) {
  const tones = {
    brand: 'bg-brand-soft text-brand-strong',
    warm: 'bg-warm-soft text-warm-strong',
    success: 'bg-success-soft text-success',
  };
  const body = (
    <>
      <span
        className={cx('inline-flex size-12 items-center justify-center rounded-2xl', tones[tone])}
      >
        <Icon className="size-6" aria-hidden />
      </span>
      <span className="mt-4 block text-sm font-medium text-muted">{label}</span>
      <span className="mt-1 block text-3xl font-bold tracking-tight">{value}</span>
      {hint && <span className="mt-1 block text-sm text-muted">{hint}</span>}
      {href && (
        <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand">
          Open <ArrowRight className="size-4" aria-hidden />
        </span>
      )}
    </>
  );
  const cls = 'block h-full rounded-3xl border border-line bg-surface p-5 shadow-card';
  return href ? (
    <Link href={href} className={cx(cls, 'transition-colors hover:border-brand/50')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const me = useAuth((s) => s.me)!;
  const businessId = useAuth((s) => s.activeBusinessId);
  const conversations = useConversations();
  const presence = useLive((s) => s.presence);
  const [newChat, setNewChat] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const now = new Date();
  const business = me.businesses.find((b) => b.id === businessId);

  const isAdmin = isPlatformAdmin(me) || hasPermission(me, 'user.create', businessId);
  const managed = dashboardKind(me, businessId);
  const canAudit =
    !!businessId && hasPermission(me, 'audit.read', businessId) && me.session.mfaVerified;

  const list = useMemo(
    () =>
      sortConversations(conversations.data ?? []).filter(
        (c) => !businessId || c.businessId === businessId,
      ),
    [conversations.data, businessId],
  );
  const active = list.filter((c) => !c.me.archivedAt);
  const unread = active.filter((c) => c.unreadCount > 0);
  const groups = active.filter((c) => c.type !== 'DIRECT');
  const onlineColleagues = new Set(
    active.flatMap((c) =>
      c.counterpart && presence[c.counterpart.id]?.online ? [c.counterpart.id] : [],
    ),
  ).size;

  const businessInfo = useQuery({
    queryKey: ['business', businessId],
    queryFn: () => api<BusinessDto>(`/businesses/${businessId}`),
    enabled: !!businessId && isAdmin,
  });
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
    enabled: !!businessId,
  });
  const audit = useQuery({
    queryKey: ['audit-recent', businessId],
    queryFn: () => api<Page<AuditLogDto>>('/audit', { query: { businessId, limit: 6 } }),
    enabled: canAudit,
  });
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionDto[]>('/me/sessions'),
  });

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
        {/* Hero: date, greeting and the most common actions */}
        <section className="flex flex-col gap-5 rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-7 lg:flex-row lg:items-center">
          <div className="flex items-center gap-4">
            <div className="flex size-20 shrink-0 flex-col items-center justify-center rounded-full border border-line bg-surface-2">
              <span className="text-3xl leading-none font-bold">{now.getDate()}</span>
            </div>
            <div className="leading-tight">
              <p className="font-semibold">
                {now.toLocaleDateString(undefined, { weekday: 'long' })},
              </p>
              <p className="text-muted">
                {now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </p>
            </div>
          </div>
          <div className="hidden h-14 w-px bg-line lg:block" aria-hidden />
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {greeting(now)}, {me.user.displayName.split(' ')[0]} <span aria-hidden>👋</span>
            </h1>
            <p className="mt-1 text-lg text-muted">
              {unread.length > 0
                ? `You have ${unread.length} chat${unread.length === 1 ? '' : 's'} with new messages.`
                : 'You’re all caught up.'}
              {business ? ` · ${business.name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/chats"
              className="inline-flex min-h-12 items-center gap-2 rounded-full bg-warm-strong px-5 font-semibold text-warm-contrast shadow-card hover:opacity-90"
            >
              Open messages <ArrowRight className="size-5" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={() => setNewChat(true)}
              className="inline-flex min-h-12 items-center gap-2 rounded-full border border-line-strong/60 bg-surface px-5 font-semibold hover:bg-surface-2"
            >
              <MessageSquarePlus className="size-5" aria-hidden /> New chat
            </button>
          </div>
        </section>

        {/* Role dashboards: business owners/admins/managers, and store managers */}
        {managed?.kind === 'business' && businessId && (
          <BusinessDashboard businessId={businessId} role={managed.role} />
        )}
        {managed?.kind === 'store' && businessId && (
          <StoreManagerDashboard businessId={businessId} storeIds={managed.storeIds} />
        )}

        {/* Key numbers */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label="Chats with new messages"
            value={conversations.isPending ? '…' : unread.length}
            Icon={BellRing}
            tone="warm"
            href="/chats"
          />
          <StatTile
            label="Conversations"
            value={conversations.isPending ? '…' : active.length}
            Icon={MessageCircle}
          />
          <StatTile
            label="Groups"
            value={conversations.isPending ? '…' : groups.length}
            Icon={Users}
          />
          {isAdmin && businessInfo.data ? (
            <StatTile
              label="People in business"
              value={businessInfo.data.memberCount}
              hint={`${businessInfo.data.storeCount} stores`}
              Icon={UserRound}
              tone="success"
              href="/admin?tab=people"
            />
          ) : (
            <StatTile
              label="Colleagues online"
              value={onlineColleagues}
              hint="People you chat with directly"
              Icon={UserRound}
              tone="success"
            />
          )}
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Recent conversations */}
          <Card className="lg:col-span-2" aria-labelledby="recent-title">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 id="recent-title" className="text-xl font-bold">
                Recent conversations
              </h2>
              <Link
                href="/chats"
                className="rounded-lg px-2 py-1 font-semibold text-brand hover:bg-brand-soft"
              >
                See all
              </Link>
            </div>
            {conversations.isLoading && <Spinner label="Loading chats" />}
            {!conversations.isPending && active.length === 0 && (
              <EmptyState
                icon={<MessageCircle className="size-9" aria-hidden />}
                title="No conversations yet"
              >
                Start a chat with a colleague to see it here.
              </EmptyState>
            )}
            <ul className="divide-y divide-line">
              {active.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/chats?c=${c.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 hover:bg-surface-2"
                  >
                    <Avatar
                      name={c.title}
                      size={46}
                      online={
                        c.counterpart ? (presence[c.counterpart.id]?.online ?? false) : undefined
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-semibold">{c.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted">
                          {formatRelativeShort(c.lastActivityAt)}
                        </span>
                      </span>
                      <span className="block truncate text-muted">
                        {messagePreview(c.lastMessage, () => 'Someone', me.user.id)}
                      </span>
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="rounded-lg bg-brand px-2 py-0.5 text-xs font-bold text-brand-contrast">
                        {c.unreadCount}
                        <span className="sr-only"> unread</span>
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {/* Quick actions */}
          <Card aria-labelledby="actions-title">
            <h2 id="actions-title" className="mb-3 text-xl font-bold">
              Quick actions
            </h2>
            <div className="grid gap-2">
              <QuickAction
                Icon={MessageSquarePlus}
                label="Start a chat"
                onClick={() => setNewChat(true)}
              />
              {hasPermission(me, 'group.create', businessId) && (
                <QuickAction
                  Icon={Users}
                  label="Create a group"
                  onClick={() => setNewGroup(true)}
                />
              )}
              <QuickAction
                Icon={Search}
                label="Search messages"
                onClick={() => router.push('/search')}
              />
              <QuickAction
                Icon={HelpCircle}
                label="How to use SMA"
                onClick={() => router.push('/help')}
              />
            </div>
          </Card>
        </div>

        <div
          className={cx('grid grid-cols-1 gap-5', managed ? 'lg:grid-cols-2' : 'lg:grid-cols-3')}
        >
          {/* Account security */}
          <Card aria-labelledby="security-title">
            <h2 id="security-title" className="mb-3 text-xl font-bold">
              Account security
            </h2>
            <div className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4">
              {me.mfaEnabled ? (
                <ShieldCheck className="size-7 shrink-0 text-success" aria-hidden />
              ) : (
                <ShieldAlert className="size-7 shrink-0 text-warning" aria-hidden />
              )}
              <div>
                <p className="font-semibold">
                  Two-step verification is {me.mfaEnabled ? 'on' : 'off'}
                </p>
                <p className="text-sm text-muted">
                  {me.mfaEnabled
                    ? 'Your account asks for a code when you sign in.'
                    : 'Add a code from your phone for extra safety.'}
                </p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3 rounded-2xl bg-surface-2 p-4">
              <Laptop className="size-7 shrink-0 text-brand" aria-hidden />
              <div>
                <p className="font-semibold">
                  {sessions.data
                    ? `${sessions.data.length} signed-in device${sessions.data.length === 1 ? '' : 's'}`
                    : 'Signed-in devices'}
                </p>
                <p className="text-sm text-muted">Sign out devices you don’t recognise.</p>
              </div>
            </div>
            <Link
              href="/settings"
              className="mt-4 inline-flex items-center gap-1 font-semibold text-brand"
            >
              Manage security <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Card>

          {/* Stores (role dashboards above already list them) */}
          {!managed && (
            <Card aria-labelledby="stores-title">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="stores-title" className="text-xl font-bold">
                  {isAdmin ? 'Stores' : 'Your stores'}
                </h2>
                {isAdmin && (
                  <Link
                    href="/admin?tab=stores"
                    className="rounded-lg px-2 py-1 font-semibold text-brand hover:bg-brand-soft"
                  >
                    Manage
                  </Link>
                )}
              </div>
              {stores.isLoading && <Spinner label="Loading stores" />}
              {stores.data?.length === 0 && <p className="text-muted">No stores yet.</p>}
              <ul className="grid gap-2">
                {stores.data?.slice(0, 5).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
                    <span className="inline-flex size-10 items-center justify-center rounded-xl bg-surface text-brand">
                      <Store className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{s.name}</span>
                      <span className="text-sm text-muted">{s.memberCount} people</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Recent administrative activity (audit log) or business info */}
          <Card aria-labelledby="activity-title">
            <h2 id="activity-title" className="mb-3 text-xl font-bold">
              {canAudit ? 'Recent activity' : 'Your workspace'}
            </h2>
            {canAudit ? (
              <>
                {audit.isLoading && <Spinner label="Loading activity" />}
                <ul className="grid gap-3">
                  {audit.data?.items.map((a) => (
                    <li key={a.id} className="flex gap-3">
                      <span className="mt-2 size-2.5 shrink-0 rounded-full bg-warm" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {describeAction(a.action)}
                        </span>
                        <span className="text-sm text-muted">
                          {a.actor?.displayName ?? 'System'} · {formatRelativeShort(a.occurredAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/admin?tab=audit"
                  className="mt-4 inline-flex items-center gap-1 font-semibold text-brand"
                >
                  Full audit log <ArrowRight className="size-4" aria-hidden />
                </Link>
              </>
            ) : (
              <div className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4">
                <Building2 className="size-7 shrink-0 text-brand" aria-hidden />
                <div>
                  <p className="font-semibold">{business?.name ?? 'No workspace'}</p>
                  <p className="text-sm text-muted">
                    {business?.stores.map((s) => s.name).join(', ') ||
                      'You are not assigned to a store yet.'}
                  </p>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
      <NewChatDialog
        open={newChat}
        onClose={() => setNewChat(false)}
        onOpened={(id) => router.push(`/chats?c=${id}`)}
      />
      <NewGroupDialog
        open={newGroup}
        onClose={() => setNewGroup(false)}
        onCreated={(id) => router.push(`/chats?c=${id}`)}
      />
    </div>
  );
}

function QuickAction({
  Icon,
  label,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-left font-semibold transition-colors hover:border-brand/50 hover:bg-brand-soft"
    >
      <span className="inline-flex size-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="flex-1">{label}</span>
      <ArrowRight className="size-5 text-muted" aria-hidden />
    </button>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.mfa_enabled': 'Turned on two-step verification',
  'auth.password_changed': 'Changed password',
  'business.created': 'Created the business',
  'business.updated': 'Updated business settings',
  'store.created': 'Added a store',
  'store.updated': 'Updated a store',
  'store.archived': 'Archived a store',
  'user.created': 'Added a person',
  'user.updated': 'Updated a person',
  'user.stores_changed': 'Changed someone’s stores',
  'user.removed_from_business': 'Removed a person',
  'user.deactivated': 'Deactivated an account',
  'user.contact_viewed': 'Viewed private contact details',
  'role.assigned': 'Assigned a role',
  'role.revoked': 'Removed a role',
  'group.created': 'Created a group',
  'group.updated': 'Updated a group',
  'group.members_added': 'Added people to a group',
  'group.member_removed': 'Removed someone from a group',
  'message.moderated_delete': 'Removed a message (moderation)',
  'media.quarantined': 'Blocked a harmful file',
  'media.rejected': 'Rejected an invalid file',
  'media.downloaded': 'Downloaded a file from a security chat',
  'authz.denied': 'Access was denied',
};

function describeAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
