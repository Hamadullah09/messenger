'use client';

import type { BusinessDto, Page, ReportDto } from '@storeline/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Download,
  Megaphone,
  MessageCircle,
  Siren,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Button, cx, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { hasPermission, isPlatformAdmin, useAuth } from '@/lib/auth-store';

type Range = 'this-month' | 'last-month' | '30-days' | 'this-year';
const RANGES: Array<{ key: Range; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: '30-days', label: 'Last 30 days' },
  { key: 'this-year', label: 'This year' },
];

function rangeDates(range: Range): { from: Date; to: Date } {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  switch (range) {
    case 'this-month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
    case 'last-month':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 1),
      };
    case '30-days':
      return { from: new Date(tomorrow.getTime() - 30 * 86_400_000), to: tomorrow };
    case 'this-year':
      return { from: new Date(now.getFullYear(), 0, 1), to: tomorrow };
  }
}

const KIND_LABEL: Record<string, string> = {
  TEXT: 'Text',
  IMAGE: 'Photos',
  VIDEO: 'Videos',
  DOCUMENT: 'Documents',
  AUDIO: 'Voice & audio',
  LOCATION: 'Locations',
  CONTACT: 'Contacts',
  POLL: 'Polls',
  EVENT: 'Events',
  CALL: 'Calls',
  STICKER: 'Stickers',
};

function Kpi({ Icon, label, value, hint, tone = 'brand' }: { Icon: LucideIcon; label: string; value: string | number; hint?: string; tone?: 'brand' | 'success' | 'warn' | 'danger' }) {
  const tones = {
    brand: 'bg-brand-soft text-brand-strong',
    success: 'bg-success-soft text-success',
    warn: 'bg-warning-surface text-warning',
    danger: 'bg-danger-surface text-danger',
  };
  return (
    <div className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <span className={cx('inline-flex size-11 items-center justify-center rounded-2xl', tones[tone])}>
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** Messages per day: one series, one axis, hover/focus tooltip and a table view. */
function DailyChart({ perDay, from, to }: { perDay: ReportDto['messages']['perDay']; from: string; to: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const days = useMemo(() => {
    const byDay = new Map(perDay.map((d) => [d.day, d.count]));
    const list: Array<{ day: string; count: number }> = [];
    for (let t = Date.parse(from); t < Date.parse(to) && list.length < 370; t += 86_400_000) {
      const key = new Date(t).toISOString().slice(0, 10);
      list.push({ day: key, count: byDay.get(key) ?? 0 });
    }
    return list;
  }, [perDay, from, to]);
  const max = Math.max(1, ...days.map((d) => d.count));
  const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-bold">Messages per day</h2>
        <button type="button" className="text-sm font-semibold text-brand underline-offset-2 hover:underline" onClick={() => setTable((v) => !v)}>
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-semibold">Day</th>
                <th className="py-1 text-right font-semibold">Messages</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-t border-line">
                  <td className="py-1">{label(d.day)}</td>
                  <td className="py-1 text-right tabular-nums">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="flex h-44 items-end gap-[2px] border-b border-line">
            {days.map((d, i) => (
              <div
                key={d.day}
                tabIndex={0}
                aria-label={`${label(d.day)}: ${d.count} messages`}
                className="relative flex h-full flex-1 items-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <span
                  className="w-full rounded-t"
                  style={{ height: `${d.count > 0 ? Math.max(2, (d.count / max) * 100) : 0}%`, background: 'var(--series-1)', opacity: hover === null || hover === i ? 1 : 0.55 }}
                />
                {hover === i && (
                  <span className="absolute bottom-full left-1/2 z-10 mb-2 w-max -translate-x-1/2 rounded-xl border border-line bg-surface px-3 py-1.5 text-xs shadow-pop">
                    <b>{label(d.day)}</b> · {d.count} messages
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted">
            <span>{days[0] && label(days[0].day)}</span>
            <span>Most in a day: {max}</span>
            <span>{days.at(-1) && label(days.at(-1)!.day)}</span>
          </div>
        </>
      )}
    </section>
  );
}

function BarList({ title, rows }: { title: string; rows: Array<{ label: string; value: number; display?: string }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <h2 className="mb-3 font-bold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing in this period.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate font-semibold">{r.label}</span>
              <span className="h-3 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: 'var(--series-1)' }} />
              </span>
              <span className="text-right tabular-nums text-muted">{r.display ?? r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ReportsPage() {
  const me = useAuth((s) => s.me)!;
  const activeBusinessId = useAuth((s) => s.activeBusinessId);
  const platform = isPlatformAdmin(me) && hasPermission(me, 'report.read');
  const [range, setRange] = useState<Range>('this-month');
  const [scope, setScope] = useState<string>(platform ? '' : (activeBusinessId ?? ''));
  const businesses = useQuery({
    queryKey: ['businesses-for-reports'],
    queryFn: () => api<Page<BusinessDto>>('/businesses', { query: { limit: 100 } }),
    enabled: platform,
  });
  const { from, to } = rangeDates(range);
  const query = { from: from.toISOString(), to: to.toISOString(), ...(scope ? { businessId: scope } : {}) };
  const report = useQuery({
    queryKey: ['report', query],
    queryFn: () => api<ReportDto>('/reports', { query }),
    enabled: platform || !!scope,
  });
  const exporting = useMutation({
    mutationFn: () =>
      downloadFile(`/reports/export.xlsx?${new URLSearchParams(query).toString()}`, 'sma-report.xlsx'),
  });
  const r = report.data;
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Reports"
          subtitle="How the business communicates and sells. Counts and timings only, never message content."
          actions={
            <Button
              variant="secondary"
              busy={exporting.isPending}
              disabled={!r}
              icon={<Download className="size-5" aria-hidden />}
              onClick={() => exporting.mutate()}
            >
              Export to Excel
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Period">
            {RANGES.map((x) => (
              <button
                key={x.key}
                type="button"
                role="radio"
                aria-checked={range === x.key}
                onClick={() => setRange(x.key)}
                className={cx('min-h-10 rounded-lg px-3 text-sm font-semibold', range === x.key ? 'bg-surface shadow-card' : 'text-muted')}
              >
                {x.label}
              </button>
            ))}
          </div>
          {platform && (
            <select
              aria-label="Business"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="min-h-11 rounded-xl border border-line-strong/70 bg-surface px-3"
            >
              <option value="">Whole platform (with SMA sales)</option>
              {businesses.data?.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {exporting.isError && <Alert tone="error">{errorMessage(exporting.error)}</Alert>}
        {!platform && !scope && (
          <EmptyState icon={<BarChart3 className="size-9" aria-hidden />} title="Choose a business" />
        )}
        {report.isPending && (platform || scope) && <Spinner label="Building the report" />}
        {report.isError && <Alert tone="error">{errorMessage(report.error)}</Alert>}
        {r && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi Icon={MessageCircle} label="Messages sent" value={r.messages.total.toLocaleString()} hint={`${r.messages.activeSenders} people sent messages`} />
              <Kpi
                Icon={Clock}
                label="Median reply time"
                value={r.messages.medianReplyMinutes === null ? '—' : `${r.messages.medianReplyMinutes} min`}
                hint={`${pct(r.messages.repliedWithin15m)} answered within 15 min`}
                tone="success"
              />
              <Kpi
                Icon={Siren}
                label="Emergency alerts"
                value={r.emergencies.total}
                hint={r.emergencies.medianAckMinutes === null ? 'None acknowledged' : `Acknowledged in ${r.emergencies.medianAckMinutes} min (median)`}
                tone={r.emergencies.total > 0 ? 'warn' : 'brand'}
              />
              <Kpi
                Icon={CheckCircle2}
                label="Tasks completed"
                value={`${r.tasks.completed} / ${r.tasks.created}`}
                hint={r.tasks.overdueOpen > 0 ? `${r.tasks.overdueOpen} open tasks are overdue` : 'Nothing overdue'}
                tone={r.tasks.overdueOpen > 0 ? 'danger' : 'brand'}
              />
            </div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi Icon={Megaphone} label="Campaign messages sent" value={r.campaigns.sent} hint={`${r.campaigns.total} campaigns · ${r.campaigns.failed} failed`} />
              <Kpi Icon={Users} label="Store customers" value={r.customers.total} hint={`${r.customers.newInPeriod} new · ${r.customers.optedIn} accept marketing`} />
              {r.leads && (
                <>
                  <Kpi Icon={BarChart3} label="Leads created" value={r.leads.created} hint={`${r.leads.won} won · ${r.leads.lost} lost`} />
                  <Kpi
                    Icon={r.leads.conversionRate !== null && r.leads.conversionRate < 0.2 ? AlertTriangle : CheckCircle2}
                    label="Win rate"
                    value={pct(r.leads.conversionRate)}
                    hint="Won ÷ closed leads"
                    tone="success"
                  />
                </>
              )}
            </div>
            <DailyChart perDay={r.messages.perDay} from={r.from} to={r.to} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <BarList
                title="Message types"
                rows={r.messages.byKind.map((k) => ({ label: KIND_LABEL[k.kind] ?? k.kind, value: k.count }))}
              />
              <BarList
                title="Busiest stores"
                rows={r.messages.busiestStores.map((s) => ({ label: s.storeName, value: s.count }))}
              />
              <BarList
                title="Campaigns by channel"
                rows={r.campaigns.byChannel.map((c) => ({
                  label: c.channel === 'WHATSAPP' ? 'WhatsApp' : c.channel === 'SMS' ? 'SMS' : 'Email',
                  value: c.sent,
                  display: `${c.sent} sent · ${c.failed} failed`,
                }))}
              />
              {r.leads && (
                <BarList
                  title="New leads by source"
                  rows={r.leads.bySource.map((s) => ({ label: s.source.replace(/_/g, ' ').toLowerCase(), value: s.count }))}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
