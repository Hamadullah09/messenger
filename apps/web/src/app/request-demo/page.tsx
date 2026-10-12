'use client';

import { CheckCircle2, Send } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, TextArea, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Public website form: becomes a WEBSITE lead in Sales & Marketing. */
export default function RequestDemoPage() {
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    city: '',
    storeCount: '',
    message: '',
    website: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/public/leads', {
        method: 'POST',
        body: {
          companyName: form.companyName.trim(),
          contactName: form.contactName.trim(),
          email: form.email.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(form.city.trim() ? { city: form.city.trim() } : {}),
          ...(form.storeCount ? { storeCount: Number(form.storeCount) } : {}),
          ...(form.message.trim() ? { message: form.message.trim() } : {}),
          country: 'PK',
          website: form.website,
        },
      });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Request a demo"
      subtitle="Tell us about your business and our team will contact you to show how SMA works for your stores."
    >
      {sent ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <CheckCircle2 className="size-12 text-success" aria-hidden />
          <p className="text-lg font-semibold">Thank you! We’ll be in touch soon.</p>
          <Link href="/login" className="font-semibold text-brand hover:underline">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label="Business name"
            required
            value={form.companyName}
            onChange={(e) => set({ companyName: e.target.value })}
          />
          <TextField
            label="Your name"
            required
            value={form.contactName}
            onChange={(e) => set({ contactName: e.target.value })}
          />
          <TextField
            label="Email"
            type="email"
            required
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
          <TextField
            label="Phone (optional)"
            type="tel"
            hint="International format, e.g. +923001234567"
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="City"
              value={form.city}
              onChange={(e) => set({ city: e.target.value })}
            />
            <TextField
              label="Number of stores"
              type="number"
              min={0}
              value={form.storeCount}
              onChange={(e) => set({ storeCount: e.target.value })}
            />
          </div>
          <TextArea
            label="Anything we should know? (optional)"
            rows={3}
            maxLength={1000}
            value={form.message}
            onChange={(e) => set({ message: e.target.value })}
          />
          {/* Honeypot: hidden from people, filled by bots. */}
          <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
            <label>
              Website
              <input
                tabIndex={-1}
                autoComplete="off"
                value={form.website}
                onChange={(e) => set({ website: e.target.value })}
              />
            </label>
          </div>
          <Button
            type="submit"
            size="lg"
            busy={busy}
            disabled={!form.companyName.trim() || !form.contactName.trim() || !form.email.trim()}
            icon={<Send className="size-5" aria-hidden />}
          >
            Request a demo
          </Button>
          <p className="text-sm text-muted">We use these details only to contact you about SMA.</p>
        </form>
      )}
    </AuthCard>
  );
}
