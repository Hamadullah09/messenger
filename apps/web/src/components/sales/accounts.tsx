'use client';

import type { FinanceDashboardDto, FinanceInvoiceRowDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Banknote,
  BellRing,
  CalendarClock,
  CheckCircle2,
  Clock,
  Mail,
  Users,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { money2, moneyShort, monthLabel, PAYMENT_METHOD_LABEL, Stat, TrendChart } from './crm';

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

const dateLabel = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

/** "Due in 3 days", "Due today", "12 days late" — with a status colour and the words. */
function DueLabel({ row }: { row: FinanceInvoiceRowDto }) {
  const late = row.daysLate > 0;
  const today = row.daysLate === 0;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-bold whitespace-nowrap',
        late
          ? 'bg-danger-surface text-danger'
          : today
            ? 'bg-warning-surface text-warning'
            : 'bg-surface-3 text-fg',
      )}
    >
      {late ? (
        <AlertTriangle className="size-3.5" aria-hidden />
      ) : (
        <Clock className="size-3.5" aria-hidden />
      )}
      {late
        ? `${row.daysLate} day${row.daysLate === 1 ? '' : 's'} late`
        : today
          ? 'Due today'
          : `Due in ${-row.daysLate} day${row.daysLate === -1 ? '' : 's'}`}
    </span>
  );
}

type Filter = 'all' | 'late' | 'soon';

/**
 * The accountant's dashboard: money received, money owed, this month's recurring payments
 * (paid, inside the payment window, late) and who to remind — with reminders by email,
 * WhatsApp or SMS as set in CRM settings.
 */
export function AccountsTab() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [note, setNote] = useState<string | null>(null);
  const data = useQuery({
    queryKey: ['crm', 'finance'],
    queryFn: () => api<FinanceDashboardDto>('/sales/crm/finance'),
  });
  const remind = useMutation({
    mutationFn: (v: { invoiceIds: string[]; via: 'email' | 'notify' | 'all' }) =>
      api<{ reminded: number; failed: number }>('/sales/crm/finance/remind', {
        method: 'POST',
        body: v,
      }),
    onSuccess: (r, v) => {
      const what = v.via === 'email' ? 'email' : v.via === 'notify' ? 'notification' : 'reminder';
      setNote(
        r.reminded === 0
          ? v.via === 'email'
            ? 'No email could be sent. Check the customer has an email address and that email is set up (Features & integrations).'
            : v.via === 'notify'
              ? 'Nothing could be sent: the customer is not a business on SMA and WhatsApp/SMS are not set up or there is no phone number.'
              : 'No reminder could be sent. Check that the customers have an email address (or phone for WhatsApp/SMS) and that email is set up.'
          : `${r.reminded} ${what}${r.reminded === 1 ? '' : 's'} sent${r.failed ? ` · ${r.failed} could not be sent` : ''}.`,
      );
      void client.invalidateQueries({ queryKey: ['crm'] });
    },
  });

  if (data.isPending) return <Spinner label="Loading accounts" />;
  if (data.isError) return <Alert tone="error">{errorMessage(data.error)}</Alert>;
  const d = data.data;
  const c = d.currency;
  const rows = d.unpaid.filter((r) =>
    filter === 'late' ? r.daysLate > 0 : filter === 'soon' ? r.daysLate <= 0 : true,
  );
  const lateCount = d.unpaid.filter((r) => r.daysLate > 0).length;
  const window = d.thisMonth;
  const windowTotal = window.paid + window.waiting + window.late;
  const agingMax = Math.max(
    1,
    d.aging.notDue,
    d.aging.days1to30,
    d.aging.days31to60,
    d.aging.over60,
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 rounded-3xl border border-line bg-surface px-5 py-4 shadow-card">
        <CalendarClock className="size-5 text-brand" aria-hidden />
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-bold">{monthLabel(d.month)}</span> ·{' '}
          {d.paymentDueDay
            ? `Monthly payments are due from the 1st to the ${ordinal(d.paymentDueDay)}.`
            : 'No monthly payment window set: each subscription uses its own number of days.'}{' '}
          Automatic reminders go out{' '}
          {d.reminderDays
            .map((n) => (n === 0 ? 'on the due date' : `${n} day${n === 1 ? '' : 's'} late`))
            .join(', ')}{' '}
          by{' '}
          {d.reminderChannels
            .map((ch) => (ch === 'EMAIL' ? 'email' : ch === 'SMS' ? 'SMS' : 'WhatsApp'))
            .join(', ')}
          . <span className="text-muted">Change this in CRM settings.</span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          Icon={Users}
          label="Clients"
          value={d.clients.active}
          hint={`${d.clients.owing} owe money now`}
        />
        <Stat
          Icon={Banknote}
          label="Received this month"
          value={moneyShort(d.receivedThisMonth, c)}
          hint={`${d.paymentsThisMonth} payment${d.paymentsThisMonth === 1 ? '' : 's'} · invoiced ${moneyShort(d.invoicedThisMonth, c)}`}
          tone="success"
        />
        <Stat
          Icon={Wallet}
          label="Waiting for payment"
          value={moneyShort(d.outstanding, c)}
          hint={`${d.unpaid.length} unpaid invoice${d.unpaid.length === 1 ? '' : 's'}`}
        />
        <Stat
          Icon={d.overdueCount > 0 ? AlertTriangle : CheckCircle2}
          label="Overdue"
          value={moneyShort(d.overdue, c)}
          hint={
            d.overdueCount > 0
              ? `${d.overdueCount} invoices past their due date`
              : 'Nothing overdue'
          }
          tone={d.overdueCount > 0 ? 'danger' : 'success'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <h2 className="font-bold">This month’s monthly payments</h2>
          {windowTotal === 0 ? (
            <p className="mt-3 text-sm text-muted">No monthly invoices this month yet.</p>
          ) : (
            <>
              <div
                className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full"
                role="img"
                aria-label={`${window.paid} paid, ${window.waiting} not paid yet, ${window.late} late`}
              >
                {(
                  [
                    [window.paid, 'bg-success'],
                    [window.waiting, 'bg-warning'],
                    [window.late, 'bg-danger'],
                  ] as const
                ).map(([n, cls], i) =>
                  n > 0 ? (
                    <span
                      key={i}
                      className={cls}
                      style={{ width: `${(n / windowTotal) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  <span className="flex-1">Paid</span>
                  <span className="font-bold tabular-nums">{window.paid}</span>
                </li>
                <li className="flex items-center gap-2">
                  <Clock className="size-4 text-warning" aria-hidden />
                  <span className="flex-1">Not paid yet (still in time)</span>
                  <span className="font-bold tabular-nums">{window.waiting}</span>
                </li>
                <li className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-danger" aria-hidden />
                  <span className="flex-1">Late</span>
                  <span className="font-bold tabular-nums">{window.late}</span>
                </li>
              </ul>
            </>
          )}
        </section>
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card lg:col-span-2">
          <TrendChart
            trend={d.trend.map((t) => ({ month: t.month, won: t.invoiced, collected: t.received }))}
            currency={c}
            labels={{ won: 'Invoiced', collected: 'Received' }}
          />
        </section>
      </div>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-3 font-bold">How late the unpaid money is</h2>
        <ul className="flex flex-col gap-2">
          {(
            [
              ['Not due yet', d.aging.notDue],
              ['1–30 days late', d.aging.days1to30],
              ['31–60 days late', d.aging.days31to60],
              ['Over 60 days late', d.aging.over60],
            ] as const
          ).map(([label, value]) => (
            <li key={label} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
              <span className="font-semibold">{label}</span>
              <span className="h-3 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${value > 0 ? Math.max(2, (value / agingMax) * 100) : 0}%`,
                    background: 'var(--series-1)',
                  }}
                />
              </span>
              <span className="tabular-nums">{money2(value, c)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="flex-1 font-bold">Who to remind</h2>
          <div
            className="flex gap-1 rounded-xl bg-surface-2 p-1"
            role="radiogroup"
            aria-label="Show"
          >
            {(
              [
                ['all', `All unpaid (${d.unpaid.length})`],
                ['late', `Late (${lateCount})`],
                ['soon', `Not late yet (${d.unpaid.length - lateCount})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={filter === key}
                onClick={() => setFilter(key)}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-sm font-semibold',
                  filter === key ? 'bg-surface shadow-card' : 'text-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {d.canRemind && lateCount > 0 && (
            <Button
              variant="secondary"
              busy={remind.isPending && remind.variables?.invoiceIds.length === 0}
              icon={<BellRing className="size-5" aria-hidden />}
              onClick={() => remind.mutate({ invoiceIds: [], via: 'all' })}
            >
              Remind all late ({lateCount})
            </Button>
          )}
        </div>
        {note && <Alert tone="info">{note}</Alert>}
        {remind.isError && <Alert tone="error">{errorMessage(remind.error)}</Alert>}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-muted">Nobody owes anything here.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 font-semibold">Customer</th>
                  <th className="py-2 font-semibold">Invoice</th>
                  <th className="py-2 text-right font-semibold">Owes</th>
                  <th className="py-2 font-semibold">Due</th>
                  <th className="py-2 font-semibold">Reminders</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-middle">
                    <td className="py-2.5 pr-3">
                      <p className="font-semibold">{r.customer}</p>
                      <p className="text-xs text-muted">
                        {r.email ?? r.phone ?? 'No email or phone'}
                      </p>
                    </td>
                    <td className="py-2.5 pr-3">
                      {r.number}
                      {r.recurring && <span className="ml-1 text-xs text-muted">· monthly</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                      {money2(r.balance, r.currency)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <DueLabel row={r} />
                        <span className="text-xs text-muted">{dateLabel(r.dueDate)}</span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted">
                      {r.reminderCount === 0
                        ? 'None yet'
                        : `${r.reminderCount} sent${r.lastReminderAt ? ` · last ${dateLabel(r.lastReminderAt)}` : ''}`}
                    </td>
                    <td className="py-2.5 text-right">
                      {d.canRemind && (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Mail className="size-4" aria-hidden />}
                            busy={
                              remind.isPending &&
                              remind.variables?.via === 'email' &&
                              remind.variables.invoiceIds[0] === r.id
                            }
                            disabled={!r.email}
                            title={r.email ? `Email ${r.email}` : 'No email address'}
                            onClick={() => remind.mutate({ invoiceIds: [r.id], via: 'email' })}
                          >
                            Email
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<BellRing className="size-4" aria-hidden />}
                            busy={
                              remind.isPending &&
                              remind.variables?.via === 'notify' &&
                              remind.variables.invoiceIds[0] === r.id
                            }
                            disabled={!r.onSma && !r.phone}
                            title={
                              r.onSma
                                ? 'Notify their admins in the SMA app (and WhatsApp/SMS if set up)'
                                : 'WhatsApp/SMS to their phone (when set up)'
                            }
                            onClick={() => remind.mutate({ invoiceIds: [r.id], via: 'notify' })}
                          >
                            Notify
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-3 font-bold">Payments received</h2>
        {d.recentPayments.length === 0 ? (
          <p className="py-6 text-center text-muted">No payments in the last 6 months.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 font-semibold">Date</th>
                  <th className="py-2 font-semibold">Customer</th>
                  <th className="py-2 font-semibold">Invoice</th>
                  <th className="py-2 font-semibold">How</th>
                  <th className="py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.recentPayments.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-2.5 pr-3 whitespace-nowrap">{dateLabel(p.paidAt)}</td>
                    <td className="py-2.5 pr-3">{p.customer}</td>
                    <td className="py-2.5 pr-3">{p.invoiceNumber}</td>
                    <td className="py-2.5 pr-3">
                      {PAYMENT_METHOD_LABEL[p.method]}
                      {p.reference && <span className="text-muted"> · {p.reference}</span>}
                      {p.recordedBy && (
                        <span className="block text-xs text-muted">Recorded by {p.recordedBy}</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular-nums">
                      {money2(p.amount, p.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
