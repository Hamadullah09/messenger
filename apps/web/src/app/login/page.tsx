'use client';

import { LogIn, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { BRAND, BrandMark } from '@/components/brand';
import { Alert, Button, TextField } from '@/components/ui';
import { errorMessage, login, verifyMfa } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';

export default function LoginPage() {
  const router = useRouter();
  const status = useAuth((s) => s.status);
  const setSession = useAuth((s) => s.setSession);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-in') router.replace('/dashboard');
  }, [status, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = mfaToken ? await verifyMfa(mfaToken, code) : await login(username, password);
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken);
        setPassword('');
        return;
      }
      setSession(result.accessToken, result.accessTokenExpiresAt, result.me);
      router.replace('/dashboard');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel (large screens). Fixed SMA orange so white text keeps 5:1 in both themes. */}
      <section
        aria-label={BRAND.company}
        className="relative hidden overflow-hidden bg-[#c2410c] p-12 text-white lg:flex lg:flex-col lg:justify-between"
      >
        <div className="relative z-10 w-fit rounded-3xl bg-white p-5 shadow-pop">
          <img
            src="/brand/sma-logo.webp"
            alt="SMA Technology"
            width={320}
            height={185}
            className="h-auto w-80"
          />
        </div>
        <div className="relative z-10 max-w-md">
          <p className="text-4xl leading-tight font-bold">
            Every store, every team, one conversation.
          </p>
          <ul className="mt-8 space-y-4 text-lg text-white/95">
            <li className="flex items-center gap-3">
              <span className="size-2.5 rounded-full bg-white" aria-hidden /> Chat with your store
              and your managers
            </li>
            <li className="flex items-center gap-3">
              <span className="size-2.5 rounded-full bg-white" aria-hidden /> Share photos and
              documents safely
            </li>
            <li className="flex items-center gap-3">
              <span className="size-2.5 rounded-full bg-white" aria-hidden /> Your phone number
              stays private
            </li>
          </ul>
        </div>
        <div
          className="absolute -right-24 -bottom-24 size-96 rounded-full bg-white/10"
          aria-hidden
        />
        <div className="absolute -right-8 -bottom-8 size-56 rounded-full bg-black/10" aria-hidden />
        <p className="relative z-10 text-sm text-white">
          © {new Date().getFullYear()} {BRAND.company}
        </p>
      </section>

      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-10">
          <div className="mb-8 lg:hidden">
            <BrandMark size={52} />
          </div>
          <div className="mb-6">
            <h1 className="text-3xl font-bold tracking-tight">
              {mfaToken ? 'One more step' : 'Welcome back'}
            </h1>
            <p className="mt-1 text-muted">
              {mfaToken
                ? 'Confirm it’s you with your authenticator app.'
                : 'Sign in to talk with your team.'}
            </p>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
            {error && <Alert tone="error">{error}</Alert>}
            {!mfaToken ? (
              <>
                <TextField
                  label="Username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <TextField
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Link
                  href="/forgot-password"
                  className="-mt-2 self-end rounded-lg px-1 font-semibold text-brand hover:underline"
                >
                  Forgot password?
                </Link>
                <Button
                  type="submit"
                  size="lg"
                  busy={busy}
                  icon={<LogIn className="size-5" aria-hidden />}
                >
                  Sign in
                </Button>
              </>
            ) : (
              <>
                <Alert tone="info" title="Two-step verification">
                  Open your authenticator app and enter the 6-digit code for SMA.
                </Alert>
                <TextField
                  label="6-digit code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <Button
                  type="submit"
                  size="lg"
                  busy={busy}
                  icon={<ShieldCheck className="size-5" aria-hidden />}
                >
                  Verify and sign in
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setMfaToken(null);
                    setCode('');
                  }}
                >
                  Start again
                </Button>
              </>
            )}
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            <Link href="/privacy" className="underline">
              Privacy
            </Link>{' '}
            ·{' '}
            <Link href="/terms" className="underline">
              Terms
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
