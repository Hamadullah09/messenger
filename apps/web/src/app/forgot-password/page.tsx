'use client';

import { MailCheck, Send } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ emailEnabled: boolean } | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(
        await api<{ emailEnabled: boolean }>('/auth/password/forgot', {
          method: 'POST',
          body: { identifier: identifier.trim() },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="Enter your username or the email address on your account. We’ll email you a link to choose a new password."
    >
      {sent ? (
        <div className="flex flex-col gap-5">
          {sent.emailEnabled ? (
            <Alert tone="success" title="Check your email">
              If an account matches, we’ve sent a reset link to its email address. The link works
              once and expires soon. Didn’t get it? Check spam, or ask your manager or administrator
              to set a new password for you.
            </Alert>
          ) : (
            <Alert tone="warning" title="Email is not set up">
              This system cannot send email yet. Ask your store manager or administrator to set a
              new password for you.
            </Alert>
          )}
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand px-5 font-semibold text-brand-contrast hover:opacity-90"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label="Username or email"
            name="identifier"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            busy={busy}
            disabled={identifier.trim().length < 3}
            icon={<Send className="size-5" aria-hidden />}
          >
            Send reset link
          </Button>
          <Link href="/login" className="self-center font-semibold text-brand hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
      <p className="mt-6 flex items-start gap-2 text-sm text-muted">
        <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        For your security we never say whether an account exists.
      </p>
    </AuthCard>
  );
}
