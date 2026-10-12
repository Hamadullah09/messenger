import {
  Building2,
  Contact,
  HelpCircle,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  ScrollText,
  Settings,
  ShieldAlert,
  Siren,
  Target,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MeDto } from '@storeline/shared';
import { hasPermission, hasTenantPermission, isPlatformAdmin } from '@/lib/auth-store';

export interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Matches the current location (path + optional ?tab=). */
  match: (pathname: string, tab: string | null) => boolean;
}

export function primaryNav(me: MeDto | null): NavItem[] {
  const items: NavItem[] = [
    {
      href: '/dashboard',
      label: 'Dashboard',
      Icon: LayoutDashboard,
      match: (p) => p.startsWith('/dashboard'),
    },
    {
      href: '/chats',
      label: 'Messages',
      Icon: MessageCircle,
      match: (p) => p.startsWith('/chats'),
    },
  ];
  if (hasPermission(me, 'sales.access')) {
    items.push({
      href: '/sales',
      label: 'Sales',
      Icon: Target,
      match: (p) => p.startsWith('/sales'),
    });
  }
  if (hasPermission(me, 'emergency.trigger') || hasPermission(me, 'incident.read')) {
    items.push({
      href: '/emergency',
      label: 'Emergency',
      Icon: ShieldAlert,
      match: (p) => p.startsWith('/emergency'),
    });
  }
  return items;
}

/** Administration links shown only to people who can use them (the server enforces this too). */
export function adminNav(me: MeDto | null, businessId: string | null): NavItem[] {
  const items: NavItem[] = [];
  const at = (tab: string) => (p: string, t: string | null) => p.startsWith('/admin') && t === tab;
  if (isPlatformAdmin(me)) {
    items.push({
      href: '/admin?tab=businesses',
      label: 'Businesses',
      Icon: Building2,
      match: at('businesses'),
    });
  }
  if (businessId && (hasPermission(me, 'store.create', businessId) || isPlatformAdmin(me))) {
    items.push({ href: '/admin?tab=stores', label: 'Stores', Icon: Store, match: at('stores') });
  }
  if (
    businessId &&
    (hasPermission(me, 'user.create', businessId) || hasPermission(me, 'group.create', businessId))
  ) {
    items.push({ href: '/admin?tab=people', label: 'People', Icon: Users, match: at('people') });
  }
  if (businessId && hasTenantPermission(me, 'customer.read', businessId)) {
    items.push({
      href: '/admin?tab=customers',
      label: 'Store customers',
      Icon: Contact,
      match: at('customers'),
    });
  }
  if (hasTenantPermission(me, 'bulk_message.send', businessId)) {
    items.push({
      href: '/campaigns',
      label: 'Campaigns',
      Icon: Megaphone,
      match: (p) => p.startsWith('/campaigns'),
    });
  }
  if (businessId && hasPermission(me, 'emergency_contact.manage', businessId)) {
    items.push({
      href: '/admin?tab=emergency',
      label: 'Emergency setup',
      Icon: Siren,
      match: at('emergency'),
    });
  }
  if (businessId && hasPermission(me, 'audit.read', businessId)) {
    items.push({
      href: '/admin?tab=audit',
      label: 'Audit log',
      Icon: ScrollText,
      match: at('audit'),
    });
  }
  return items;
}

export function footerNav(): NavItem[] {
  return [
    {
      href: '/settings',
      label: 'Settings',
      Icon: Settings,
      match: (p) => p.startsWith('/settings'),
    },
    { href: '/help', label: 'Help', Icon: HelpCircle, match: (p) => p.startsWith('/help') },
  ];
}
