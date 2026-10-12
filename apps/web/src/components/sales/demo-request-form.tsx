'use client';

import { CheckCircle2, Send } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, TextArea, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/**
 * "Request a demo": becomes a WEBSITE lead in Sales & Marketing (unassigned queue). Used on
 * the app's own page and, embedded, on the company website.
 */
export function DemoRequestForm({
  sourceDetail,
  afterSent,
}: {
  /** Where it was filled in (shown on the lead). */
  sourceDetail?: string;
  afterSent?: ReactNode;
}) {
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
          ...(sourceDetail ? { sourceDetail: sourceDetail.slice(0, 160) } : {}),
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

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <CheckCircle2 className="size-12 text-success" aria-hidden />
        <p className="text-lg font-semibold">Thank you! We’ll be in touch soon.</p>
        {afterSent}
      </div>
    );
  }
  return (
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
        <TextField label="City" value={form.city} onChange={(e) => set({ city: e.target.value })} />
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
  );
}
