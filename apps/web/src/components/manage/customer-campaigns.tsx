'use client';

import {
  CUSTOMER_CAMPAIGN_NAME_TOKEN,
  MARKETING_CHANNELS,
  type CustomerCampaignDetailDto,
  type CustomerCampaignDto,
  type CustomerCampaignPreviewDto,
  type MarketingChannel,
  type MarketingChannelsDto,
  type StoreDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Megaphone, MessageSquareText, Plus, Send, Smartphone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatDay, formatRelativeShort } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import {
  Alert,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  EmptyState,
  Spinner,
  TextArea,
  TextField,
} from '../ui';

const CHANNEL: Record<MarketingChannel, { label: string; Icon: typeof Mail; needs: string }> = {
  EMAIL: { label: 'Email', Icon: Mail, needs: 'customers with an email address' },
  SMS: { label: 'SMS', Icon: Smartphone, needs: 'customers with a phone number' },
  WHATSAPP: { label: 'WhatsApp', Icon: MessageSquareText, needs: 'customers with a phone number' },
};

const STATUS: Record<CustomerCampaignDto['status'], { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-surface-3 text-muted' },
  SENDING: { label: 'Sending', cls: 'bg-brand-soft text-brand-strong' },
  COMPLETED: { label: 'Finished', cls: 'bg-success-soft text-success' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-warning-surface text-warning' },
};

function Progress({ c }: { c: CustomerCampaignDto['counts'] }) {
  const pct = (n: number) => `${c.total ? (n / c.total) * 100 : 0}%`;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="bg-success" style={{ width: pct(c.sent) }} />
        <span className="bg-danger" style={{ width: pct(c.failed) }} />
        <span className="bg-warning" style={{ width: pct(c.skipped) }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {c.sent} sent · {c.failed} failed · {c.skipped} skipped · {c.pending} waiting
      </p>
    </div>
  );
}

/** Campaigns from the business to its store customers who agreed to marketing. */
export function CustomerCampaignsPanel({
  businessId,
  stores,
}: {
  businessId: string;
  stores: StoreDto[];
}) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const channels = useQuery({
    queryKey: ['marketing-channels'],
    queryFn: () => api<MarketingChannelsDto>('/marketing/channels'),
  });
  const campaigns = useQuery({
    queryKey: ['customer-campaigns', businessId],
    queryFn: () => api<CustomerCampaignDto[]>(`/businesses/${businessId}/customer-campaigns`),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'SENDING') ? 3000 : false),
  });
  const ready = channels.data ? MARKETING_CHANNELS.filter((c) => channels.data[c]) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {MARKETING_CHANNELS.map((c) => {
            const on = channels.data?.[c];
            const { Icon, label } = CHANNEL[c];
            return (
              <span
                key={c}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold',
                  on ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted',
                )}
              >
                <Icon className="size-4" aria-hidden /> {label}: {on ? 'ready' : 'not set up'}
              </span>
            );
          })}
        </div>
        <span className="flex-1" />
        <Button
          disabled={ready.length === 0}
          onClick={() => setCreating(true)}
          icon={<Plus className="size-5" aria-hidden />}
        >
          New campaign
        </Button>
      </div>
      {channels.data && ready.length < 3 && (
        <p className="text-sm text-muted">
          A channel that is not set up needs its provider account keys on the server (Twilio for
          SMS, Meta WhatsApp Business for WhatsApp, a mail server for email).
        </p>
      )}
      {campaigns.isLoading && <Spinner label="Loading campaigns" />}
      {campaigns.isError && <Alert tone="error">{errorMessage(campaigns.error)}</Alert>}
      {campaigns.data?.length === 0 && (
        <EmptyState icon={<Megaphone className="size-9" aria-hidden />} title="No campaigns yet">
          Send an offer or announcement to customers who agreed to hear from you.
        </EmptyState>
      )}
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {campaigns.data?.map((c) => {
          const { Icon, label } = CHANNEL[c.channel];
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setOpen(c.id)}
                className="flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface p-4 text-left shadow-card hover:border-brand/40"
              >
                <div className="flex items-start gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{c.name}</span>
                    <span className="block text-sm text-muted">
                      {label} · {c.createdBy ?? 'Someone'} · {formatRelativeShort(c.createdAt)}
                    </span>
                  </span>
                  <span
                    className={cx(
                      'rounded-full px-2.5 py-0.5 text-xs font-bold',
                      STATUS[c.status].cls,
                    )}
                  >
                    {STATUS[c.status].label}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm">{c.body}</p>
                {c.status !== 'DRAFT' && <Progress c={c.counts} />}
              </button>
            </li>
          );
        })}
      </ul>
      {creating && channels.data && (
        <NewCampaignDialog
          businessId={businessId}
          stores={stores}
          channels={channels.data}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpen(id);
          }}
        />
      )}
      {open && (
        <CampaignDialog campaignId={open} businessId={businessId} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function NewCampaignDialog({
  businessId,
  stores,
  channels,
  onClose,
  onCreated,
}: {
  businessId: string;
  stores: StoreDto[];
  channels: MarketingChannelsDto;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const client = useQueryClient();
  const first = MARKETING_CHANNELS.find((c) => channels[c]) ?? 'EMAIL';
  const [form, setForm] = useState({
    name: '',
    channel: first as MarketingChannel,
    subject: '',
    body: `Hi ${CUSTOMER_CAMPAIGN_NAME_TOKEN}, `,
    storeIds: new Set<string>(),
    tags: '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const tags = form.tags
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const audienceKey = useDebounced(JSON.stringify([form.channel, [...form.storeIds], tags]));
  const [preview, setPreview] = useState<CustomerCampaignPreviewDto | null>(null);
  useEffect(() => {
    const [channel, storeIds, t] = JSON.parse(audienceKey) as [
      MarketingChannel,
      string[],
      string[],
    ];
    let cancelled = false;
    api<CustomerCampaignPreviewDto>(`/businesses/${businessId}/customer-campaigns/preview`, {
      method: 'POST',
      body: { channel, storeIds, tags: t },
    })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [audienceKey, businessId]);

  const create = useMutation({
    mutationFn: () =>
      api<CustomerCampaignDto>(`/businesses/${businessId}/customer-campaigns`, {
        method: 'POST',
        body: {
          name: form.name.trim(),
          channel: form.channel,
          ...(form.channel === 'EMAIL' ? { subject: form.subject.trim() } : {}),
          body: form.body.trim(),
          storeIds: [...form.storeIds],
          tags,
        },
      }),
    onSuccess: (c) => {
      void client.invalidateQueries({ queryKey: ['customer-campaigns', businessId] });
      onCreated(c.id);
    },
  });
  const example = form.body.split(CUSTOMER_CAMPAIGN_NAME_TOKEN).join('Ayesha');
  const smsParts = Math.max(1, Math.ceil((form.body.length + 60) / 153));

  return (
    <Dialog open onClose={onClose} title="New campaign" wide>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <TextField
          label="Campaign name (only you see this)"
          required
          placeholder="e.g. Eid sale 2026"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <fieldset>
          <legend className="mb-2 font-semibold">Send by</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {MARKETING_CHANNELS.map((c) => {
              const { Icon, label } = CHANNEL[c];
              const on = channels[c];
              return (
                <label
                  key={c}
                  className={cx(
                    'flex min-h-14 items-center gap-3 rounded-xl border px-4',
                    !on && 'cursor-not-allowed opacity-50',
                    form.channel === c ? 'border-brand bg-brand-soft' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="channel"
                    className="size-5 accent-[var(--brand)]"
                    disabled={!on}
                    checked={form.channel === c}
                    onChange={() => set({ channel: c })}
                  />
                  <Icon className="size-5" aria-hidden />
                  <span className="font-semibold">
                    {label}
                    {!on && <span className="block text-xs font-normal">Not set up</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-semibold">Who gets it</legend>
          {stores.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {stores.map((s) => {
                const on = form.storeIds.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const next = new Set(form.storeIds);
                      if (on) next.delete(s.id);
                      else next.add(s.id);
                      set({ storeIds: next });
                    }}
                    className={cx(
                      'rounded-full border px-3 py-1.5 text-sm font-semibold',
                      on
                        ? 'border-brand bg-brand-soft text-brand-strong'
                        : 'border-line hover:bg-surface-2',
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-sm text-muted">
            {form.storeIds.size === 0 ? 'All stores.' : `${form.storeIds.size} store(s) selected.`}
          </p>
          <TextField
            label="Only customers with these tags (optional)"
            hint="Comma separated, e.g. vip, wholesale"
            value={form.tags}
            onChange={(e) => set({ tags: e.target.value })}
          />
          <div className="rounded-2xl bg-surface-2 p-3 text-sm">
            {preview ? (
              <>
                <span className="text-lg font-bold">{preview.recipients}</span> customers will get
                it (they agreed to marketing and have{' '}
                {CHANNEL[form.channel].needs.split('with ')[1]}).
                {preview.missingContact > 0 &&
                  ` ${preview.missingContact} more agreed but have no ${form.channel === 'EMAIL' ? 'email' : 'phone number'}.`}
              </>
            ) : (
              'Counting…'
            )}
          </div>
        </fieldset>

        {form.channel === 'EMAIL' && (
          <TextField
            label="Email subject"
            required
            value={form.subject}
            onChange={(e) => set({ subject: e.target.value })}
          />
        )}
        <TextArea
          label="Message"
          hint={`Write ${CUSTOMER_CAMPAIGN_NAME_TOKEN} to insert each customer's first name. An unsubscribe link is added automatically.`}
          rows={5}
          maxLength={1500}
          required
          value={form.body}
          onChange={(e) => set({ body: e.target.value })}
        />
        <p className="-mt-3 text-xs text-muted">
          {form.body.length}/1500 characters
          {form.channel === 'SMS'
            ? ` · about ${smsParts} SMS part${smsParts > 1 ? 's' : ''} each`
            : ''}
          {form.channel === 'WHATSAPP' ? ' · sent through your approved WhatsApp template' : ''}
        </p>
        <div className="rounded-2xl border border-dashed border-line p-3">
          <p className="mb-1 text-xs font-bold tracking-wide text-muted uppercase">Preview</p>
          <p className="text-sm whitespace-pre-wrap">{example}</p>
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={create.isPending}
            disabled={!form.name.trim() || !form.body.trim() || !channels[form.channel]}
          >
            Save and review
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CampaignDialog({
  campaignId,
  businessId,
  onClose,
}: {
  campaignId: string;
  businessId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<'send' | 'cancel' | null>(null);
  const campaign = useQuery({
    queryKey: ['customer-campaign', campaignId],
    queryFn: () => api<CustomerCampaignDetailDto>(`/customer-campaigns/${campaignId}`),
    refetchInterval: (q) => (q.state.data?.status === 'SENDING' ? 2500 : false),
  });
  const preview = useQuery({
    queryKey: ['customer-campaign-preview', campaignId],
    queryFn: () =>
      api<CustomerCampaignPreviewDto>(`/businesses/${businessId}/customer-campaigns/preview`, {
        method: 'POST',
        body: {
          channel: campaign.data!.channel,
          storeIds: campaign.data!.audience.storeIds,
          tags: campaign.data!.audience.tags,
        },
      }),
    enabled: campaign.data?.status === 'DRAFT',
  });
  const act = useMutation({
    mutationFn: (what: 'send' | 'cancel') =>
      api<CustomerCampaignDetailDto>(`/customer-campaigns/${campaignId}/${what}`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setConfirm(null);
      client.setQueryData(['customer-campaign', campaignId], data);
      void client.invalidateQueries({ queryKey: ['customer-campaigns', businessId] });
    },
  });
  const c = campaign.data;
  return (
    <Dialog open onClose={onClose} title={c?.name ?? 'Campaign'} wide>
      {!c ? (
        <Spinner label="Loading campaign" />
      ) : (
        <div className="flex flex-col gap-5">
          {act.isError && <Alert tone="error">{errorMessage(act.error)}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', STATUS[c.status].cls)}
            >
              {STATUS[c.status].label}
            </span>
            <span className="text-sm text-muted">
              {CHANNEL[c.channel].label} · created {formatDay(c.createdAt)}
              {c.createdBy ? ` by ${c.createdBy}` : ''}
              {c.audience.tags.length ? ` · tags: ${c.audience.tags.join(', ')}` : ''}
            </span>
          </div>
          <div className="rounded-2xl bg-surface-2 p-4">
            {c.subject && <p className="mb-1 font-bold">{c.subject}</p>}
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </div>
          {c.status === 'DRAFT' ? (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-4">
              <p className="flex-1">
                {preview.data
                  ? `Ready to send to ${preview.data.recipients} customers who agreed to marketing.`
                  : 'Counting customers…'}
              </p>
              <Button
                variant="ghost"
                icon={<X className="size-5" aria-hidden />}
                onClick={() => setConfirm('cancel')}
              >
                Discard
              </Button>
              <Button
                icon={<Send className="size-5" aria-hidden />}
                disabled={!preview.data?.recipients}
                onClick={() => setConfirm('send')}
              >
                Send now
              </Button>
            </div>
          ) : (
            <>
              <Progress c={c.counts} />
              <p className="text-xs text-muted">
                “Sent” means the {c.channel === 'EMAIL' ? 'mail server' : 'provider'} accepted the
                message; it does not prove the customer received or read it.
              </p>
              {c.status === 'SENDING' && (
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => setConfirm('cancel')}
                >
                  Stop sending
                </Button>
              )}
              <div className="scroll-thin max-h-80 overflow-auto rounded-2xl border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-surface-2 text-muted">
                    <tr>
                      <th className="p-2.5 font-semibold">Customer</th>
                      <th className="p-2.5 font-semibold">To</th>
                      <th className="p-2.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.recipients.map((r) => (
                      <tr key={r.customerId} className="border-t border-line">
                        <td className="p-2.5">{r.name}</td>
                        <td className="p-2.5 text-muted">{r.destination}</td>
                        <td
                          className={cx(
                            'p-2.5 font-semibold',
                            r.state === 'SENT' && 'text-success',
                            r.state === 'FAILED' && 'text-danger',
                            r.state === 'SKIPPED' && 'text-warning',
                          )}
                        >
                          {r.state === 'PENDING' || r.state === 'SENDING'
                            ? 'Waiting'
                            : r.state.charAt(0) + r.state.slice(1).toLowerCase()}
                          {r.error && (
                            <span className="block text-xs font-normal text-muted">{r.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'send' ? 'Send this campaign now?' : 'Stop this campaign?'}
        message={
          confirm === 'send'
            ? `It goes to ${preview.data?.recipients ?? 0} customers by ${c ? CHANNEL[c.channel].label : ''}. This cannot be undone.`
            : 'Messages not sent yet will be skipped.'
        }
        confirmLabel={confirm === 'send' ? 'Send now' : 'Stop campaign'}
        danger={confirm === 'cancel'}
        busy={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && act.mutate(confirm)}
      />
    </Dialog>
  );
}
