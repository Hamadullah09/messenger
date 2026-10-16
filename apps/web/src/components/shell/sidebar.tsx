'use client';

import { ChevronDown, LogOut, Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { logout } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { AWAITING, useIncidents } from '@/lib/emergency';
import { useFeatures } from '@/lib/features';
import { resolvedTheme, useTheme } from '@/lib/theme';
import { BRAND, BrandMark } from '../brand';
import { Badge, cx } from '../ui';
import { adminNav, footerNav, primaryNav, type NavItem } from './nav';

function NavLink({
  item,
  active,
  badge,
  badgeTone,
  compact,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  badgeTone?: 'danger';
  compact: boolean;
  onNavigate?: () => void;
}) {
  const { Icon } = item;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={compact ? item.label : undefined}
      className={cx(
        'group relative flex items-center rounded-xl font-medium transition-colors',
        compact ? 'min-h-14 flex-col justify-center gap-0.5 px-1 text-xs' : 'min-h-12 gap-3 px-3',
        active ? 'bg-brand-soft text-brand-strong' : 'text-fg hover:bg-surface-2',
      )}
    >
      {active && !compact && (
        <span className="absolute top-2 bottom-2 left-0 w-1 rounded-full bg-brand" aria-hidden />
      )}
      <Icon className={cx('shrink-0', compact ? 'size-6' : 'size-5')} aria-hidden />
      <span className={cx(compact ? 'text-center leading-tight' : 'flex-1')}>{item.label}</span>
      {badge ? (
        <Badge
          className={cx(
            compact && 'absolute top-1 right-1',
            badgeTone === 'danger' && 'bg-danger text-danger-contrast',
          )}
        >
          {badge > 99 ? '99+' : badge}
          <span className="sr-only">
            {badgeTone === 'danger' ? ' active alerts' : ' unread chats'}
          </span>
        </Badge>
      ) : null}
    </Link>
  );
}

/**
 * Main navigation. `compact` renders an icon rail with short labels (tablet); otherwise the
 * full sidebar (desktop and the mobile drawer).
 */
export function Sidebar({
  compact = false,
  unreadChats,
  onNavigate,
}: {
  compact?: boolean;
  unreadChats: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');
  const me = useAuth((s) => s.me);
  const businessId = useAuth((s) => s.activeBusinessId);
  const [theme, setTheme] = useTheme();
  const [adminOpen, setAdminOpen] = useState(true);
  const admin = adminNav(me, businessId);
  const features = useFeatures();
  const incidents = useIncidents(true);
  const waiting = (incidents.data?.items ?? []).filter((i) => AWAITING.includes(i.status)).length;
  const current = resolvedTheme(theme);

  return (
    <div
      className={cx(
        'flex h-full flex-col bg-surface',
        compact ? 'items-stretch px-2 py-4' : 'px-4 py-5',
      )}
    >
      <div className={cx('mb-6', compact ? 'flex justify-center' : 'px-1')}>
        <Link href="/dashboard" onClick={onNavigate} aria-label={`${BRAND.company} home`}>
          <BrandMark compact={compact} size={compact ? 48 : 46} />
        </Link>
      </div>
      {!compact && <hr className="mb-4 border-line" />}

      <nav aria-label="Main" className="scroll-thin flex flex-1 flex-col gap-1 overflow-y-auto">
        {primaryNav(me, features).map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={item.match(pathname, tab)}
            badge={
              item.href === '/chats'
                ? unreadChats
                : item.href === '/emergency'
                  ? waiting
                  : undefined
            }
            badgeTone={item.href === '/emergency' ? 'danger' : undefined}
            compact={compact}
            onNavigate={onNavigate}
          />
        ))}

        {admin.length > 0 && (
          <div className="mt-4">
            {compact ? (
              <hr className="mx-2 mb-2 border-line" />
            ) : (
              <button
                type="button"
                onClick={() => setAdminOpen((v) => !v)}
                aria-expanded={adminOpen}
                className="flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-xs font-bold tracking-wider text-muted uppercase hover:bg-surface-2"
              >
                Administration
                <ChevronDown
                  className={cx('size-4 transition-transform', !adminOpen && '-rotate-90')}
                  aria-hidden
                />
              </button>
            )}
            {(adminOpen || compact) && (
              <div className="mt-1 flex flex-col gap-1">
                {admin.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={item.match(pathname, tab)}
                    compact={compact}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="mt-4 flex flex-col gap-1">
        {footerNav().map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={item.match(pathname, tab)}
            compact={compact}
            onNavigate={onNavigate}
          />
        ))}
        <button
          type="button"
          onClick={() => void logout()}
          title={compact ? 'Sign out' : undefined}
          className={cx(
            'flex items-center rounded-xl font-medium text-fg hover:bg-surface-2',
            compact ? 'min-h-14 flex-col justify-center gap-0.5 text-xs' : 'min-h-12 gap-3 px-3',
          )}
        >
          <LogOut className={compact ? 'size-6' : 'size-5'} aria-hidden />
          Sign out
        </button>
      </div>

      {/* Light / Dark switch, as in the reference design. */}
      <div
        role="radiogroup"
        aria-label="Colour theme"
        className={cx(
          'mt-4 grid rounded-2xl border border-line bg-surface-2 p-1',
          compact ? 'grid-cols-1 gap-1' : 'grid-cols-2',
        )}
      >
        {(
          [
            ['light', 'Light', Sun],
            ['dark', 'Dark', Moon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            title={label}
            onClick={() => setTheme(value)}
            className={cx(
              'flex min-h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors',
              current === value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {compact ? <span className="sr-only">{label}</span> : label}
          </button>
        ))}
      </div>
    </div>
  );
}
