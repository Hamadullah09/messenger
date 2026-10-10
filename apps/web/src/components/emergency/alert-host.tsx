'use client';

import type { IncidentDetailDto, IncidentDto } from '@storeline/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOff, Siren } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import {
  AWAITING,
  CATEGORY_LABEL,
  emergencyKeys,
  sendReceipt,
  useEmergencyAlerts,
  useIncidents,
} from '@/lib/emergency';
import { formatRelativeShort } from '@/lib/format';

const UNACKED_STATES = ['QUEUED', 'SENT_TO_GATEWAY', 'DELIVERED_TO_DEVICE', 'FAILED'];

/** Repeating two-tone alarm via Web Audio. Browsers may block it until the page was used once. */
function useAlarm(active: boolean, muted: boolean) {
  useEffect(() => {
    if (!active || muted || typeof window === 'undefined' || !('AudioContext' in window)) return;
    const ctx = new AudioContext();
    const beep = () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      for (const [i, freq] of [880, 660].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.15;
        osc.connect(gain).connect(ctx.destination);
        const start = ctx.currentTime + i * 0.35;
        osc.start(start);
        osc.stop(start + 0.3);
      }
      navigator.vibrate?.([300, 150, 300]);
    };
    beep();
    const timer = setInterval(beep, 2500);
    return () => {
      clearInterval(timer);
      void ctx.close().catch(() => undefined);
    };
  }, [active, muted]);
}

/**
 * Takes over the screen when this person is alerted, until they respond or choose to look
 * later. Alerts missed while offline are recovered from the server on load and reconnect.
 */
export function EmergencyAlertHost() {
  const router = useRouter();
  const client = useQueryClient();
  const myId = useAuth((s) => s.me?.user.id);
  const { alerts, push, remove, snooze } = useEmergencyAlerts();
  const active = useIncidents(true);
  const [muted, setMuted] = useState(false);
  const respondRef = useRef<HTMLButtonElement>(null);
  const current = alerts[0] ?? null;

  // Recover alerts that arrived while this device was offline or closed.
  useEffect(() => {
    for (const incident of active.data?.items ?? []) {
      if (
        AWAITING.includes(incident.status) &&
        incident.me.alertState &&
        UNACKED_STATES.includes(incident.me.alertState)
      ) {
        if (incident.me.alertState !== 'DELIVERED_TO_DEVICE') sendReceipt(incident.id, 'DELIVERED');
        push(incident);
      } else {
        remove(incident.id);
      }
    }
  }, [active.data, push, remove]);

  useEffect(() => {
    if (current) respondRef.current?.focus();
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useAlarm(!!current, muted);

  const respond = useMutation({
    mutationFn: (incident: IncidentDto) =>
      api<IncidentDetailDto>(`/emergency/incidents/${incident.id}/acknowledge`, { method: 'POST' }),
    onSuccess: (detail) => {
      remove(detail.id);
      client.setQueryData(emergencyKeys.detail(detail.id), detail);
      void client.invalidateQueries({ queryKey: emergencyKeys.all });
      router.push(`/emergency?id=${detail.id}`);
    },
  });

  if (!current || current.reporter.id === myId) return null;
  const escalated = current.level > 1;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="emergency-alert-title"
      aria-describedby="emergency-alert-body"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-surface shadow-pop">
        <div className="flex items-center gap-4 bg-danger px-5 py-5 text-danger-contrast">
          <span className="relative flex size-14 shrink-0 items-center justify-center rounded-full bg-danger-contrast/15">
            <span className="absolute inset-0 animate-ping rounded-full bg-danger-contrast/25 motion-reduce:hidden" />
            <Siren className="size-8" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-wider uppercase">
              {escalated ? 'Escalated to you' : 'Emergency alert'}
            </p>
            <h2 id="emergency-alert-title" className="text-2xl leading-tight font-extrabold">
              {CATEGORY_LABEL[current.category]} · {current.store.name}
            </h2>
          </div>
        </div>
        <div id="emergency-alert-body" className="flex flex-col gap-3 px-5 py-5">
          <p className="text-lg">
            <strong>{current.reporter.displayName}</strong> needs help ·{' '}
            <span className="text-muted">{formatRelativeShort(current.createdAt)}</span>
          </p>
          {current.description && (
            <p className="rounded-2xl bg-surface-2 p-4 text-lg whitespace-pre-wrap">
              {current.description}
            </p>
          )}
          {escalated && (
            <p className="font-semibold text-danger">Earlier contacts did not respond in time.</p>
          )}
          {respond.error && (
            <p role="alert" className="font-semibold text-danger">
              {errorMessage(respond.error)}
            </p>
          )}
          {alerts.length > 1 && (
            <p className="text-sm text-muted">
              {alerts.length - 1} more alert{alerts.length > 2 ? 's' : ''} waiting
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-5 py-4">
          <button
            ref={respondRef}
            type="button"
            onClick={() => respond.mutate(current)}
            disabled={respond.isPending}
            className="min-h-14 rounded-2xl bg-danger px-5 text-lg font-bold text-danger-contrast hover:opacity-90 disabled:opacity-60"
          >
            {respond.isPending ? 'Sending…' : 'I’m responding'}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <Link
              href={`/emergency?id=${current.id}`}
              onClick={() => snooze(current)}
              className="flex min-h-12 items-center justify-center rounded-2xl border border-line-strong/60 font-semibold hover:bg-surface-2"
            >
              View details
            </Link>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-pressed={muted}
              className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line-strong/60 font-semibold hover:bg-surface-2"
            >
              <BellOff className="size-5" aria-hidden />
              {muted ? 'Sound off' : 'Mute sound'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Slim red strip for everyone who can see an incident that is still waiting for a response. */
export function EmergencyBanner() {
  const pathname = usePathname();
  const myId = useAuth((s) => s.me?.user.id);
  const active = useIncidents(true);
  const waiting = (active.data?.items ?? []).filter((i) => AWAITING.includes(i.status));
  if (waiting.length === 0 || pathname.startsWith('/emergency')) return null;
  const first = waiting[0]!;
  const mine = first.reporter.id === myId;
  return (
    <Link
      href={`/emergency?id=${first.id}`}
      role="status"
      className="flex min-h-12 items-center gap-3 bg-danger px-4 py-2 font-semibold text-danger-contrast hover:opacity-95 sm:px-5"
    >
      <Siren className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {mine
          ? `Your alert at ${first.store.name} is waiting for a response`
          : `Emergency at ${first.store.name} — ${first.reporter.displayName}`}
        {waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}
      </span>
      <span className="shrink-0 underline">View</span>
    </Link>
  );
}
