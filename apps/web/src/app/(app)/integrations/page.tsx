'use client';

import type { IntegrationKey, IntegrationsDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, MessageSquare, Phone, Plug, XCircle, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, cx, PageHeader, Spinner, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

const CHANNELS: Array<{
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  title: string;
  Icon: LucideIcon;
  intro: string;
  keys: Array<{ key: IntegrationKey; label: string; hint: string; placeholder?: string }>;
  testHint: string;
}> = [
  {
    channel: 'EMAIL',
    title: 'Email',
    Icon: Mail,
    intro: 'Your mail server (SMTP). Used for password resets, invoices and email campaigns.',
    keys: [
      { key: 'SMTP_URL', label: 'Mail server', hint: 'smtp://user:password@host:587 — from your email provider', placeholder: 'smtp://user:password@smtp.example.com:587' },
      { key: 'MAIL_FROM', label: 'Send as', hint: 'Name and address people see', placeholder: 'SMA Technology <hello@yourdomain.com>' },
    ],
    testHint: 'Email address',
  },
  {
    channel: 'SMS',
    title: 'SMS (Twilio)',
    Icon: Phone,
    intro: 'Text messages through a Twilio account (twilio.com → Console).',
    keys: [
      { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', hint: 'Starts with AC' },
      { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', hint: 'Kept secret; only the last 4 characters are shown' },
      { key: 'TWILIO_FROM', label: 'Sender', hint: 'Your Twilio number (+1…) or a Messaging Service SID (MG…)' },
    ],
    testHint: 'Phone number, e.g. +923001234567',
  },
  {
    channel: 'WHATSAPP',
    title: 'WhatsApp Business (Meta)',
    Icon: MessageSquare,
    intro:
      'WhatsApp messages through Meta’s Cloud API. Campaigns use an approved template with two variables: {{1}} customer name, {{2}} message.',
    keys: [
      { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone number ID', hint: 'From Meta Business → WhatsApp → API setup' },
      { key: 'WHATSAPP_ACCESS_TOKEN', label: 'Access token', hint: 'A permanent system-user token' },
      { key: 'WHATSAPP_TEMPLATE_NAME', label: 'Template name', hint: 'An approved template with {{1}} and {{2}}' },
      { key: 'WHATSAPP_TEMPLATE_LANGUAGE', label: 'Template language', hint: 'e.g. en, en_US, ur', placeholder: 'en' },
    ],
    testHint: 'WhatsApp number, e.g. +923001234567',
  },
];

export default function IntegrationsPage() {
  const data = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<IntegrationsDto>('/platform/integrations'),
  });
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Integrations"
          subtitle="Connect email, SMS and WhatsApp so campaigns and invoices actually go out."
        />
        <Alert tone="info">
          Keys are stored encrypted and never shown again in full. Values set here replace the
          server’s settings file. Sending through these providers may cost money on your account.
        </Alert>
        {data.isPending && <Spinner />}
        {data.isError && <Alert tone="error">{errorMessage(data.error)}</Alert>}
        {data.data &&
          CHANNELS.map((c) => <ChannelCard key={c.channel} config={c} data={data.data} />)}
      </div>
    </div>
  );
}

function ChannelCard({ config, data }: { config: (typeof CHANNELS)[number]; data: IntegrationsDto }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Partial<Record<IntegrationKey, string>>>({});
  const [to, setTo] = useState('');
  const ready = data.channels[config.channel];
  const save = useMutation({
    mutationFn: (payload: Partial<Record<IntegrationKey, string | null>>) =>
      api<IntegrationsDto>('/platform/integrations', { method: 'PUT', body: { values: payload } }),
    onSuccess: (next) => {
      client.setQueryData(['integrations'], next);
      setValues({});
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; detail: string }>('/platform/integrations/test', {
        method: 'POST',
        body: { channel: config.channel, to: to.trim() },
      }),
  });
  const changed = Object.entries(values).filter(([, v]) => v !== undefined && v !== '');
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand-soft text-brand-strong">
          <config.Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">{config.title}</h2>
          <p className="text-sm text-muted">{config.intro}</p>
        </div>
        <span
          className={cx(
            'inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold',
            ready ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted',
          )}
        >
          {ready ? <CheckCircle2 className="size-4" aria-hidden /> : <Plug className="size-4" aria-hidden />}
          {ready ? 'Connected' : 'Not set up'}
        </span>
      </div>
      {save.isError && <div className="mt-3"><Alert tone="error">{errorMessage(save.error)}</Alert></div>}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {config.keys.map((k) => {
          const current = data.keys.find((x) => x.key === k.key);
          return (
            <div key={k.key}>
              <TextField
                label={k.label}
                hint={
                  current?.preview
                    ? `Now: ${current.preview} (${current.source === 'app' ? 'set here' : 'server file'}) · ${k.hint}`
                    : k.hint
                }
                type={current?.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={k.placeholder ?? (current?.preview ? 'Leave empty to keep' : '')}
                value={values[k.key] ?? ''}
                onChange={(e) => setValues({ ...values, [k.key]: e.target.value })}
              />
              {current?.source === 'app' && (
                <button
                  type="button"
                  className="mt-1 text-sm font-semibold text-danger"
                  onClick={() => save.mutate({ [k.key]: null })}
                >
                  Remove the value set here
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <Button busy={save.isPending} disabled={changed.length === 0} onClick={() => save.mutate(Object.fromEntries(changed))}>
          Save {config.title}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <TextField label="Send a test message to" placeholder={config.testHint} className="min-w-60 flex-1" value={to} onChange={(e) => setTo(e.target.value)} />
        <Button variant="secondary" busy={test.isPending} disabled={!ready || to.trim().length < 3} onClick={() => test.mutate()}>
          Send test
        </Button>
      </div>
      {test.data && (
        <p className={cx('mt-2 flex items-center gap-1 text-sm font-semibold', test.data.ok ? 'text-success' : 'text-danger')} role="status">
          {test.data.ok ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
          {test.data.detail}
        </p>
      )}
      {test.isError && <p className="mt-2 text-sm font-semibold text-danger">{errorMessage(test.error)}</p>}
    </section>
  );
}
