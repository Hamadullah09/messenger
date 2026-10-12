'use client';

import {
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Moon,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hasPermission, hasTenantPermission, useAuth } from '@/lib/auth-store';
import { AWAITING, useIncidents } from '@/lib/emergency';
import { resolvedTheme, useTheme } from '@/lib/theme';
import { BrandIcon } from '../brand';
import { EmergencyButton } from '../emergency/raise-alert';
import { Avatar, cx } from '../ui';

function RailLink({
  href,
  label,
  Icon,
  active,
  badge,
  danger,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  badge?: number;
  danger?: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={badge ? `${label} (${badge})` : label}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'relative inline-flex size-11 items-center justify-center rounded-full transition-colors',
        active ? 'bg-wa-active text-fg' : 'text-wa-icon hover:bg-wa-hover',
      )}
    >
      <Icon className="size-6" aria-hidden strokeWidth={active ? 2.25 : 1.75} />
      {badge ? (
        <span
          className={cx(
            'absolute -top-0.5 -right-0.5 inline-flex min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold',
            danger ? 'bg-danger text-danger-contrast' : 'bg-brand text-brand-contrast',
          )}
          aria-hidden
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Slim WhatsApp Web-style navigation rail used on the Messages screen (tablet and desktop).
 * Phones keep the bottom tabs.
 */
export function WaRail({ unreadChats }: { unreadChats: number }) {
  const pathname = usePathname();
  const me = useAuth((s) => s.me);
  const businessId = useAuth((s) => s.activeBusinessId);
  const [theme, setTheme] = useTheme();
  const dark = resolvedTheme(theme) === 'dark';
  const incidents = useIncidents(true);
  const waiting = (incidents.data?.items ?? []).filter((i) => AWAITING.includes(i.status)).length;
  const showEmergency =
    hasPermission(me, 'emergency.trigger') || hasPermission(me, 'incident.read');

  return (
    <nav
      aria-label="Main"
      className="hidden w-16 shrink-0 flex-col items-center justify-between border-r border-wa-divider bg-wa-panel py-3 md:flex"
    >
      <div className="flex flex-col items-center gap-2">
        <Link href="/dashboard" aria-label="SMA Technology home" className="mb-2">
          <BrandIcon size={38} className="rounded-full" />
        </Link>
        <RailLink
          href="/chats"
          label="Chats"
          Icon={MessageCircle}
          active={pathname.startsWith('/chats')}
          badge={unreadChats}
        />
        {showEmergency && (
          <RailLink
            href="/emergency"
            label="Emergency"
            Icon={ShieldAlert}
            active={false}
            badge={waiting}
            danger
          />
        )}
        {hasTenantPermission(me, 'bulk_message.send', businessId) && (
          <RailLink href="/campaigns" label="Campaigns" Icon={Megaphone} active={false} />
        )}
        <RailLink href="/search" label="Search" Icon={Search} active={false} />
        <RailLink href="/dashboard" label="Dashboard" Icon={LayoutDashboard} active={false} />
      </div>
      <div className="flex flex-col items-center gap-2">
        <EmergencyButton round />
        <button
          type="button"
          onClick={() => setTheme(dark ? 'light' : 'dark')}
          title={dark ? 'Light mode' : 'Dark mode'}
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex size-11 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
        >
          {dark ? <Sun className="size-6" aria-hidden /> : <Moon className="size-6" aria-hidden />}
        </button>
        <RailLink href="/settings" label="Settings" Icon={Settings} active={false} />
        <Link
          href="/settings"
          title="Profile"
          aria-label={`Profile: ${me?.user.displayName ?? ''}`}
          className="rounded-full"
        >
          <Avatar name={me?.user.displayName ?? '?'} size={36} />
        </Link>
      </div>
    </nav>
  );
}
