'use client';

import type { BusinessBillingDto, SmaPlanKey, SmaPlanOptionDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, cx, Dialog, Spinner, TextField } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { formatDay } from '@/lib/format';

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS: Record<BusinessBillingDto['status'], { label: string; cls: string }> = {
  TRIAL: { label: 'Free trial', cls: 'bg-brand-soft text-brand-strong' },
  ACTIVE: { label: 'Active', cls: 'bg-success-soft text-success' },
  PAST_DUE: { label: 'Payment due', cls: 'bg-danger-surface text-danger' },
  SUSPENDED: { label: 'Suspended', cls: 'bg-danger-surface text-danger' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-surface-3 text-muted' },
};

/**
 * Used vs allowed. The fill carries severity (blue → amber from 80% → red when full) and the
 * track is a lighter step of the same colour; the words always say it too.
 */
function UsageMeter({
  label,
  used,
  limit,
  unit = '',
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
}) {
  const share = limit > 0 ? Math.min(1, used / limit) : 1;
  const full = used >= limit;
  const near = !full && share >= 0.8;
  const color = full ? 'var(--color-danger)' : near ? 'var(--color-warning)' : 'var(--series-1)';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{label}</span>
        <span className="text-sm text-muted">
          {used.toLocaleString('en-US')}
          {unit} of {limit.toLocaleString('en-US')}
          {unit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-valuetext={`${used}${unit} of ${limit}${unit}`}
        className="h-2.5 overflow-hidden rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%`, background: color }}
        />
      </div>
      {(full || near) && (
        <span
          className={cx(
            'flex items-center gap-1 text-sm font-semibold',
            full ? 'text-danger' : 'text-warning',
          )}
        >
          <AlertTriangle className="size-4" aria-hidden />{' '}
          {full ? 'Limit reached' : 'Near the limit'}
        </span>
      )}
    </div>
  );
}

function ChangePlanDialog({
  billing,
  onClose,
}: {
  billing: BusinessBillingDto;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const plans = useQuery({
    queryKey: ['sma-plans'],
    queryFn: () => api<SmaPlanOptionDto[]>('/platform/sma-plans'),
  });
  const [plan, setPlan] = useState<SmaPlanKey>(billing.plan);
  const [autoBill, setAutoBill] = useState(true);
  const [trialDays, setTrialDays] = useState(14);
  const save = useMutation({
    mutationFn: () =>
      api<BusinessBillingDto>(`/businesses/${billing.businessId}/plan`, {
        method: 'PUT',
        body: plan === 'TRIAL' ? { plan, trialDays } : { plan, autoBill },
      }),
    onSuccess: (data) => {
      client.setQueryData(['business-billing', billing.businessId], data);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Change plan" wide>
      <div className="flex flex-col gap-4">
        {plans.isPending && <Spinner />}
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <div role="radiogroup" aria-label="Plan" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {plans.data?.map((p) => (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={plan === p.key}
              onClick={() => setPlan(p.key)}
              className={cx(
                'flex flex-col gap-1 rounded-2xl border p-3 text-left',
                plan === p.key ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2',
              )}
            >
              <span className="font-bold">{p.name}</span>
              <span className="text-sm">
                {p.price > 0
                  ? `${money(p.price, p.currency)} ${p.perStore ? 'per store ' : ''}a month`
                  : 'Free'}
              </span>
              <span className="text-sm text-muted">{p.summary}</span>
            </button>
          ))}
        </div>
        {plan === 'TRIAL' ? (
          <TextField
            label="Trial length (days)"
            type="number"
            min={1}
            max={90}
            value={trialDays}
            onChange={(e) => setTrialDays(Number(e.target.value))}
          />
        ) : (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-5 accent-[var(--color-brand)]"
              checked={autoBill}
              onChange={(e) => setAutoBill(e.target.checked)}
            />
            <span>
              <span className="font-semibold">Bill monthly through SMA</span>
              <span className="block text-sm text-muted">
                An invoice is created and emailed every month (per-store plans count the active
                stores). Untick to apply the limits only and arrange payment by hand.
              </span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            Save plan
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Administration → Plan & billing: what the business pays SMA, its limits and invoices. */
export function PlanBillingTab({ businessId }: { businessId: string }) {
  const [changing, setChanging] = useState(false);
  const billing = useQuery({
    queryKey: ['business-billing', businessId],
    queryFn: () => api<BusinessBillingDto>(`/businesses/${businessId}/billing`),
  });
  if (billing.isPending) return <Spinner label="Loading plan" />;
  if (billing.isError) return <Alert tone="error">{errorMessage(billing.error)}</Alert>;
  const b = billing.data;
  const status = STATUS[b.status];
  const trialDaysLeft = b.trialEndsAt
    ? Math.ceil((Date.parse(b.trialEndsAt) - Date.now()) / 86_400_000)
    : null;
  return (
    <div className="flex flex-col gap-5">
      {b.status === 'PAST_DUE' && (
        <Alert
          tone="error"
          title={b.plan === 'TRIAL' ? 'The free trial has ended' : 'An SMA invoice is overdue'}
        >
          {b.plan === 'TRIAL'
            ? 'Choose a plan to keep using SMA without interruption.'
            : 'Please pay the overdue invoice below to avoid your account being suspended.'}
        </Alert>
      )}
      <section className="flex flex-wrap items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-muted">Your plan</p>
          <p className="flex flex-wrap items-center gap-2 text-2xl font-bold">
            {b.planName}
            <span className={cx('rounded-full px-2.5 py-0.5 text-sm font-bold', status.cls)}>
              {status.label}
            </span>
          </p>
          <p className="mt-1 text-muted">
            {b.status === 'TRIAL' && trialDaysLeft !== null
              ? `${Math.max(0, trialDaysLeft)} days left (ends ${formatDay(b.trialEndsAt!)})`
              : b.autoBilled && b.monthlyAmount !== null
                ? `${money(b.monthlyAmount, b.currency)} a month · next invoice ${b.nextInvoiceAt ? formatDay(b.nextInvoiceAt) : '—'}`
                : 'Billing arranged with SMA'}
          </p>
        </div>
        {b.canChangePlan && (
          <Button
            icon={<CreditCard className="size-5" aria-hidden />}
            onClick={() => setChanging(true)}
          >
            Change plan
          </Button>
        )}
      </section>

      <section className="grid grid-cols-1 gap-5 rounded-3xl border border-line bg-surface p-5 shadow-card md:grid-cols-3">
        <UsageMeter label="Stores" used={b.usage.stores} limit={b.limits.maxStores} />
        <UsageMeter label="People" used={b.usage.users} limit={b.limits.maxUsers} />
        <UsageMeter
          label="File storage"
          used={b.usage.storageGb}
          limit={b.limits.maxStorageGb}
          unit=" GB"
        />
        <p className="text-sm text-muted md:col-span-3">
          Customer campaigns:{' '}
          {b.limits.maxCampaignSize > 0
            ? `up to ${b.limits.maxCampaignSize.toLocaleString('en-US')} customers each`
            : 'not included in this plan'}
          . Need more? Ask SMA to change your plan.
        </p>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-lg font-bold">Invoices from SMA</h2>
        {b.invoices.length === 0 ? (
          <p className="text-muted">No invoices yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 font-semibold">Invoice</th>
                <th className="py-1.5 font-semibold">Date</th>
                <th className="py-1.5 text-right font-semibold">Total</th>
                <th className="py-1.5 text-right font-semibold">Due</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id} className="border-t border-line">
                  <td className="py-2 font-semibold">{i.number}</td>
                  <td className="py-2">{formatDay(i.issueDate)}</td>
                  <td className="py-2 text-right tabular-nums">{money(i.total, i.currency)}</td>
                  <td
                    className={cx(
                      'py-2 text-right tabular-nums',
                      i.overdue && 'font-semibold text-danger',
                    )}
                  >
                    {i.balance > 0 ? (
                      <>
                        {money(i.balance, i.currency)}
                        {i.overdue && (
                          <span className="block text-xs">
                            Overdue since {formatDay(i.dueDate)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-success">
                        <CheckCircle2 className="size-4" aria-hidden /> Paid
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {i.payUrl && (
                      <a
                        href={i.payUrl}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 font-semibold text-brand"
                      >
                        Pay <ExternalLink className="size-4" aria-hidden />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <BusinessDataSection businessId={businessId} />
      {changing && <ChangePlanDialog billing={b} onClose={() => setChanging(false)} />}
    </div>
  );
}

/**
 * For owners and admins: a notice when the trial ends within 3 days, has ended, or an SMA
 * invoice is overdue (links to Plan & billing). Nothing for everyone else.
 */
export function PlanNotice({ businessId }: { businessId: string }) {
  const billing = useQuery({
    queryKey: ['business-billing', businessId],
    queryFn: () => api<BusinessBillingDto>(`/businesses/${businessId}/billing`),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const b = billing.data;
  if (!b) return null;
  const daysLeft = b.trialEndsAt
    ? Math.ceil((Date.parse(b.trialEndsAt) - Date.now()) / 86_400_000)
    : null;
  const message =
    b.status === 'SUSPENDED'
      ? 'This business is suspended. Contact SMA.'
      : b.status === 'PAST_DUE'
        ? b.plan === 'TRIAL'
          ? 'Your free trial has ended. Choose a plan to keep using SMA.'
          : 'An SMA invoice is overdue. Please pay it to avoid interruption.'
        : b.status === 'TRIAL' && daysLeft !== null && daysLeft <= 3
          ? `Your free trial ends in ${Math.max(0, daysLeft)} day${daysLeft === 1 ? '' : 's'}.`
          : null;
  if (!message) return null;
  return (
    <div className="px-3 pt-3 sm:px-5">
      <Alert tone={b.status === 'TRIAL' ? 'warning' : 'error'} title={message}>
        <a href="/admin?tab=billing" className="font-bold underline">
          Open Plan & billing
        </a>
      </Alert>
    </div>
  );
}

interface ClosureStatus {
  closureRequestedAt: string | null;
  closureReason: string | null;
  eraseAfterDays: number;
}

/** Owners and admins: download everything, or ask SMA to close the account. */
export function BusinessDataSection({ businessId }: { businessId: string }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const closure = useQuery({
    queryKey: ['business-closure', businessId],
    queryFn: () => api<ClosureStatus>(`/businesses/${businessId}/closure`),
    retry: false,
  });
  const download = useMutation({
    mutationFn: () => downloadFile(`/businesses/${businessId}/export.json`, 'sma-export.json'),
  });
  const change = useMutation({
    mutationFn: (request: boolean) =>
      request
        ? api<ClosureStatus>(`/businesses/${businessId}/closure`, {
            method: 'POST',
            body: { reason: reason.trim() || undefined },
          })
        : api<ClosureStatus>(`/businesses/${businessId}/closure`, { method: 'DELETE' }),
    onSuccess: (data) => {
      client.setQueryData(['business-closure', businessId], data);
      setAsking(false);
    },
  });
  if (closure.isError) return null; // not an owner/admin with two-step login
  const c = closure.data;
  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-card">
      <h2 className="text-lg font-bold">Your data</h2>
      <p className="text-muted">
        Download everything your business has in SMA (people, chats and messages, files list,
        customers, store work, Sales &amp; Marketing) as one file, for your records or to move to
        another system.
      </p>
      {download.isError && <Alert tone="error">{errorMessage(download.error)}</Alert>}
      <div>
        <Button variant="secondary" busy={download.isPending} onClick={() => download.mutate()}>
          Download all data
        </Button>
      </div>
      <hr className="border-line" />
      {c?.closureRequestedAt ? (
        <Alert
          tone="warning"
          title={`You asked SMA to close this account on ${formatDay(c.closureRequestedAt)}`}
        >
          SMA will confirm with you before closing it. After closing, everything is erased for good
          after {c.eraseAfterDays} days.{' '}
          <button
            type="button"
            className="font-bold underline"
            onClick={() => change.mutate(false)}
          >
            Keep my account
          </button>
        </Alert>
      ) : (
        <p className="text-sm text-muted">
          Leaving SMA?{' '}
          <button
            type="button"
            className="font-semibold text-danger underline"
            onClick={() => setAsking(true)}
          >
            Ask to close this account
          </button>
        </p>
      )}
      {asking && (
        <Dialog open onClose={() => setAsking(false)} title="Close this account?">
          <div className="flex flex-col gap-3">
            <Alert tone="warning">
              Download your data first. When SMA closes the account, nobody can sign in to it any
              more, and {c?.eraseAfterDays ?? 30} days later all its messages, files, customers and
              records are erased for good.
            </Alert>
            {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
            <TextField
              label="Why are you leaving? (optional)"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button variant="danger" busy={change.isPending} onClick={() => change.mutate(true)}>
                Ask SMA to close it
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
