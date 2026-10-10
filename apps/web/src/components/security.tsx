'use client';

import type { MeDto, MfaSetupDto, SessionDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, errorMessage, refreshSession } from '@/lib/api';
import { describeUserAgent } from '@/lib/push';
import { useAuth } from '@/lib/auth-store';
import { Alert, Button, Spinner, TextField } from './ui';

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
    onSuccess: async () => {
      setDone(true);
      setCurrent('');
      setNew('');
      setConfirm('');
      const me = await api<MeDto>('/me');
      useAuth.getState().setMe(me);
      onDone?.();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword.length < 12)
      return setError('Use at least 12 characters. A short sentence is easy to remember.');
    if (newPassword !== confirm) return setError('The two new passwords do not match.');
    mutation.mutate();
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      {done && (
        <Alert tone="success">Your password was changed. Other devices were signed out.</Alert>
      )}
      <TextField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <TextField
        label="New password"
        hint="At least 12 characters. A short sentence works well."
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNew(e.target.value)}
        required
      />
      <TextField
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      <Button type="submit" busy={mutation.isPending}>
        Change password
      </Button>
    </form>
  );
}

export function MfaSettings() {
  const me = useAuth((s) => s.me);
  const [setup, setSetup] = useState<MfaSetupDto | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<MfaSetupDto>('/auth/mfa/setup', { method: 'POST' }),
    onSuccess: setSetup,
    onError: (e) => setError(errorMessage(e)),
  });
  const enable = useMutation({
    mutationFn: () => api('/auth/mfa/enable', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      setSetup(null);
      // Refresh so the in-memory profile reflects the MFA-verified session.
      await refreshSession();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (me?.mfaEnabled) {
    return (
      <Alert tone="success" title="Two-step verification is on">
        You will be asked for a code from your authenticator app when you sign in.
      </Alert>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-4">
      {error && <Alert tone="error">{error}</Alert>}
      <p>
        Two-step verification protects your account with a code from an authenticator app (for
        example Microsoft Authenticator or Google Authenticator). It is required for administrator
        features.
      </p>
      {!setup ? (
        <Button
          onClick={() => start.mutate()}
          busy={start.isPending}
          icon={<ShieldCheck className="size-5" aria-hidden />}
        >
          Set up two-step verification
        </Button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            enable.mutate();
          }}
        >
          <ol className="list-decimal space-y-2 pl-6">
            <li>Open your authenticator app and choose “Add account”.</li>
            <li>Scan this QR code, or type the key shown below.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <img
            src={setup.qrCodeDataUrl}
            alt="QR code for your authenticator app"
            width={240}
            height={240}
            className="rounded-xl bg-white p-2"
          />
          <p className="text-sm">
            Key:{' '}
            <code className="rounded bg-surface-2 px-2 py-1 font-mono text-base break-all">
              {setup.secret}
            </code>
          </p>
          <TextField
            label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" busy={enable.isPending}>
            Turn on
          </Button>
        </form>
      )}
    </div>
  );
}

export function SessionsList() {
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionDto[]>('/me/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/me/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api<{ revoked: number }>('/me/sessions', { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sessions'] }),
  });
  if (sessions.isPending) return <Spinner label="Loading devices" />;
  if (sessions.isError) return <Alert tone="error">{errorMessage(sessions.error)}</Alert>;
  const others = sessions.data.filter((s) => !s.current).length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {sessions.data.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3"
          >
            <Laptop className="size-6 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{describeUserAgent(s.userAgent)}</p>
              <p className="text-sm text-muted">
                Last active {new Date(s.lastUsedAt).toLocaleString()}
                {s.current && ' · This device'}
              </p>
            </div>
            {!s.current && (
              <Button
                variant="secondary"
                onClick={() => revoke.mutate(s.id)}
                busy={revoke.isPending && revoke.variables === s.id}
                icon={<LogOut className="size-5" aria-hidden />}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others > 1 && (
        <Button
          variant="secondary"
          busy={revokeOthers.isPending}
          icon={<LogOut className="size-5" aria-hidden />}
          onClick={() => revokeOthers.mutate()}
        >
          Sign out all other devices ({others})
        </Button>
      )}
    </div>
  );
}
