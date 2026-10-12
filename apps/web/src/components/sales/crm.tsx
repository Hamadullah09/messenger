'use client';

import {
  DEAL_TYPES,
  PAYMENT_METHODS,
  SERVICE_BILLINGS,
  type CrmCustomerDto,
  type CrmOverviewDto,
  type CrmServiceDto,
  type DealDto,
  type DealStatus,
  type DealType,
  type InvoiceDto,
  type InvoiceStatus,
  type LeadDto,
  type LineItemInput,
  type PaymentMethod,
  type SalesContextDto,
  type SalesUserDto,
  type ServiceBilling,
  type TargetHistoryDto,
  type TargetsDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  Banknote,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Mail,
  Package,
  Pencil,
  Plus,
  Printer,
  Receipt,
  RotateCcw,
  Search,
  Send,
  Target,
  Trash2,
  TrendingUp,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDay } from '@/lib/format';

// ───────────────────────────── Labels and formatting ─────────────────────────────

/** Amounts with cents, e.g. "$1,250.00". */
export function money2(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Whole amounts for tiles, e.g. "$1,250". */
function moneyShort(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

export const DEAL_TYPE_LABEL: Record<DealType, string> = {
  NEW_BUSINESS: 'New customer',
  UPSELL: 'Upsell',
  RENEWAL: 'Renewal',
};
const DEAL_STATUS_STYLE: Record<DealStatus, { label: string; cls: string }> = {
  OPEN: { label: 'Open', cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  WON: { label: 'Won', cls: 'bg-success-soft text-success' },
  LOST: { label: 'Lost', cls: 'bg-surface-3 text-muted' },
};
const INVOICE_STATUS_STYLE: Record<InvoiceStatus | 'OVERDUE', { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-surface-3 text-fg' },
  ISSUED: { label: 'Unpaid', cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  PARTIALLY_PAID: {
    label: 'Part paid',
    cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  },
  PAID: { label: 'Paid', cls: 'bg-success-soft text-success' },
  VOID: { label: 'Void', cls: 'bg-surface-3 text-muted line-through' },
  OVERDUE: { label: 'Overdue', cls: 'bg-danger-surface text-danger' },
};
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
  OTHER: 'Other',
};
const BILLING_LABEL: Record<ServiceBilling, string> = {
  ONE_TIME: 'One-time',
  MONTHLY: 'per month',
  YEARLY: 'per year',
};

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold', cls)}>
      {children}
    </span>
  );
}

function DealStatusChip({ status }: { status: DealStatus }) {
  const s = DEAL_STATUS_STYLE[status];
  return <Chip cls={s.cls}>{s.label}</Chip>;
}

export function InvoiceStatusChip({ invoice }: { invoice: Pick<InvoiceDto, 'status' | 'overdue'> }) {
  const s = INVOICE_STATUS_STYLE[invoice.overdue ? 'OVERDUE' : invoice.status];
  return <Chip cls={s.cls}>{s.label}</Chip>;
}

function useCrmRefresh() {
  const client = useQueryClient();
  return () => refreshCrm(client);
}
function refreshCrm(client: QueryClient) {
  void client.invalidateQueries({ queryKey: ['crm'] });
  void client.invalidateQueries({ queryKey: ['leads'] });
  void client.invalidateQueries({ queryKey: ['lead'] });
  void client.invalidateQueries({ queryKey: ['sales-overview'] });
}

function useServices() {
  return useQuery({
    queryKey: ['crm', 'services'],
    queryFn: () => api<CrmServiceDto[]>('/sales/crm/services'),
  });
}
function useCustomers() {
  return useQuery({
    queryKey: ['crm', 'customers'],
    queryFn: () => api<CrmCustomerDto[]>('/sales/crm/customers'),
  });
}
function useCrmSettings() {
  return useQuery({
    queryKey: ['crm', 'settings'],
    queryFn: () =>
      api<{ currency: string; emailEnabled: boolean; companyName: string }>(
        '/sales/crm/settings',
      ),
    staleTime: 5 * 60_000,
  });
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: style,
    year: style === 'long' ? 'numeric' : '2-digit',
  });
}

function Stat({
  Icon,
  label,
  value,
  hint,
  tone = 'brand',
}: {
  Icon: LucideIcon;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'brand' | 'success' | 'warn' | 'danger';
}) {
  const tones = {
    brand: 'bg-brand-soft text-brand-strong',
    success: 'bg-success-soft text-success',
    warn: 'bg-warning-surface text-warning',
    danger: 'bg-danger-surface text-danger',
  };
  return (
    <div className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <span
        className={cx('inline-flex size-11 items-center justify-center rounded-2xl', tones[tone])}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function ProgressBar({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.min(100, Math.round(value * 100));
  const reached = value !== null && value >= 1;
  return (
    <span
      className="block h-2.5 overflow-hidden rounded-full bg-surface-3"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Progress towards target"
    >
      <span
        className={cx('block h-full rounded-full', reached ? 'bg-success' : 'bg-brand')}
        style={{ width: `${Math.max(value ? 3 : 0, pct)}%` }}
      />
    </span>
  );
}

// ───────────────────────────── Overview strip ─────────────────────────────

/** Revenue, collections and the month's target, shown at the top of the Sales overview. */
export function RevenueStrip({ myId }: { myId: string }) {
  const overview = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: () => api<CrmOverviewDto>('/sales/crm/overview'),
  });
  const targets = useQuery({
    queryKey: ['crm', 'targets', currentMonth()],
    queryFn: () => api<TargetsDto>('/sales/crm/targets', { query: { month: currentMonth() } }),
  });
  if (overview.isPending) return <Spinner label="Loading revenue" />;
  if (overview.isError) return <Alert tone="error">{errorMessage(overview.error)}</Alert>;
  const o = overview.data;
  const mine = targets.data?.team.find((t) => t.user.id === myId);
  const teamView = targets.data && targets.data.team.length > 1;
  const target = teamView ? targets.data!.totals.target : (mine?.target ?? null);
  const achieved = teamView ? targets.data!.totals.achieved : (mine?.achieved ?? o.wonThisMonth);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-brand" aria-hidden />
            <h2 className="font-bold">
              {teamView ? 'Team target' : 'My target'} · {monthLabel(o.month)}
            </h2>
          </div>
          <p className="mt-3 text-3xl font-bold tabular-nums">{moneyShort(achieved, o.currency)}</p>
          <p className="text-sm text-muted">
            {target
              ? `of ${moneyShort(target, o.currency)} target · ${Math.round((achieved / target) * 100)}%`
              : 'No target set for this month'}
          </p>
          <div className="mt-3">
            <ProgressBar value={target ? achieved / target : null} />
          </div>
        </section>
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card lg:col-span-2">
          <TrendChart trend={o.trend} currency={o.currency} />
        </section>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          Icon={BadgeCheck}
          label="Won this month"
          value={moneyShort(o.wonThisMonth, o.currency)}
          hint={`${o.wonCountThisMonth} deals · upsell ${moneyShort(o.upsellThisMonth, o.currency)}`}
          tone="success"
        />
        <Stat
          Icon={TrendingUp}
          label="Open deals"
          value={moneyShort(o.openPipeline, o.currency)}
          hint={`${o.openDeals} deals in progress`}
        />
        <Stat
          Icon={Banknote}
          label="Collected this month"
          value={moneyShort(o.collectedThisMonth, o.currency)}
          hint={`Invoiced ${moneyShort(o.invoicedThisMonth, o.currency)}`}
        />
        <Stat
          Icon={o.overdueCount > 0 ? AlertTriangle : Receipt}
          label="Waiting for payment"
          value={moneyShort(o.outstanding, o.currency)}
          hint={
            o.overdueCount > 0
              ? `${o.overdueCount} overdue · ${moneyShort(o.overdue, o.currency)}`
              : 'Nothing overdue'
          }
          tone={o.overdueCount > 0 ? 'danger' : 'brand'}
        />
      </div>
      {o.topServices.length > 0 && (
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <h2 className="mb-3 font-bold">Best-selling services</h2>
          <ul className="flex flex-col gap-2">
            {o.topServices.map((s) => {
              const max = o.topServices[0]!.value || 1;
              return (
                <li key={s.name} className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] items-center gap-3">
                  <span className="truncate text-sm font-semibold">{s.name}</span>
                  <span className="h-3 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, background: 'var(--series-1)' }}
                    />
                  </span>
                  <span className="text-right text-sm tabular-nums text-muted">
                    {moneyShort(s.value, o.currency)} · {s.count}×
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Six months of won deal value and payments collected: grouped bars, one money axis. */
function TrendChart({ trend, currency }: { trend: CrmOverviewDto['trend']; currency: string }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...trend.flatMap((t) => [t.won, t.collected]));
  const series = [
    { key: 'won' as const, label: 'Won', color: 'var(--series-1)' },
    { key: 'collected' as const, label: 'Collected', color: 'var(--series-2)' },
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">Last 6 months</h2>
        <div className="flex items-center gap-4 text-sm">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-muted">
              <span className="size-3 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
          <button
            type="button"
            className="font-semibold text-brand underline-offset-2 hover:underline"
            onClick={() => setTable((v) => !v)}
          >
            {table ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-semibold">Month</th>
              <th className="py-1 text-right font-semibold">Won</th>
              <th className="py-1 text-right font-semibold">Collected</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((t) => (
              <tr key={t.month} className="border-t border-line">
                <td className="py-1.5">{monthLabel(t.month)}</td>
                <td className="py-1.5 text-right tabular-nums">{money2(t.won, currency)}</td>
                <td className="py-1.5 text-right tabular-nums">{money2(t.collected, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <div className="flex h-40 items-end gap-3 border-b border-line">
            {trend.map((t, i) => (
              <div
                key={t.month}
                className="relative flex h-full flex-1 items-end justify-center gap-0.5"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${monthLabel(t.month)}: won ${money2(t.won, currency)}, collected ${money2(t.collected, currency)}`}
              >
                {hover === i && <span className="absolute inset-x-0 inset-y-0 rounded-lg bg-surface-2" aria-hidden />}
                {series.map((s) => (
                  <span
                    key={s.key}
                    className="relative w-full max-w-5 rounded-t"
                    style={{
                      height: `${t[s.key] > 0 ? Math.max(2, (t[s.key] / max) * 100) : 0}%`,
                      background: s.color,
                    }}
                  />
                ))}
                {hover === i && (
                  <span className="absolute bottom-full z-10 mb-2 w-max rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                    <span className="block font-bold">{monthLabel(t.month)}</span>
                    <span className="block">Won {money2(t.won, currency)}</span>
                    <span className="block">Collected {money2(t.collected, currency)}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-3 text-xs text-muted">
            {trend.map((t) => (
              <span key={t.month} className="flex-1 text-center">
                {monthLabel(t.month, 'short')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Line items editor ─────────────────────────────

type DraftItem = LineItemInput & { key: string };
let draftKey = 0;
const newKey = () => `i${++draftKey}`;

function ItemsEditor({
  items,
  onChange,
  currency,
  withDiscount = true,
}: {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
  currency: string;
  withDiscount?: boolean;
}) {
  const services = useServices();
  const active = (services.data ?? []).filter((s) => s.active);
  const total = items.reduce(
    (sum, i) => sum + i.quantity * i.unitPrice * (1 - (i.discountPct ?? 0) / 100),
    0,
  );
  const set = (key: string, patch: Partial<DraftItem>) =>
    onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const cell = 'min-h-10 w-full rounded-lg border border-line-strong/70 bg-surface px-2';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Add a service"
          className="min-w-0 flex-1"
          value=""
          onChange={(e) => {
            const s = active.find((x) => x.id === e.target.value);
            if (!s) return;
            onChange([
              ...items,
              {
                key: newKey(),
                serviceId: s.id,
                name: s.name,
                quantity: 1,
                unitPrice: s.price,
                discountPct: 0,
                billing: s.billing,
              },
            ]);
          }}
        >
          <option value="">{services.isLoading ? 'Loading…' : 'Choose from the catalog…'}</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {money2(s.price, currency)} {s.billing !== 'ONE_TIME' ? BILLING_LABEL[s.billing] : ''}
            </option>
          ))}
        </SelectField>
        <Button
          type="button"
          variant="secondary"
          icon={<Plus className="size-4" aria-hidden />}
          onClick={() =>
            onChange([
              ...items,
              {
                key: newKey(),
                serviceId: null,
                name: '',
                quantity: 1,
                unitPrice: 0,
                discountPct: 0,
                billing: 'ONE_TIME',
              },
            ])
          }
        >
          Custom item
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">
          No items yet. Add a service from the catalog or a custom item.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.key} className="rounded-xl border border-line bg-surface-2 p-2.5">
              <div className="flex items-center gap-2">
                <input
                  aria-label="Item name"
                  className={cx(cell, 'flex-1 font-semibold')}
                  value={i.name}
                  placeholder="What is it?"
                  onChange={(e) => set(i.key, { name: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Remove ${i.name || 'item'}`}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-danger"
                  onClick={() => onChange(items.filter((x) => x.key !== i.key))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
              <div className={cx('mt-2 grid gap-2', withDiscount ? 'grid-cols-4' : 'grid-cols-3')}>
                <label className="text-xs text-muted">
                  Qty
                  <input
                    type="number"
                    min={1}
                    className={cell}
                    value={i.quantity}
                    onChange={(e) => set(i.key, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
                <label className="text-xs text-muted">
                  Price ({currency})
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={cell}
                    value={i.unitPrice}
                    onChange={(e) => set(i.key, { unitPrice: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
                {withDiscount && (
                  <label className="text-xs text-muted">
                    Discount %
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={cell}
                      value={i.discountPct ?? 0}
                      onChange={(e) =>
                        set(i.key, {
                          discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </label>
                )}
                <label className="text-xs text-muted">
                  Billing
                  <select
                    className={cell}
                    value={i.billing ?? 'ONE_TIME'}
                    onChange={(e) => set(i.key, { billing: e.target.value as ServiceBilling })}
                  >
                    {SERVICE_BILLINGS.map((b) => (
                      <option key={b} value={b}>
                        {b === 'ONE_TIME' ? 'One-time' : b === 'MONTHLY' ? 'Monthly' : 'Yearly'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-right text-lg font-bold tabular-nums">Total {money2(total, currency)}</p>
    </div>
  );
}

const toDraft = (items: DealDto['items']): DraftItem[] =>
  items.map((i) => ({
    key: newKey(),
    serviceId: i.serviceId,
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    discountPct: i.discountPct,
    billing: i.billing,
  }));
const fromDraft = (items: DraftItem[]): LineItemInput[] =>
  items.map(({ key: _key, ...rest }) => ({ ...rest, name: rest.name.trim() }));

// ───────────────────────────── Deals ─────────────────────────────

export function DealFormDialog({
  deal,
  preset,
  team,
  canAssign,
  onClose,
  onSaved,
}: {
  /** Editing an existing deal. */
  deal?: DealDto;
  /** New deal for a lead or an existing customer. */
  preset?: {
    type?: DealType;
    lead?: { id: string; companyName: string };
    customer?: { id: string; name: string };
  };
  team: SalesUserDto[];
  canAssign: boolean;
  onClose: () => void;
  onSaved: (deal: DealDto) => void;
}) {
  const refresh = useCrmRefresh();
  const settings = useCrmSettings();
  const currency = deal?.currency ?? settings.data?.currency ?? 'USD';
  const customers = useCustomers();
  const leads = useQuery({
    queryKey: ['leads', { open: 'true', forDeals: true }],
    queryFn: () => api<LeadDto[]>('/sales/leads', { query: { limit: 200 } }),
    enabled: !deal,
  });
  const [type, setType] = useState<DealType>(deal?.type ?? preset?.type ?? 'NEW_BUSINESS');
  const [title, setTitle] = useState(deal?.title ?? '');
  const [leadId, setLeadId] = useState(deal?.lead?.id ?? preset?.lead?.id ?? '');
  const [businessId, setBusinessId] = useState(deal?.customer?.id ?? preset?.customer?.id ?? '');
  const [ownerId, setOwnerId] = useState(deal?.owner?.id ?? '');
  const [expected, setExpected] = useState(deal?.expectedCloseAt?.slice(0, 10) ?? '');
  const [notes, setNotes] = useState(deal?.notes ?? '');
  const [items, setItems] = useState<DraftItem[]>(deal ? toDraft(deal.items) : []);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        expectedCloseAt: expected ? new Date(`${expected}T12:00:00`).toISOString() : null,
        notes: notes.trim() || null,
        items: fromDraft(items),
        ...(canAssign && ownerId ? { ownerId } : {}),
      };
      return deal
        ? api<DealDto>(`/sales/crm/deals/${deal.id}`, { method: 'PATCH', body })
        : api<DealDto>('/sales/crm/deals', {
            method: 'POST',
            body: {
              ...body,
              type,
              leadId: type === 'NEW_BUSINESS' ? leadId || null : null,
              businessId: type === 'NEW_BUSINESS' ? null : businessId || null,
            },
          });
    },
    onSuccess: (saved) => {
      refresh();
      onSaved(saved);
    },
  });
  const presetLead = preset?.lead;
  const leadOptions = (leads.data ?? []).filter((l) => !l.customer);
  return (
    <Dialog open onClose={onClose} title={deal ? 'Edit deal' : 'New deal'} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {!deal && (
          <div role="radiogroup" aria-label="Kind of deal" className="grid grid-cols-3 gap-2">
            {DEAL_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                onClick={() => setType(t)}
                className={cx(
                  'min-h-12 rounded-xl border px-3 font-semibold',
                  type === t
                    ? 'border-brand bg-brand-soft text-brand-strong'
                    : 'border-line hover:bg-surface-2',
                )}
              >
                {DEAL_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        <TextField
          label="Deal name"
          required
          maxLength={160}
          value={title}
          placeholder={type === 'UPSELL' ? 'e.g. Extra stores + WhatsApp campaigns' : 'e.g. SMA for 5 stores'}
          onChange={(e) => setTitle(e.target.value)}
        />
        {!deal && type === 'NEW_BUSINESS' && (
          <SelectField
            label="Lead"
            required
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
          >
            <option value="">Choose the lead…</option>
            {presetLead && !leadOptions.some((l) => l.id === presetLead.id) && (
              <option value={presetLead.id}>{presetLead.companyName}</option>
            )}
            {leadOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.companyName} — {l.contactName}
              </option>
            ))}
          </SelectField>
        )}
        {!deal && type !== 'NEW_BUSINESS' && (
          <SelectField
            label="Customer"
            hint="Existing SMA customers"
            required
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
          >
            <option value="">Choose the customer…</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {canAssign && (
            <SelectField label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">{deal ? 'Keep the current owner' : 'Me'}</option>
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </SelectField>
          )}
          <TextField
            label="Expected to close"
            type="date"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">Services sold</legend>
          <ItemsEditor items={items} onChange={setItems} currency={currency} />
        </fieldset>
        <TextArea
          label="Notes"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={!title.trim() || items.length === 0 || items.some((i) => !i.name.trim())}
          >
            {deal ? 'Save deal' : 'Create deal'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DealPanel({
  dealId,
  context,
  team,
  onClose,
  onOpenInvoice,
}: {
  dealId: string;
  context: SalesContextDto;
  team: SalesUserDto[];
  onClose: () => void;
  onOpenInvoice: (id: string) => void;
}) {
  const client = useQueryClient();
  const deal = useQuery({
    queryKey: ['crm', 'deal', dealId],
    queryFn: () => api<DealDto>(`/sales/crm/deals/${dealId}`),
  });
  const invoices = useQuery({
    queryKey: ['crm', 'invoices', { dealId }],
    queryFn: () => api<InvoiceDto[]>('/sales/crm/invoices', { query: { dealId } }),
  });
  const overview = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: () => api<CrmOverviewDto>('/sales/crm/overview'),
  });
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const [invoicing, setInvoicing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = (d: DealDto) => {
    client.setQueryData(['crm', 'deal', dealId], d);
    refreshCrm(client);
  };
  const status = useMutation({
    mutationFn: (body: { status: DealStatus; lostReason?: string }) =>
      api<DealDto>(`/sales/crm/deals/${dealId}/status`, { method: 'PUT', body }),
    onSuccess: (d) => {
      setLosing(false);
      done(d);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/sales/crm/deals/${dealId}`, { method: 'DELETE' }),
    onSuccess: () => {
      refreshCrm(client);
      onClose();
    },
  });
  const d = deal.data;
  const canBill = overview.data?.canManageBilling ?? false;
  return (
    <Dialog open onClose={onClose} title={d?.title ?? 'Deal'} wide>
      {deal.isPending && <Spinner label="Opening deal" />}
      {deal.isError && <Alert tone="error">{errorMessage(deal.error)}</Alert>}
      {d && (
        <div className="flex flex-col gap-4">
          {(status.isError || remove.isError) && (
            <Alert tone="error">{errorMessage(status.error ?? remove.error)}</Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DealStatusChip status={d.status} />
            <Chip cls="bg-brand-soft text-brand-strong">{DEAL_TYPE_LABEL[d.type]}</Chip>
            <span className="text-sm text-muted">
              {d.customer?.name ?? d.lead?.companyName ?? 'No customer'} ·{' '}
              {d.owner?.displayName ?? 'Unassigned'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini label="Value" value={money2(d.amount, d.currency)} />
            <Mini label="Invoiced" value={money2(d.invoiced, d.currency)} />
            <Mini label="Paid" value={money2(d.paid, d.currency)} />
            <Mini
              label={d.status === 'OPEN' ? 'Expected' : d.status === 'WON' ? 'Won on' : 'Lost on'}
              value={
                d.status === 'OPEN'
                  ? d.expectedCloseAt
                    ? formatDay(d.expectedCloseAt)
                    : '—'
                  : d.closedAt
                    ? formatDay(d.closedAt)
                    : '—'
              }
            />
          </div>
          {d.lostReason && <Alert tone="warning" title="Lost">{d.lostReason}</Alert>}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-2 font-semibold">Service</th>
                <th className="py-2 text-right font-semibold">Qty</th>
                <th className="py-2 text-right font-semibold">Price</th>
                <th className="py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id} className="border-b border-line/60">
                  <td className="py-2">
                    <span className="font-semibold">{i.name}</span>
                    <span className="block text-xs text-muted">
                      {i.billing !== 'ONE_TIME' ? BILLING_LABEL[i.billing] : 'One-time'}
                      {i.discountPct > 0 ? ` · ${i.discountPct}% off` : ''}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{i.quantity}</td>
                  <td className="py-2 text-right tabular-nums">{money2(i.unitPrice, d.currency)}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">
                    {money2(i.total, d.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.notes && <p className="whitespace-pre-wrap text-muted">{d.notes}</p>}

          {d.canEdit && (
            <div className="flex flex-wrap gap-2">
              {d.status === 'OPEN' && (
                <>
                  <Button
                    icon={<Trophy className="size-4" aria-hidden />}
                    busy={status.isPending}
                    onClick={() => status.mutate({ status: 'WON' })}
                  >
                    Mark as won
                  </Button>
                  <Button variant="secondary" onClick={() => setLosing(true)}>
                    Mark as lost
                  </Button>
                </>
              )}
              {d.status !== 'OPEN' && (
                <Button
                  variant="secondary"
                  icon={<RotateCcw className="size-4" aria-hidden />}
                  busy={status.isPending}
                  onClick={() => status.mutate({ status: 'OPEN' })}
                >
                  Reopen
                </Button>
              )}
              <Button
                variant="secondary"
                icon={<Pencil className="size-4" aria-hidden />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              {canBill && d.status !== 'LOST' && (
                <Button
                  variant="secondary"
                  icon={<Receipt className="size-4" aria-hidden />}
                  onClick={() => setInvoicing(true)}
                >
                  Create invoice
                </Button>
              )}
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" aria-hidden />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </div>
          )}
          {losing && (
            <div className="flex flex-col gap-2 rounded-2xl border border-line p-3">
              <TextField
                label="Why was it lost?"
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setLosing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!reason.trim()}
                  busy={status.isPending}
                  onClick={() => status.mutate({ status: 'LOST', lostReason: reason.trim() })}
                >
                  Mark as lost
                </Button>
              </div>
            </div>
          )}
          {confirmDelete && (
            <Alert tone="warning" title="Delete this deal?">
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </Button>
                <Button size="sm" variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
                  Delete deal
                </Button>
              </div>
            </Alert>
          )}

          <section>
            <h3 className="mb-2 font-bold">Invoices</h3>
            {invoices.data?.length === 0 && (
              <p className="text-sm text-muted">No invoices for this deal yet.</p>
            )}
            <ul className="flex flex-col gap-2">
              {invoices.data?.map((inv) => (
                <li key={inv.id}>
                  <button
                    type="button"
                    onClick={() => onOpenInvoice(inv.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <FileText className="size-5 text-brand" aria-hidden />
                    <span className="flex-1 font-semibold">{inv.number}</span>
                    <InvoiceStatusChip invoice={inv} />
                    <span className="tabular-nums">{money2(inv.total, inv.currency)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {editing && d && (
        <DealFormDialog
          deal={d}
          team={team}
          canAssign={context.canAssign}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            client.setQueryData(['crm', 'deal', dealId], saved);
          }}
        />
      )}
      {invoicing && d && (
        <InvoiceFormDialog
          deal={d}
          onClose={() => setInvoicing(false)}
          onSaved={(inv) => {
            setInvoicing(false);
            onOpenInvoice(inv.id);
          }}
        />
      )}
    </Dialog>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-bold tabular-nums">{value}</p>
    </div>
  );
}

export function DealsTab({
  context,
  team,
}: {
  context: SalesContextDto;
  team: SalesUserDto[];
}) {
  const [status, setStatus] = useState<DealStatus | 'ALL'>('OPEN');
  const [type, setType] = useState<DealType | ''>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const deals = useQuery({
    queryKey: ['crm', 'deals', { status, type, q }],
    queryFn: () =>
      api<DealDto[]>('/sales/crm/deals', {
        query: {
          status: status === 'ALL' ? undefined : status,
          type: type || undefined,
          q: q.trim() || undefined,
        },
      }),
  });
  const total = (deals.data ?? []).reduce((s, d) => s + d.amount, 0);
  const currency = deals.data?.[0]?.currency ?? 'USD';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Status">
          {(['OPEN', 'WON', 'LOST', 'ALL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
              className={cx(
                'min-h-10 rounded-lg px-3 text-sm font-semibold',
                status === s ? 'bg-surface shadow-card' : 'text-muted',
              )}
            >
              {s === 'ALL' ? 'All' : DEAL_STATUS_STYLE[s].label}
            </button>
          ))}
        </div>
        <select
          aria-label="Kind of deal"
          className="min-h-11 rounded-xl border border-line-strong/70 bg-surface px-3"
          value={type}
          onChange={(e) => setType(e.target.value as DealType | '')}
        >
          <option value="">All kinds</option>
          {DEAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {DEAL_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search deals</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search deals or customers"
            className="min-h-11 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-9"
          />
        </label>
        <Button icon={<Plus className="size-5" aria-hidden />} onClick={() => setCreating(true)}>
          New deal
        </Button>
      </div>
      {deals.isPending && <Spinner label="Loading deals" />}
      {deals.isError && <Alert tone="error">{errorMessage(deals.error)}</Alert>}
      {deals.data?.length === 0 && (
        <EmptyState icon={<Briefcase className="size-9" aria-hidden />} title="No deals here">
          A deal records which services you are selling, to whom and for how much. Won deals count
          towards the monthly target.
        </EmptyState>
      )}
      {deals.data && deals.data.length > 0 && (
        <>
          <p className="text-sm text-muted">
            {deals.data.length} deals · {money2(total, currency)}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {deals.data.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setOpenDeal(d.id)}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-left shadow-card hover:border-brand/40"
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 font-bold">{d.title}</span>
                  <DealStatusChip status={d.status} />
                </div>
                <p className="truncate text-sm text-muted">
                  {DEAL_TYPE_LABEL[d.type]} · {d.customer?.name ?? d.lead?.companyName ?? '—'}
                </p>
                <p className="line-clamp-1 text-xs text-muted">{d.items.map((i) => i.name).join(', ')}</p>
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <span className="flex items-center gap-1.5 text-sm text-muted">
                    {d.owner && <Avatar name={d.owner.displayName} size={22} />}
                    {d.owner?.displayName ?? 'Unassigned'}
                  </span>
                  <span className="text-lg font-bold tabular-nums">{money2(d.amount, d.currency)}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      {creating && (
        <DealFormDialog
          team={team}
          canAssign={context.canAssign}
          onClose={() => setCreating(false)}
          onSaved={(d) => {
            setCreating(false);
            setOpenDeal(d.id);
          }}
        />
      )}
      {openDeal && (
        <DealPanel
          dealId={openDeal}
          context={context}
          team={team}
          onClose={() => setOpenDeal(null)}
          onOpenInvoice={(id) => {
            setOpenDeal(null);
            setOpenInvoice(id);
          }}
        />
      )}
      {openInvoice && <InvoicePanel invoiceId={openInvoice} onClose={() => setOpenInvoice(null)} />}
    </div>
  );
}

/** Deals of one lead, inside the lead panel. */
export function LeadDeals({
  lead,
  context,
  team,
}: {
  lead: { id: string; companyName: string };
  context: SalesContextDto;
  team: SalesUserDto[];
}) {
  const deals = useQuery({
    queryKey: ['crm', 'deals', { leadId: lead.id }],
    queryFn: () => api<DealDto[]>('/sales/crm/deals', { query: { leadId: lead.id } }),
  });
  const [creating, setCreating] = useState(false);
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  return (
    <section className="rounded-2xl border border-line p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-bold">Deals</h3>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          New deal
        </Button>
      </div>
      {deals.data?.length === 0 && (
        <p className="text-sm text-muted">
          Record what you are selling (services, price) as a deal. Winning it wins the lead.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {deals.data?.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => setOpenDeal(d.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2 text-left hover:bg-surface-2"
            >
              <Briefcase className="size-5 text-brand" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold">{d.title}</span>
              <DealStatusChip status={d.status} />
              <span className="tabular-nums">{money2(d.amount, d.currency)}</span>
            </button>
          </li>
        ))}
      </ul>
      {creating && (
        <DealFormDialog
          preset={{ type: 'NEW_BUSINESS', lead }}
          team={team}
          canAssign={context.canAssign}
          onClose={() => setCreating(false)}
          onSaved={(d) => {
            setCreating(false);
            setOpenDeal(d.id);
          }}
        />
      )}
      {openDeal && (
        <DealPanel
          dealId={openDeal}
          context={context}
          team={team}
          onClose={() => setOpenDeal(null)}
          onOpenInvoice={(id) => {
            setOpenDeal(null);
            setOpenInvoice(id);
          }}
        />
      )}
      {openInvoice && <InvoicePanel invoiceId={openInvoice} onClose={() => setOpenInvoice(null)} />}
    </section>
  );
}

// ───────────────────────────── Invoices ─────────────────────────────

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function InvoiceFormDialog({
  deal,
  customer,
  onClose,
  onSaved,
}: {
  deal?: DealDto;
  customer?: { id: string; name: string };
  onClose: () => void;
  onSaved: (invoice: InvoiceDto) => void;
}) {
  const refresh = useCrmRefresh();
  const settings = useCrmSettings();
  const currency = deal?.currency ?? settings.data?.currency ?? 'USD';
  const customers = useCustomers();
  const [businessId, setBusinessId] = useState(customer?.id ?? '');
  const [billToName, setBillToName] = useState('');
  const [billToEmail, setBillToEmail] = useState('');
  const [issueDate, setIssueDate] = useState(toDateInput(new Date()));
  const [dueDate, setDueDate] = useState('');
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const save = useMutation({
    mutationFn: () =>
      api<InvoiceDto>('/sales/crm/invoices', {
        method: 'POST',
        body: {
          ...(deal
            ? { dealId: deal.id }
            : {
                businessId: businessId || null,
                items: items.map((i) => ({
                  serviceId: i.serviceId ?? null,
                  name: i.name.trim(),
                  quantity: i.quantity,
                  unitPrice: Math.round(i.unitPrice * (1 - (i.discountPct ?? 0) / 100) * 100) / 100,
                })),
              }),
          ...(billToName.trim() ? { billToName: billToName.trim() } : {}),
          ...(billToEmail.trim() ? { billToEmail: billToEmail.trim() } : {}),
          issueDate: new Date(`${issueDate}T12:00:00`).toISOString(),
          ...(dueDate ? { dueDate: new Date(`${dueDate}T12:00:00`).toISOString() } : {}),
          discount,
          taxRate,
          notes: notes.trim() || null,
        },
      }),
    onSuccess: (inv) => {
      refresh();
      onSaved(inv);
    },
  });
  return (
    <Dialog open onClose={onClose} title={deal ? `Invoice for “${deal.title}”` : 'New invoice'} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {deal ? (
          <Alert tone="info" title={`${deal.items.length} items · ${money2(deal.amount, deal.currency)}`}>
            The deal’s services and the customer’s details are copied onto the invoice. It starts as
            a draft; issue it when it is ready.
          </Alert>
        ) : (
          <>
            <SelectField
              label="Customer"
              value={businessId}
              onChange={(e) => setBusinessId(e.target.value)}
            >
              <option value="">Someone else (type the name below)</option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            {!businessId && (
              <TextField
                label="Bill to"
                required
                maxLength={160}
                value={billToName}
                onChange={(e) => setBillToName(e.target.value)}
              />
            )}
            <fieldset>
              <legend className="mb-1 font-semibold">Items</legend>
              <ItemsEditor items={items} onChange={setItems} currency={currency} />
            </fieldset>
          </>
        )}
        <TextField
          label="Customer email (to send the invoice)"
          type="email"
          hint="Leave empty to use the customer's email on file"
          value={billToEmail}
          onChange={(e) => setBillToEmail(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TextField label="Issue date" type="date" required value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          <TextField label="Due date" type="date" hint="Default: 14 days" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <TextField
            label={`Discount (${currency})`}
            type="number"
            min={0}
            step="0.01"
            value={discount}
            onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))}
          />
          <TextField
            label="Tax %"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={taxRate}
            onChange={(e) => setTaxRate(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
          />
        </div>
        <TextArea label="Notes on the invoice" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={!deal && (items.length === 0 || (!businessId && !billToName.trim()))}
          >
            Create draft invoice
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function InvoicePanel({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const invoice = useQuery({
    queryKey: ['crm', 'invoice', invoiceId],
    queryFn: () => api<InvoiceDto>(`/sales/crm/invoices/${invoiceId}`),
  });
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [emailed, setEmailed] = useState(false);
  const done = (inv: InvoiceDto) => {
    client.setQueryData(['crm', 'invoice', invoiceId], inv);
    refreshCrm(client);
  };
  const action = useMutation({
    mutationFn: (a: { path: string; method?: 'POST' | 'DELETE'; body?: unknown }) =>
      api<InvoiceDto>(`/sales/crm/invoices/${invoiceId}${a.path}`, {
        method: a.method ?? 'POST',
        body: a.body,
      }),
    onSuccess: (inv, a) => {
      done(inv);
      if (a.path === '/void') setVoiding(false);
      if (a.path === '/email') setEmailed(true);
    },
  });
  const i = invoice.data;
  return (
    <Dialog open onClose={onClose} title={i ? `Invoice ${i.number}` : 'Invoice'} wide>
      {invoice.isPending && <Spinner label="Opening invoice" />}
      {invoice.isError && <Alert tone="error">{errorMessage(invoice.error)}</Alert>}
      {i && (
        <div className="flex flex-col gap-4">
          {action.isError && <Alert tone="error">{errorMessage(action.error)}</Alert>}
          {emailed && <Alert tone="success">Sent to {i.billToEmail}.</Alert>}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-bold">{i.billToName}</p>
              <p className="text-sm text-muted">
                {[i.billToEmail, i.billToPhone, i.billToAddress].filter(Boolean).join(' · ') || 'No contact details'}
              </p>
              {i.deal && (
                <p className="text-sm text-muted">
                  {DEAL_TYPE_LABEL[i.deal.type]} · {i.deal.title}
                </p>
              )}
            </div>
            <div className="text-right">
              <InvoiceStatusChip invoice={i} />
              <p className="mt-1 text-sm text-muted">
                Issued {i.issueDate} · Due {i.dueDate}
              </p>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-2 font-semibold">Item</th>
                <th className="py-2 text-right font-semibold">Qty</th>
                <th className="py-2 text-right font-semibold">Price</th>
                <th className="py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {i.items.map((it) => (
                <tr key={it.id} className="border-b border-line/60">
                  <td className="py-2">
                    <span className="font-semibold">{it.name}</span>
                    {it.description && <span className="block text-xs text-muted">{it.description}</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{it.quantity}</td>
                  <td className="py-2 text-right tabular-nums">{money2(it.unitPrice, i.currency)}</td>
                  <td className="py-2 text-right tabular-nums">{money2(it.total, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Subtotal</dt>
            <dd className="text-right tabular-nums">{money2(i.subtotal, i.currency)}</dd>
            {i.discount > 0 && (
              <>
                <dt className="text-muted">Discount</dt>
                <dd className="text-right tabular-nums">−{money2(i.discount, i.currency)}</dd>
              </>
            )}
            {i.taxAmount > 0 && (
              <>
                <dt className="text-muted">Tax ({i.taxRate}%)</dt>
                <dd className="text-right tabular-nums">{money2(i.taxAmount, i.currency)}</dd>
              </>
            )}
            <dt className="font-bold">Total</dt>
            <dd className="text-right font-bold tabular-nums">{money2(i.total, i.currency)}</dd>
            <dt className="text-muted">Paid</dt>
            <dd className="text-right tabular-nums">{money2(i.amountPaid, i.currency)}</dd>
            <dt className="font-bold">Balance due</dt>
            <dd className={cx('text-right font-bold tabular-nums', i.balance > 0 && i.overdue && 'text-danger')}>
              {money2(i.balance, i.currency)}
            </dd>
          </dl>

          <section>
            <h3 className="mb-2 font-bold">Payments</h3>
            {i.payments.length === 0 && <p className="text-sm text-muted">No payments yet.</p>}
            <ul className="flex flex-col gap-2">
              {i.payments.map((p) => (
                <li
                  key={p.id}
                  className={cx(
                    'flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2',
                    p.voided && 'opacity-60',
                  )}
                >
                  <CircleDollarSign className="size-5 text-success" aria-hidden />
                  <span className={cx('font-semibold tabular-nums', p.voided && 'line-through')}>
                    {money2(p.amount, i.currency)}
                  </span>
                  <span className="text-sm text-muted">
                    {PAYMENT_METHOD_LABEL[p.method]} · {formatDay(p.paidAt)}
                    {p.reference ? ` · ${p.reference}` : ''}
                    {p.voided ? ' · removed' : ''}
                  </span>
                  {i.canManage && !p.voided && (
                    <button
                      type="button"
                      className="ml-auto text-sm font-semibold text-danger underline-offset-2 hover:underline"
                      onClick={() => action.mutate({ path: `/payments/${p.id}`, method: 'DELETE' })}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="flex flex-wrap gap-2">
            {i.canManage && i.status === 'DRAFT' && (
              <Button icon={<Send className="size-4" aria-hidden />} busy={action.isPending} onClick={() => action.mutate({ path: '/issue' })}>
                Issue invoice
              </Button>
            )}
            {i.canManage && i.status !== 'VOID' && i.status !== 'PAID' && (
              <Button
                variant={i.status === 'DRAFT' ? 'secondary' : 'primary'}
                icon={<Banknote className="size-4" aria-hidden />}
                onClick={() => setPaying(true)}
              >
                Record payment
              </Button>
            )}
            <a
              href={`/print/invoice/${i.id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line-strong/60 bg-surface px-4 font-semibold hover:bg-surface-2"
            >
              <Printer className="size-4" aria-hidden /> Print / PDF
            </a>
            {i.canManage && i.status !== 'DRAFT' && i.status !== 'VOID' && (
              <Button
                variant="secondary"
                icon={<Mail className="size-4" aria-hidden />}
                busy={action.isPending && action.variables?.path === '/email'}
                disabled={!settings.data?.emailEnabled || !i.billToEmail}
                title={
                  !settings.data?.emailEnabled
                    ? 'Set up email in Integrations first'
                    : !i.billToEmail
                      ? 'This customer has no email address'
                      : undefined
                }
                onClick={() => action.mutate({ path: '/email' })}
              >
                Email to customer
              </Button>
            )}
            {i.canManage && i.status !== 'VOID' && (
              <Button variant="ghost" icon={<Ban className="size-4" aria-hidden />} onClick={() => setVoiding(true)}>
                Void
              </Button>
            )}
          </div>
          {voiding && (
            <div className="flex flex-col gap-2 rounded-2xl border border-line p-3">
              <TextField
                label="Reason for voiding"
                value={voidReason}
                maxLength={300}
                onChange={(e) => setVoidReason(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setVoiding(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!voidReason.trim()}
                  busy={action.isPending}
                  onClick={() => action.mutate({ path: '/void', body: { reason: voidReason.trim() } })}
                >
                  Void invoice
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {paying && i && (
        <PaymentDialog
          invoice={i}
          onClose={() => setPaying(false)}
          onSaved={(inv) => {
            setPaying(false);
            done(inv);
          }}
        />
      )}
    </Dialog>
  );
}

function PaymentDialog({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: InvoiceDto;
  onClose: () => void;
  onSaved: (invoice: InvoiceDto) => void;
}) {
  const [amount, setAmount] = useState(invoice.balance);
  const [paidAt, setPaidAt] = useState(toDateInput(new Date()));
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<InvoiceDto>(`/sales/crm/invoices/${invoice.id}/payments`, {
        method: 'POST',
        body: {
          amount,
          paidAt: new Date(`${paidAt}T12:00:00`).toISOString(),
          method,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog open onClose={onClose} title={`Payment for ${invoice.number}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <p className="text-muted">
          Balance due: <b className="text-fg">{money2(invoice.balance, invoice.currency)}</b>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={`Amount (${invoice.currency})`}
            type="number"
            min={0.01}
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
          />
          <TextField label="Date received" type="date" required value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </div>
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Reference"
          hint="Bank transaction ID, cheque number…"
          maxLength={120}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <TextArea label="Notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={amount <= 0}>
            Save payment
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function InvoicesTab() {
  const [filter, setFilter] = useState<'ALL' | 'UNPAID' | 'OVERDUE' | 'PAID' | 'DRAFT' | 'VOID'>('UNPAID');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: () => api<CrmOverviewDto>('/sales/crm/overview'),
  });
  const invoices = useQuery({
    queryKey: ['crm', 'invoices', { filter, q }],
    queryFn: () =>
      api<InvoiceDto[]>('/sales/crm/invoices', {
        query: { status: filter === 'ALL' ? undefined : filter, q: q.trim() || undefined },
      }),
  });
  const labels = { ALL: 'All', UNPAID: 'Unpaid', OVERDUE: 'Overdue', PAID: 'Paid', DRAFT: 'Drafts', VOID: 'Void' };
  const balance = (invoices.data ?? []).reduce((s, i) => s + i.balance, 0);
  const currency = invoices.data?.[0]?.currency ?? overview.data?.currency ?? 'USD';
  return (
    <div className="flex flex-col gap-4">
      {overview.data && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat Icon={Receipt} label="Invoiced this month" value={moneyShort(overview.data.invoicedThisMonth, overview.data.currency)} />
          <Stat Icon={Banknote} label="Collected this month" value={moneyShort(overview.data.collectedThisMonth, overview.data.currency)} tone="success" />
          <Stat Icon={FileText} label="Waiting for payment" value={moneyShort(overview.data.outstanding, overview.data.currency)} />
          <Stat
            Icon={AlertTriangle}
            label="Overdue"
            value={moneyShort(overview.data.overdue, overview.data.currency)}
            hint={`${overview.data.overdueCount} invoices`}
            tone={overview.data.overdueCount > 0 ? 'danger' : 'brand'}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Show">
          {(Object.keys(labels) as Array<keyof typeof labels>).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={filter === k}
              onClick={() => setFilter(k)}
              className={cx(
                'min-h-10 rounded-lg px-3 text-sm font-semibold',
                filter === k ? 'bg-surface shadow-card' : 'text-muted',
              )}
            >
              {labels[k]}
            </button>
          ))}
        </div>
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search invoices</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Invoice number or customer"
            className="min-h-11 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-9"
          />
        </label>
        {overview.data?.canManageBilling && (
          <Button icon={<Plus className="size-5" aria-hidden />} onClick={() => setCreating(true)}>
            New invoice
          </Button>
        )}
      </div>
      {invoices.isPending && <Spinner label="Loading invoices" />}
      {invoices.isError && <Alert tone="error">{errorMessage(invoices.error)}</Alert>}
      {invoices.data?.length === 0 && (
        <EmptyState icon={<Receipt className="size-9" aria-hidden />} title="No invoices here">
          Open a won deal and choose Create invoice, or create one here.
        </EmptyState>
      )}
      {invoices.data && invoices.data.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-3 font-semibold">Invoice</th>
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Due</th>
                <th className="px-4 py-3 text-right font-semibold">Total</th>
                <th className="px-4 py-3 text-right font-semibold">Balance</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((inv) => (
                <tr
                  key={inv.id}
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2"
                  onClick={() => setOpen(inv.id)}
                >
                  <td className="px-4 py-3">
                    <button type="button" className="font-bold text-brand" onClick={() => setOpen(inv.id)}>
                      {inv.number}
                    </button>
                  </td>
                  <td className="px-4 py-3">{inv.billToName}</td>
                  <td className={cx('px-4 py-3', inv.overdue && 'font-semibold text-danger')}>{inv.dueDate}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money2(inv.total, inv.currency)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money2(inv.balance, inv.currency)}</td>
                  <td className="px-4 py-3">
                    <InvoiceStatusChip invoice={inv} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line">
                <td className="px-4 py-3 font-semibold" colSpan={4}>
                  {invoices.data.length} invoices
                </td>
                <td className="px-4 py-3 text-right font-bold tabular-nums">{money2(balance, currency)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {creating && (
        <InvoiceFormDialog
          onClose={() => setCreating(false)}
          onSaved={(inv) => {
            setCreating(false);
            setOpen(inv.id);
          }}
        />
      )}
      {open && <InvoicePanel invoiceId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────────────────────────── Targets ─────────────────────────────

export function TargetsTab() {
  const [month, setMonth] = useState(currentMonth());
  const [history, setHistory] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['crm', 'targets', month],
    queryFn: () => api<TargetsDto>('/sales/crm/targets', { query: { month } }),
  });
  const t = targets.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-surface-2"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <h2 className="min-w-44 text-center text-xl font-bold">{monthLabel(month)}</h2>
          <button
            type="button"
            aria-label="Next month"
            className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-surface-2"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
          {month !== currentMonth() && (
            <Button size="sm" variant="ghost" onClick={() => setMonth(currentMonth())}>
              This month
            </Button>
          )}
        </div>
        {t && (
          <p className="text-sm text-muted">
            Achievement = value of deals won in the month. Targets start fresh every month.
          </p>
        )}
      </div>
      {targets.isPending && <Spinner label="Loading targets" />}
      {targets.isError && <Alert tone="error">{errorMessage(targets.error)}</Alert>}
      {t && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat Icon={Target} label="Team target" value={moneyShort(t.totals.target, t.currency)} />
            <Stat
              Icon={Trophy}
              label="Achieved"
              value={moneyShort(t.totals.achieved, t.currency)}
              hint={t.totals.target > 0 ? `${Math.round((t.totals.achieved / t.totals.target) * 100)}% of target` : undefined}
              tone="success"
            />
            <Stat Icon={Banknote} label="Collected" value={moneyShort(t.totals.collected, t.currency)} />
          </div>
          <div className="flex flex-col gap-3">
            {t.team.map((p) => (
              <TargetRow
                key={p.user.id}
                row={p}
                currency={t.currency}
                month={month}
                canManage={t.canManage}
                onHistory={() => setHistory(p.user.id)}
              />
            ))}
            {t.team.length === 0 && <p className="text-muted">No sales people yet.</p>}
          </div>
        </>
      )}
      {history && <TargetHistoryDialog userId={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function TargetRow({
  row,
  currency,
  month,
  canManage,
  onHistory,
}: {
  row: TargetsDto['team'][number];
  currency: string;
  month: string;
  canManage: boolean;
  onHistory: () => void;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(row.target?.toString() ?? '');
  const save = useMutation({
    mutationFn: () =>
      api<TargetsDto>('/sales/crm/targets', {
        method: 'PUT',
        body: { userId: row.user.id, month, amount: Number(value) || 0 },
      }),
    onSuccess: (data) => {
      client.setQueryData(['crm', 'targets', month], data);
      void client.invalidateQueries({ queryKey: ['crm', 'overview'] });
    },
  });
  const pct = row.progress === null ? null : Math.round(row.progress * 100);
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={row.user.displayName} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-bold">{row.user.displayName}</p>
          <p className="text-sm text-muted">
            {row.wonDeals} deals won ({row.upsells} upsells) · {row.leadsClosed} leads closed, {row.leadsWon} won ·
            collected {moneyShort(row.collected, currency)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold tabular-nums">{moneyShort(row.achieved, currency)}</p>
          <p className="text-sm text-muted">
            {row.target !== null ? `of ${moneyShort(row.target, currency)} · ${pct}%` : 'No target'}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <ProgressBar value={row.progress} />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {canManage && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <TextField
              label={`Target (${currency})`}
              type="number"
              min={0}
              step="0.01"
              className="w-40"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={save.isPending} disabled={value === ''}>
              Save
            </Button>
          </form>
        )}
        <Button variant="ghost" size="sm" onClick={onHistory}>
          Past months
        </Button>
        {save.isError && <span className="text-sm font-semibold text-danger">{errorMessage(save.error)}</span>}
      </div>
    </section>
  );
}

/** 12 months of achieved value (bars) against the target (marker), one money axis. */
function TargetHistoryDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const history = useQuery({
    queryKey: ['crm', 'target-history', userId],
    queryFn: () => api<TargetHistoryDto>(`/sales/crm/targets/history/${userId}`),
  });
  const [hover, setHover] = useState<number | null>(null);
  const h = history.data;
  const max = h ? Math.max(1, ...h.months.flatMap((m) => [m.achieved, m.target ?? 0])) : 1;
  return (
    <Dialog open onClose={onClose} title={h ? `${h.user.displayName} · past months` : 'Past months'} wide>
      {history.isPending && <Spinner />}
      {history.isError && <Alert tone="error">{errorMessage(history.error)}</Alert>}
      {h && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-3 rounded-sm" style={{ background: 'var(--series-1)' }} aria-hidden /> Achieved
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-fg" aria-hidden /> Target
            </span>
          </div>
          <div className="relative flex h-48 items-end gap-2 border-b border-line">
            {h.months.map((m, idx) => (
              <div
                key={m.month}
                tabIndex={0}
                className="relative flex h-full flex-1 items-end justify-center"
                onMouseEnter={() => setHover(idx)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(idx)}
                onBlur={() => setHover(null)}
                aria-label={`${monthLabel(m.month)}: achieved ${money2(m.achieved, h.currency)}${m.target !== null ? `, target ${money2(m.target, h.currency)}` : ''}`}
              >
                <span
                  className="w-full max-w-7 rounded-t"
                  style={{
                    height: `${m.achieved > 0 ? Math.max(2, (m.achieved / max) * 100) : 0}%`,
                    background: 'var(--series-1)',
                  }}
                />
                {m.target !== null && (
                  <span
                    className="absolute inset-x-0.5 h-0.5 bg-fg"
                    style={{ bottom: `${(m.target / max) * 100}%` }}
                    aria-hidden
                  />
                )}
                {hover === idx && (
                  <span className="absolute bottom-full z-10 mb-2 w-max rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                    <span className="block font-bold">{monthLabel(m.month)}</span>
                    <span className="block">Achieved {money2(m.achieved, h.currency)}</span>
                    <span className="block">
                      Target {m.target !== null ? money2(m.target, h.currency) : 'not set'}
                    </span>
                  </span>
                )}
              </div>
            ))}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-semibold">Month</th>
                <th className="py-1 text-right font-semibold">Target</th>
                <th className="py-1 text-right font-semibold">Achieved</th>
                <th className="py-1 text-right font-semibold">Leads won</th>
              </tr>
            </thead>
            <tbody>
              {[...h.months].reverse().map((m) => (
                <tr key={m.month} className="border-t border-line">
                  <td className="py-1.5">{monthLabel(m.month)}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.target !== null ? money2(m.target, h.currency) : '—'}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {money2(m.achieved, h.currency)}
                    {m.target ? ` (${Math.round((m.achieved / m.target) * 100)}%)` : ''}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{m.leadsWon}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────────── Services ─────────────────────────────

export function ServicesTab() {
  const services = useServices();
  const settings = useCrmSettings();
  const overview = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: () => api<CrmOverviewDto>('/sales/crm/overview'),
  });
  const [editing, setEditing] = useState<CrmServiceDto | 'new' | null>(null);
  const canManage = overview.data?.canManageCatalog ?? false;
  const currency = settings.data?.currency ?? 'USD';
  const groups = useMemo(() => {
    const map = new Map<string, CrmServiceDto[]>();
    for (const s of services.data ?? []) {
      const key = s.category || 'Other';
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [services.data]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted">The services SMA sells. Deals and invoices pick from this list.</p>
        {canManage && (
          <Button icon={<Plus className="size-5" aria-hidden />} onClick={() => setEditing('new')}>
            Add service
          </Button>
        )}
      </div>
      {services.isPending && <Spinner label="Loading services" />}
      {services.isError && <Alert tone="error">{errorMessage(services.error)}</Alert>}
      {services.data?.length === 0 && (
        <EmptyState icon={<Package className="size-9" aria-hidden />} title="No services yet">
          Add what you sell: plans, add-ons, setup, training…
        </EmptyState>
      )}
      {groups.map(([category, list]) => (
        <section key={category}>
          <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">{category}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => (
              <div
                key={s.id}
                className={cx(
                  'flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card',
                  !s.active && 'opacity-60',
                )}
              >
                <div className="flex items-start gap-2">
                  <Package className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
                  <span className="min-w-0 flex-1 font-bold">{s.name}</span>
                  {!s.active && <Chip cls="bg-surface-3 text-muted">Not sold</Chip>}
                </div>
                {s.description && <p className="line-clamp-3 text-sm text-muted">{s.description}</p>}
                <div className="mt-auto flex items-end justify-between gap-2">
                  <span>
                    <span className="text-xl font-bold tabular-nums">{money2(s.price, currency)}</span>{' '}
                    <span className="text-sm text-muted">{s.billing === 'ONE_TIME' ? 'one-time' : BILLING_LABEL[s.billing]}</span>
                  </span>
                  <span className="text-sm text-muted">Sold {s.timesSold}×</span>
                </div>
                {canManage && (
                  <Button size="sm" variant="secondary" icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      {editing && (
        <ServiceDialog
          service={editing === 'new' ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ServiceDialog({
  service,
  currency,
  onClose,
}: {
  service: CrmServiceDto | null;
  currency: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState({
    name: service?.name ?? '',
    description: service?.description ?? '',
    category: service?.category ?? '',
    price: service?.price ?? 0,
    billing: service?.billing ?? ('MONTHLY' as ServiceBilling),
    active: service?.active ?? true,
  });
  const save = useMutation({
    mutationFn: () =>
      api<CrmServiceDto[]>(service ? `/sales/crm/services/${service.id}` : '/sales/crm/services', {
        method: service ? 'PATCH' : 'POST',
        body: {
          name: form.name.trim(),
          description: form.description.trim() || null,
          category: form.category.trim() || null,
          price: form.price,
          billing: form.billing,
          active: form.active,
        },
      }),
    onSuccess: (list) => {
      client.setQueryData(['crm', 'services'], list);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={service ? 'Edit service' : 'Add service'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <TextField label="Name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField
          label="Category"
          hint="e.g. Plans, Add-ons, Setup"
          maxLength={60}
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
        <TextArea label="Description" rows={3} maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={`Price (${currency})`}
            type="number"
            min={0}
            step="0.01"
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: Math.max(0, Number(e.target.value) || 0) })}
          />
          <SelectField label="Billing" value={form.billing} onChange={(e) => setForm({ ...form, billing: e.target.value as ServiceBilling })}>
            <option value="ONE_TIME">One-time</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </SelectField>
        </div>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5 accent-[var(--color-brand)]"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          <span className="font-semibold">Currently sold</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!form.name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── Customers ─────────────────────────────

export function CrmCustomersTab({
  context,
  team,
  wonNotSetUp,
  onOpenLead,
}: {
  context: SalesContextDto;
  team: SalesUserDto[];
  /** Won leads that are not an SMA customer business yet. */
  wonNotSetUp: LeadDto[];
  onOpenLead: (id: string) => void;
}) {
  const customers = useCustomers();
  const [q, setQ] = useState('');
  const [upsellFor, setUpsellFor] = useState<{ id: string; name: string } | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<{ id: string; name: string } | null>(null);
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: () => api<CrmOverviewDto>('/sales/crm/overview'),
  });
  const list = (customers.data ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const currency = overview.data?.currency ?? 'USD';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search customers</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SMA customers"
            className="min-h-11 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-9"
          />
        </label>
      </div>
      {wonNotSetUp.length > 0 && (
        <Alert tone="warning" title={`${wonNotSetUp.length} won leads are not set up yet`}>
          <span className="mt-1 flex flex-wrap gap-2">
            {wonNotSetUp.map((l) => (
              <button
                key={l.id}
                type="button"
                className="rounded-full bg-surface px-3 py-1 text-sm font-semibold hover:bg-surface-2"
                onClick={() => onOpenLead(l.id)}
              >
                {l.companyName}
              </button>
            ))}
          </span>
        </Alert>
      )}
      {customers.isPending && <Spinner label="Loading customers" />}
      {customers.isError && <Alert tone="error">{errorMessage(customers.error)}</Alert>}
      {customers.data?.length === 0 && (
        <EmptyState icon={<BadgeCheck className="size-9" aria-hidden />} title="No SMA customers yet">
          Win a lead and convert it to create the first one.
        </EmptyState>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((c) => (
          <section key={c.id} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-start gap-3">
              <Avatar name={c.name} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-bold">{c.name}</p>
                <p className="text-sm text-muted">
                  {c.storeCount} stores · since {formatDay(c.lead?.convertedAt ?? c.createdAt)}
                  {c.lead?.owner ? ` · ${c.lead.owner.displayName}` : ''}
                </p>
              </div>
              {c.status !== 'ACTIVE' && <Chip cls="bg-warning-surface text-warning">{c.status.toLowerCase()}</Chip>}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini label="Lifetime" value={moneyShort(c.lifetimeValue, currency)} />
              <Mini label="Paid" value={moneyShort(c.paid, currency)} />
              <Mini label="Owes" value={moneyShort(c.outstanding, currency)} />
            </div>
            {c.services.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {c.services.map((s) => (
                  <span key={s} className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand-strong">
                    {s}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-muted">
              {c.wonDeals} deals won · {c.upsells} upsells · {c.openDeals} open
            </p>
            <div className="mt-auto flex flex-wrap gap-2">
              <Button size="sm" icon={<TrendingUp className="size-4" aria-hidden />} onClick={() => setUpsellFor({ id: c.id, name: c.name })}>
                Upsell
              </Button>
              {overview.data?.canManageBilling && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Receipt className="size-4" aria-hidden />}
                  onClick={() => setInvoiceFor({ id: c.id, name: c.name })}
                >
                  Invoice
                </Button>
              )}
              {c.lead && (
                <Button size="sm" variant="ghost" onClick={() => onOpenLead(c.lead!.id)}>
                  Lead history
                </Button>
              )}
            </div>
          </section>
        ))}
      </div>
      {upsellFor && (
        <DealFormDialog
          preset={{ type: 'UPSELL', customer: upsellFor }}
          team={team}
          canAssign={context.canAssign}
          onClose={() => setUpsellFor(null)}
          onSaved={(d) => {
            setUpsellFor(null);
            setOpenDeal(d.id);
          }}
        />
      )}
      {invoiceFor && (
        <InvoiceFormDialog
          customer={invoiceFor}
          onClose={() => setInvoiceFor(null)}
          onSaved={(inv) => {
            setInvoiceFor(null);
            setOpenInvoice(inv.id);
          }}
        />
      )}
      {openDeal && (
        <DealPanel
          dealId={openDeal}
          context={context}
          team={team}
          onClose={() => setOpenDeal(null)}
          onOpenInvoice={(id) => {
            setOpenDeal(null);
            setOpenInvoice(id);
          }}
        />
      )}
      {openInvoice && <InvoicePanel invoiceId={openInvoice} onClose={() => setOpenInvoice(null)} />}
    </div>
  );
}

// ───────────────────────────── Website form ─────────────────────────────

/** Link and embed code for the website's "Request a demo" form. */
export function WebsiteFormDialog({ onClose }: { onClose: () => void }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = `${origin}/embed/lead-form`;
  const code = `<iframe src="${link}" title="Request a demo" style="width:100%;max-width:560px;height:780px;border:0" loading="lazy"></iframe>`;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    const { copyText } = await import('@/lib/clipboard');
    await copyText(value);
    setCopied(label);
  };
  return (
    <Dialog open onClose={onClose} title="Website lead form" wide>
      <div className="flex flex-col gap-4">
        <p className="text-muted">
          Put this form on SMA’s website. Every request lands in Leads as a new website lead in
          the unassigned queue, with the page it came from.
        </p>
        <div>
          <p className="mb-1 font-semibold">Link</p>
          <div className="flex gap-2">
            <input readOnly value={link} className="min-h-11 flex-1 rounded-xl border border-line bg-surface-2 px-3 font-mono text-sm" />
            <Button variant="secondary" onClick={() => void copy('link', link)}>
              {copied === 'link' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <div>
          <p className="mb-1 font-semibold">Embed code (paste into the website page)</p>
          <textarea
            readOnly
            rows={3}
            value={code}
            className="w-full rounded-xl border border-line bg-surface-2 p-3 font-mono text-sm"
          />
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" onClick={() => void copy('code', code)}>
              {copied === 'code' ? 'Copied' : 'Copy code'}
            </Button>
            <a
              href={link}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-12 items-center rounded-xl px-4 font-semibold text-brand hover:bg-surface-2"
            >
              Preview
            </a>
          </div>
        </div>
        <Alert tone="info">
          The website must link to SMA’s public https address (not a local Wi-Fi address) for
          visitors to reach the form.
        </Alert>
      </div>
    </Dialog>
  );
}
