'use client';

import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { create } from 'zustand';
import { Avatar } from '@/components/ui';

const SHOW_MS = 5_000;

interface MessageAlert {
  id: number;
  /** Chat name (group) or sender name (direct chat). */
  title: string;
  body: string;
  url: string;
}

interface AlertState {
  current: MessageAlert | null;
  show: (alert: Omit<MessageAlert, 'id'>) => void;
  dismiss: () => void;
}

let next = 0;

/** The in-app banner for new messages while the SMA window is in front of you. */
export const useMessageAlert = create<AlertState>((set) => ({
  current: null,
  show: (alert) => set({ current: { ...alert, id: ++next } }),
  dismiss: () => set({ current: null }),
}));

/**
 * WhatsApp-style banner that slides in at the top when a message arrives for another chat while
 * this window has focus (system notifications only appear when it does not). Tap to open.
 */
export function MessageToast() {
  const alert = useMessageAlert((s) => s.current);
  const dismiss = useMessageAlert((s) => s.dismiss);
  const router = useRouter();

  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(dismiss, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [alert, dismiss]);

  if (!alert) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center px-3">
      <div
        key={alert.id}
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex w-full max-w-md animate-[toast-in_180ms_ease-out] items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pr-2 pl-3 text-fg shadow-xl"
      >
        <button
          type="button"
          onClick={() => {
            dismiss();
            router.push(alert.url);
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Avatar name={alert.title} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{alert.title}</span>
            <span className="block truncate text-sm text-muted">{alert.body}</span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-wa-hover"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
