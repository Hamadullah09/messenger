'use client';

import type { NotificationConfigDto, NotificationPreferences } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Siren } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '@/lib/push';
import { Alert, Button, SelectField, Spinner } from './ui';

const PREVIEWS: Array<[NotificationPreferences['preview'], string]> = [
  ['NONE', 'Hidden — “New message” only'],
  ['SENDER', 'Sender and chat name'],
  ['CONTENT', 'Message text (if your organisation allows it)'],
];

/** Per-device push notifications plus account-wide preferences. */
export function NotificationSettings() {
  const client = useQueryClient();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ['notification-config'],
    queryFn: () => api<NotificationConfigDto>('/notifications/config'),
  });
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api<NotificationPreferences>('/notifications/preferences'),
  });
  const save = useMutation({
    mutationFn: (next: NotificationPreferences) =>
      api<NotificationPreferences>('/notifications/preferences', { method: 'PUT', body: next }),
    onSuccess: (data) => client.setQueryData(['notification-preferences'], data),
  });

  useEffect(() => {
    void currentSubscription()
      .then((s) => setSubscribed(!!s))
      .catch(() => setSubscribed(false));
  }, []);

  if (config.isPending || prefs.isPending) return <Spinner label="Loading notification settings" />;
  if (config.error || prefs.error)
    return <Alert tone="error">{errorMessage(config.error ?? prefs.error)}</Alert>;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) await disablePush();
      else await enablePush(config.data);
      setSubscribed(!subscribed);
    } catch (e) {
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {!pushSupported() ? (
        <Alert tone="info">
          This browser cannot show notifications. Try Chrome, Edge or Firefox.
        </Alert>
      ) : !config.data.providers.WEB_PUSH ? (
        <Alert tone="info">Notifications are not set up on this server yet.</Alert>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1">
            {subscribed
              ? 'This device shows notifications when SMA is closed or in the background.'
              : 'Get notified on this device when SMA is closed or in the background.'}
          </p>
          <Button
            variant={subscribed ? 'secondary' : 'primary'}
            busy={busy || subscribed === null}
            icon={
              subscribed ? (
                <BellOff className="size-5" aria-hidden />
              ) : (
                <BellRing className="size-5" aria-hidden />
              )
            }
            onClick={() => void toggle()}
          >
            {subscribed ? 'Turn off on this device' : 'Turn on notifications'}
          </Button>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-[var(--brand)]"
          checked={prefs.data.pushEnabled}
          onChange={(e) => save.mutate({ ...prefs.data, pushEnabled: e.target.checked })}
        />
        <span>Message notifications on all my devices</span>
      </label>
      <SelectField
        label="What notifications show on the lock screen"
        value={prefs.data.preview}
        onChange={(e) =>
          save.mutate({
            ...prefs.data,
            preview: e.target.value as NotificationPreferences['preview'],
          })
        }
      >
        {PREVIEWS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      {save.error && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      <p className="flex items-start gap-2 text-sm text-muted">
        <Siren className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        Emergency alerts always notify your devices, even when message notifications are off or a
        chat is muted.
      </p>
    </div>
  );
}
