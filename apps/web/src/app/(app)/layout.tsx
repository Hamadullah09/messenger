'use client';

import { LayoutDashboard, Menu, MessageCircle, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmergencyAlertHost, EmergencyBanner } from '@/components/emergency/alert-host';
import { ChangePasswordForm } from '@/components/security';
import { WaRail } from '@/components/chat/wa-rail';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { Alert, Badge, cx, IconButton, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-store';
import { useConversations } from '@/lib/chat-hooks';
import { useLive } from '@/lib/live-store';
import { useDeviceRegistration } from '@/lib/push';

/** Accessible slide-in navigation for phones, built on <dialog> (focus trap + Esc). */
function MobileDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Menu"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 h-dvh max-h-dvh w-[min(20rem,88vw)] border-r border-line bg-surface p-0 text-fg backdrop:bg-black/40"
    >
      <div className="relative h-full">
        <IconButton label="Close menu" className="absolute top-3 right-3 z-10" onClick={onClose}>
          <X className="size-6" aria-hidden />
        </IconButton>
        {open && children}
      </div>
    </dialog>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, me, activeBusinessId } = useAuth();
  const conversations = useConversations();
  const [menuOpen, setMenuOpen] = useState(false);
  const chatOpen = useLive((s) => s.openConversationId !== null);
  useDeviceRegistration();

  useEffect(() => {
    if (status === 'signed-out') router.replace('/login');
  }, [status, router]);

  useEffect(() => setMenuOpen(false), [pathname]);

  const unread = useMemo(
    () =>
      (conversations.data ?? []).filter(
        (c) =>
          c.unreadCount > 0 &&
          !c.me.archivedAt &&
          (!activeBusinessId || c.businessId === activeBusinessId) &&
          !(c.me.mutedUntil && new Date(c.me.mutedUntil) > new Date()),
      ),
    [conversations.data, activeBusinessId],
  );

  if (status !== 'signed-in' || !me) return <Spinner label="Signing you in" />;

  if (me.mustChangePassword) {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-4"
      >
        <h1 className="text-2xl font-bold">Choose your own password</h1>
        <p className="text-muted">
          Your account was created with a temporary password. Please choose a new one to continue.
        </p>
        <ChangePasswordForm />
      </main>
    );
  }

  // Messages use a WhatsApp Web-style full-screen layout: slim rail, no top bar.
  const messenger = pathname.startsWith('/chats');
  const needsMfa =
    me.security.mfaRequiredForAdmins &&
    !me.mfaEnabled &&
    me.grants.some((g) => g.scope.type !== 'STORE' && g.roleKey !== 'CUSTOMER');

  return (
    <div className="flex h-dvh bg-bg">
      {messenger ? (
        <WaRail unreadChats={unread.length} />
      ) : (
        <>
          {/* Tablet and small laptops: icon rail · Large screens: full sidebar */}
          <aside className="hidden shrink-0 border-r border-line md:block md:w-24 xl:hidden">
            <Suspense>
              <Sidebar compact unreadChats={unread.length} />
            </Suspense>
          </aside>
          <aside className="hidden w-72 shrink-0 border-r border-line xl:block">
            <Suspense>
              <Sidebar unreadChats={unread.length} />
            </Suspense>
          </aside>
        </>
      )}
      <MobileDrawer open={menuOpen} onClose={() => setMenuOpen(false)}>
        <Suspense>
          <Sidebar unreadChats={unread.length} onNavigate={() => setMenuOpen(false)} />
        </Suspense>
      </MobileDrawer>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* On phones the chat header replaces the top bar while a chat is open. */}
        {messenger ? (
          <div className={cx(chatOpen && 'hidden md:block')}>
            <EmergencyBanner />
          </div>
        ) : (
          <div className={cx(chatOpen && 'hidden md:block')}>
            <Topbar onOpenMenu={() => setMenuOpen(true)} unreadConversations={unread} />
            <EmergencyBanner />
          </div>
        )}
        {needsMfa && !messenger && pathname !== '/settings' && (
          <div className="px-3 pt-3 sm:px-5">
            <Alert tone="warning" title="Turn on two-step verification">
              Administrator features stay locked until you{' '}
              <Link href="/settings" className="font-bold underline">
                set up two-step verification
              </Link>
              .
            </Alert>
          </div>
        )}
        <main id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </main>
        <EmergencyAlertHost />

        {/* Phone: large bottom tabs for the most used places */}
        <nav
          aria-label="Quick"
          className={cx(
            'grid grid-cols-4 border-t border-line bg-surface md:hidden',
            chatOpen && 'hidden',
          )}
        >
          {[
            { href: '/dashboard', label: 'Home', Icon: LayoutDashboard },
            { href: '/chats', label: 'Messages', Icon: MessageCircle, badge: unread.length },
            { href: '/search', label: 'Search', Icon: Search },
          ].map(({ href, label, Icon, badge }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold',
                  active ? 'text-brand' : 'text-muted',
                )}
              >
                <Icon className="size-6" aria-hidden />
                {label}
                {badge ? (
                  <Badge className="absolute top-1.5 left-1/2 ml-2">
                    {badge}
                    <span className="sr-only"> unread chats</span>
                  </Badge>
                ) : null}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold text-muted"
          >
            <Menu className="size-6" aria-hidden />
            More
          </button>
        </nav>
      </div>
    </div>
  );
}
