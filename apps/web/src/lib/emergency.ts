'use client';

import type {
  AlertState,
  EmergencyCategory,
  IncidentDetailDto,
  IncidentDto,
  IncidentListItemDto,
  IncidentStatus,
  Page,
} from '@storeline/shared';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './api';
import { hasPermission, useAuth } from './auth-store';

export const emergencyKeys = {
  all: ['emergency'] as const,
  list: (active: boolean) => ['emergency', 'list', active] as const,
  detail: (id: string) => ['emergency', 'detail', id] as const,
  stores: ['emergency', 'stores'] as const,
  settings: (storeId: string) => ['emergency', 'settings', storeId] as const,
};

export const AWAITING: IncidentStatus[] = ['OPEN', 'ESCALATED'];
export const ACTIVE: IncidentStatus[] = ['OPEN', 'ESCALATED', 'ACKNOWLEDGED'];

export function useIncidents(active: boolean) {
  const me = useAuth((s) => s.me);
  return useQuery({
    queryKey: emergencyKeys.list(active),
    queryFn: () =>
      api<Page<IncidentListItemDto>>('/emergency/incidents', {
        query: { active: active ? 'true' : undefined, limit: 50 },
      }),
    enabled: !!me,
    // Emergency state must be fresh even if a socket event was missed.
    refetchInterval: active ? 30_000 : false,
  });
}

export function useIncident(id: string | null) {
  return useQuery({
    queryKey: emergencyKeys.detail(id ?? ''),
    queryFn: () => api<IncidentDetailDto>(`/emergency/incidents/${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

export function canUseEmergency(me: ReturnType<typeof useAuth.getState>['me']): boolean {
  return hasPermission(me, 'emergency.trigger') || hasPermission(me, 'incident.read');
}

/** Applies a live incident update to cached lists and detail (viewer fields are kept). */
export function applyIncidentUpdate(client: QueryClient, incident: IncidentDto): void {
  for (const active of [true, false]) {
    client.setQueryData<Page<IncidentListItemDto>>(emergencyKeys.list(active), (page) =>
      page
        ? {
            ...page,
            items: page.items.map((item) =>
              item.id === incident.id ? { ...item, ...incident, me: item.me } : item,
            ),
          }
        : page,
    );
  }
  // Viewer-specific fields (canRespond, alertState) and the timeline come from the server.
  void client.invalidateQueries({ queryKey: ['emergency', 'list'] });
  void client.invalidateQueries({ queryKey: emergencyKeys.detail(incident.id) });
}

export function sendReceipt(incidentId: string, state: 'DELIVERED' | 'READ'): void {
  void api(`/emergency/incidents/${incidentId}/receipt`, {
    method: 'POST',
    body: { state },
  }).catch(() => undefined);
}

/** Alerts that should take over the screen until this person acts on them. */
interface AlertQueue {
  alerts: IncidentDto[];
  /** Incident ids the person chose to look at later (until the incident changes level). */
  snoozed: Record<string, number>;
  push: (incident: IncidentDto) => void;
  remove: (incidentId: string) => void;
  snooze: (incident: IncidentDto) => void;
}

export const useEmergencyAlerts = create<AlertQueue>((set) => ({
  alerts: [],
  snoozed: {},
  push: (incident) =>
    set((s) => {
      if ((s.snoozed[incident.id] ?? 0) >= incident.level) return s;
      return {
        alerts: [incident, ...s.alerts.filter((a) => a.id !== incident.id)],
      };
    }),
  remove: (incidentId) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== incidentId) })),
  snooze: (incident) =>
    set((s) => ({
      alerts: s.alerts.filter((a) => a.id !== incident.id),
      snoozed: { ...s.snoozed, [incident.id]: incident.level },
    })),
}));

export const CATEGORY_LABEL: Record<EmergencyCategory, string> = {
  MEDICAL: 'Medical',
  FIRE: 'Fire or smoke',
  SECURITY: 'Security threat',
  THEFT: 'Theft or robbery',
  VIOLENCE: 'Threat or violence',
  ACCIDENT: 'Accident or injury',
  GAS_LEAK: 'Gas leak or chemical',
  POWER_FAILURE: 'Power or building failure',
  NATURAL_DISASTER: 'Earthquake, flood or storm',
  OTHER: 'Other',
};

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: 'Waiting for response',
  ESCALATED: 'Escalated — waiting',
  ACKNOWLEDGED: 'Help is on the way',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

/** Honest delivery wording: "sent" is not "delivered"; only the device can confirm delivery. */
export const ALERT_STATE_LABEL: Record<AlertState, string> = {
  PENDING: 'Not alerted yet',
  QUEUED: 'Sending…',
  SENT_TO_GATEWAY: 'Sent',
  DELIVERED_TO_DEVICE: 'Delivered',
  READ: 'Seen',
  ACKNOWLEDGED: 'Responding',
  FAILED: 'Not delivered',
  SKIPPED: 'Skipped (unavailable)',
};

export const SOURCE_LABEL = {
  CONTACT: 'Emergency contact',
  STORE_MANAGER: 'Store manager',
  BUSINESS_ADMIN: 'Business admin',
  RESPONDER: 'Responder',
} as const;
