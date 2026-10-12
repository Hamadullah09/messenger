'use client';

/**
 * WhatsApp Web-style alerts for new messages: a short sound, a system notification when you are
 * not looking at that chat, and the unread count in the tab title.
 *
 * System notifications only exist on secure pages (https or localhost). On http://192.168.x.x
 * (a phone on the local Wi-Fi) only the sound and the title count work; the LAN server also
 * offers https on the same port (see apps/web/lan-server.mjs).
 */

import { subscribeToPush } from './push';

let audio: AudioContext | null = null;

/** Browsers only allow sound after the person has tapped or typed once. */
export function unlockSound(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    // No audio on this device.
  }
}

/** A soft two-note chime (generated, so no sound file is needed). */
export function playMessageSound(): void {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  for (const [freq, at] of [
    [880, 0],
    [1320, 0.11],
  ] as const) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.25);
  }
}

export type SystemNotificationState = 'unsupported' | 'insecure' | NotificationPermission;

export function systemNotificationState(): SystemNotificationState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission;
}

/**
 * Asks once, then (like WhatsApp) also subscribes this browser to push, so alerts still arrive
 * while the page is closed or the phone is locked. Push is best effort: without server keys the
 * in-page notifications still work.
 */
export async function askForNotifications(): Promise<NotificationPermission | null> {
  if (systemNotificationState() !== 'default') return null;
  const permission = await Notification.requestPermission();
  if (permission === 'granted') await subscribeToPush();
  return permission;
}


/** Shows a system notification; clicking it focuses the tab and opens the chat. */
export async function showSystemNotification(options: {
  title: string;
  body: string;
  tag: string;
  url: string;
  onClick: () => void;
}): Promise<void> {
  if (systemNotificationState() !== 'granted') return;
  const init: NotificationOptions = {
    body: options.body,
    tag: options.tag,
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    data: { url: options.url },
  };
  try {
    // Android Chrome only allows notifications through the service worker.
    const registration = await navigator.serviceWorker?.getRegistration('/');
    if (registration) {
      await registration.showNotification(options.title, init);
      return;
    }
  } catch {
    // Fall back to a page notification.
  }
  try {
    const n = new Notification(options.title, init);
    n.onclick = () => {
      window.focus();
      options.onClick();
      n.close();
    };
  } catch {
    // Notifications refused by the browser.
  }
}

/** "(3) SMA" in the tab title, like WhatsApp Web. */
export function setTitleCount(count: number): void {
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}
