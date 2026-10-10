'use client';

import type { MeDto } from '@storeline/shared';
import { create } from 'zustand';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  /** Access token lives in memory only (never localStorage) to limit XSS impact. */
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  me: MeDto | null;
  activeBusinessId: string | null;
  setSession: (token: string, expiresAt: string, me: MeDto) => void;
  setMe: (me: MeDto) => void;
  setActiveBusiness: (businessId: string) => void;
  clear: () => void;
}

const ACTIVE_BUSINESS_KEY = 'storeline.activeBusiness';

function rememberedBusiness(me: MeDto): string | null {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(ACTIVE_BUSINESS_KEY);
  } catch {
    stored = null;
  }
  if (stored && me.businesses.some((b) => b.id === stored)) return stored;
  return me.businesses[0]?.id ?? null;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  accessTokenExpiresAt: null,
  me: null,
  activeBusinessId: null,
  setSession: (token, expiresAt, me) =>
    set((state) => ({
      status: 'signed-in',
      accessToken: token,
      accessTokenExpiresAt: Date.parse(expiresAt),
      me,
      activeBusinessId:
        state.activeBusinessId && me.businesses.some((b) => b.id === state.activeBusinessId)
          ? state.activeBusinessId
          : rememberedBusiness(me),
    })),
  setMe: (me) => set({ me }),
  setActiveBusiness: (businessId) => {
    try {
      window.localStorage.setItem(ACTIVE_BUSINESS_KEY, businessId);
    } catch {
      // Storage unavailable (private mode): the choice simply is not remembered.
    }
    set({ activeBusinessId: businessId });
  },
  clear: () =>
    set({ status: 'signed-out', accessToken: null, accessTokenExpiresAt: null, me: null }),
}));

/** Convenience checks for UI gating. The server enforces every permission independently. */
export function hasPermission(
  me: MeDto | null,
  permission: string,
  businessId?: string | null,
): boolean {
  if (!me) return false;
  return me.grants.some(
    (g) =>
      g.permissions.includes(permission as never) &&
      (g.scope.type === 'PLATFORM' || !businessId || g.scope.businessId === businessId),
  );
}

/** Like hasPermission, but only business/store grants count (tenant operations such as campaigns). */
export function hasTenantPermission(
  me: MeDto | null,
  permission: string,
  businessId: string | null,
): boolean {
  if (!me || !businessId) return false;
  return me.grants.some(
    (g) =>
      g.scope.type !== 'PLATFORM' &&
      g.scope.businessId === businessId &&
      g.permissions.includes(permission as never),
  );
}

export function isPlatformAdmin(me: MeDto | null): boolean {
  return !!me?.grants.some((g) => g.scope.type === 'PLATFORM');
}

const ROLE_ORDER = [
  'SUPER_ADMIN',
  'BUSINESS_ADMIN',
  'STORE_MANAGER',
  'SECURITY',
  'EMPLOYEE',
  'CUSTOMER',
];

/** The most senior role name for display (e.g. under the user's name). */
export function primaryRoleName(me: MeDto | null, businessId?: string | null): string {
  if (!me) return '';
  const relevant = me.grants.filter(
    (g) => g.scope.type === 'PLATFORM' || !businessId || g.scope.businessId === businessId,
  );
  const ranked = [...relevant].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a.roleKey);
    const ib = ROLE_ORDER.indexOf(b.roleKey);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return ranked[0]?.roleName ?? 'Member';
}
