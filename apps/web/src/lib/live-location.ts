'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { api, ApiRequestError } from './api';

const STORAGE_KEY = 'sma.liveShares';
const SEND_EVERY_MS = 15_000;

interface Share {
  messageId: string;
  until: number;
}

interface LiveShares {
  shares: Share[];
  add: (share: Share) => void;
  stop: (messageId: string) => void;
}

function load(): Share[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as Share[]) : [];
    return list.filter((s) => s.until > Date.now());
  } catch {
    return [];
  }
}

function save(shares: Share[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shares));
  } catch {
    // Not remembered in private mode; sharing continues while the page is open.
  }
}

/** Live locations this device is sharing (remembered across reloads until they end). */
export const useLiveShares = create<LiveShares>((set, get) => ({
  shares: [],
  add: (share) => {
    const shares = [...get().shares.filter((s) => s.messageId !== share.messageId), share];
    save(shares);
    set({ shares });
  },
  stop: (messageId) => {
    const shares = get().shares.filter((s) => s.messageId !== messageId);
    save(shares);
    set({ shares });
  },
}));

/**
 * While this device shares a live location, sends the current position every 15 seconds
 * (only while the app is open, like WhatsApp Web). Mounted once in the app layout.
 */
export function useLiveLocationSharing(): void {
  const shares = useLiveShares((s) => s.shares);
  useEffect(() => {
    useLiveShares.setState({ shares: load() });
  }, []);
  const active = shares.length > 0;
  useEffect(() => {
    if (!active || !('geolocation' in navigator)) return;
    let last = 0;
    let latest: GeolocationPosition | null = null;
    const send = () => {
      if (!latest) return;
      const now = Date.now();
      last = now;
      for (const share of useLiveShares.getState().shares) {
        if (share.until <= now) {
          useLiveShares.getState().stop(share.messageId);
          continue;
        }
        void api(`/messages/${share.messageId}/live-location`, {
          method: 'PUT',
          body: {
            lat: latest.coords.latitude,
            lng: latest.coords.longitude,
            accuracy: Math.round(latest.coords.accuracy),
          },
        }).catch((error: unknown) => {
          // Ended or stopped elsewhere: forget it.
          if (error instanceof ApiRequestError && error.status < 500)
            useLiveShares.getState().stop(share.messageId);
        });
      }
    };
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        latest = position;
        if (Date.now() - last >= SEND_EVERY_MS) send();
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    const timer = window.setInterval(send, SEND_EVERY_MS);
    return () => {
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(timer);
    };
  }, [active]);
}
