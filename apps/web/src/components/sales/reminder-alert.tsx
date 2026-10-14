'use client';

import type { SalesReminderEvent } from '@storeline/shared';
import { BellRing, Phone, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Button } from '@/components/ui';
import { formatTime } from '@/lib/format';
import { FOLLOW_UP_LABEL } from './labels';

interface ReminderState {
  items: SalesReminderEvent[];
  push: (event: SalesReminderEvent) => void;
  dismiss: (leadId: string) => void;
}

/** Reminders for follow-ups starting soon (from the server, 15 minutes before). */
export const useSalesReminders = create<ReminderState>((set) => ({
  items: [],
  push: (event) =>
    set((s) => ({ items: [...s.items.filter((r) => r.leadId !== event.leadId), event].slice(-3) })),
  dismiss: (leadId) => set((s) => ({ items: s.items.filter((r) => r.leadId !== leadId) })),
}));

/** A short two-tone chime (generated; no sound file). */
function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [f, at] of [
      [880, 0],
      [1175, 0.2],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.5);
    }
    window.setTimeout(() => void ctx.close(), 1500);
  } catch {
    // No sound available.
  }
}

function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
}

/** Cards that stay until dismissed: "Meeting in 15 min · Company". Mount once in the app shell. */
export function ReminderAlerts() {
  const items = useSalesReminders((s) => s.items);
  const dismiss = useSalesReminders((s) => s.dismiss);
  const router = useRouter();
  const [now, setNow] = useState(Date.now());
  const count = items.length;

  useEffect(() => {
    if (count === 0) return;
    chime();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [count]);

  if (count === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[65] flex flex-col items-center gap-2 px-3 sm:right-4 sm:bottom-4 sm:left-auto sm:items-end">
      {items.map((r) => {
        const kind = FOLLOW_UP_LABEL[r.kind ?? 'OTHER'];
        const minutes = minutesUntil(r.at, now);
        return (
          <div
            key={r.leadId}
            role="alert"
            className="pointer-events-auto w-full max-w-sm animate-[toast-in_180ms_ease-out] rounded-2xl border border-brand/40 bg-surface p-4 text-fg shadow-xl"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                <BellRing className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  {kind} {minutes > 0 ? `in ${minutes} min` : 'now'} · {formatTime(r.at)}
                </p>
                <p className="truncate">
                  {r.companyName} · {r.contactName}
                </p>
                {r.note && <p className="text-sm text-muted">{r.note}</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss reminder"
                onClick={() => dismiss(r.leadId)}
                className="rounded-full p-1.5 text-muted hover:bg-surface-2"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  dismiss(r.leadId);
                  router.push(`/sales?tab=today&lead=${r.leadId}`);
                }}
              >
                Open lead
              </Button>
              {r.phone && (
                <a
                  href={`tel:${r.phone}`}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-strong/60 px-3 text-sm font-semibold hover:bg-surface-2"
                >
                  <Phone className="size-4" aria-hidden /> Call
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
