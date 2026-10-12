'use client';

import type { DeviceDto, NotificationConfigDto } from '@storeline/shared';
import { useEffect } from 'react';
import { api } from './api';
import { useAuth } from './auth-store';

/** "Chrome on Windows" style label from a user-agent string. */
export function describeUserAgent(agent: string | null): string {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /Mac OS/.test(agent)
      ? 'macOS'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return [browser, os && `on ${os}`].filter(Boolean).join(' ');
}

/** Registers this browser as a device of the current session (idempotent on the server). */
export function useDeviceRegistration(): void {
  const sessionId = useAuth((s) => s.me?.session.id);
  useEffect(() => {
    if (!sessionId) return;
    void api<DeviceDto>('/devices', {
      method: 'POST',
      body: { platform: 'WEB', name: describeUserAgent(navigator.userAgent).slice(0, 80) },
    })
      // Notifications allowed earlier: keep this device's push subscription current.
      .then(() => subscribeToPush())
      .catch(() => undefined);
  }, [sessionId]);
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * When notifications are allowed, registers the service worker (Android shows notifications only
 * through it) and, if the server has push keys, subscribes so alerts arrive while the page is
 * closed. Best effort: pop-ups while the page is open work without push.
 */
export async function subscribeToPush(): Promise<void> {
  if (!pushSupported() || !window.isSecureContext || Notification.permission !== 'granted') return;
  try {
    const config = await api<NotificationConfigDto>('/notifications/config');
    if (config.webPushPublicKey) await enablePush(config);
    else await registration();
  } catch {
    // Keep the in-page notifications.
  }
}

/** Is this browser currently subscribed? */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes with the server's VAPID key and registers it. */
export async function enablePush(config: NotificationConfigDto): Promise<void> {
  if (!pushSupported()) throw new Error('This browser cannot show notifications.');
  if (!config.webPushPublicKey) throw new Error('Notifications are not set up on this server yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      'Notifications are blocked. Allow them in your browser settings for this site.',
    );
  const reg = await registration();
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(config.webPushPublicKey),
    }));
  await api('/devices/current/push', {
    method: 'PUT',
    body: { provider: 'WEB_PUSH', subscription: subscription.toJSON() },
  });
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  await api('/devices/current/push', { method: 'DELETE' });
  await subscription?.unsubscribe();
}
