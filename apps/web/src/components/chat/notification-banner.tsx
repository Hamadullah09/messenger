'use client';

import { BellRing, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useChatPrefs } from '@/lib/chat-prefs';
import {
  askForNotifications,
  systemNotificationState,
  type SystemNotificationState,
} from '@/lib/notify';

const DISMISSED_KEY = 'sma.notifyBannerDismissed';

/** WhatsApp Web's "Get notified of new messages" banner at the top of the chat list. */
export function NotificationBanner() {
  const desktopAlerts = useChatPrefs((p) => p.desktopAlerts);
  const [state, setState] = useState<SystemNotificationState | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setState(systemNotificationState());
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Not remembered in private mode.
    }
  };

  if (state === 'default' && desktopAlerts) {
    return (
      <div className="flex shrink-0 items-center gap-3 bg-[#53bdeb] px-4 py-3 text-[#0b141a]">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white/90 text-[#53bdeb]">
          <BellRing className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Get notified of new messages</p>
          <button
            type="button"
            onClick={() =>
              void askForNotifications().then(() => setState(systemNotificationState()))
            }
            className="text-sm underline underline-offset-2"
          >
            Turn on desktop notifications
          </button>
        </div>
      </div>
    );
  }

  if (state === 'insecure' && !dismissed) {
    return (
      <div className="flex shrink-0 items-start gap-3 bg-wa-panel px-4 py-3 text-sm text-wa-chip-text">
        <Info className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p>
            Pop-up notifications need a secure address. Until then you hear a sound and see the
            count in the tab title.
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3">
            <a
              href={`https://${window.location.host}${window.location.pathname}`}
              className="font-medium text-brand underline underline-offset-2"
            >
              Open the secure address
            </a>
            <a href="/sma-local-ca.crt" className="underline underline-offset-2">
              Get the certificate (first time)
            </a>
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-wa-hover"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }
  return null;
}
