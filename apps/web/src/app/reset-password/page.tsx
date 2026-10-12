'use client';

import { PASSWORD_MIN_LENGTH } from '@storeline/shared';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The emailed link carries the token in the URL fragment (never sent to any server).
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(value);
    // Remove it from the address bar and history.
    if (value) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN_LENGTH)
      return setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await api('/auth/password/reset', {
        method: 'POST',
        body: { token, newPassword: password },
      });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password" subtitle="You’ll use it the next time you sign in.">
      {done ? (
        <div className="flex flex-col gap-5">
          <Alert tone="success" title="Password changed">
            Your new password is ready. For safety, you were signed out on all devices.
          </Alert>
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand px-5 font-semibold text-brand-contrast hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      ) : token === null ? (
        <div className="flex flex-col gap-5">
          <Alert tone="warning" title="Open the link from your email">
            This page needs the reset link we emailed you. Ask for a new link if it has expired.
          </Alert>
          <Link href="/forgot-password" className="font-semibold text-brand hover:underline">
            Send a new link
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label="Repeat new password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            busy={busy}
            icon={<KeyRound className="size-5" aria-hidden />}
          >
            Save new password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
