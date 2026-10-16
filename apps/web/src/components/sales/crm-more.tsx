'use client';

import {
  LEAD_IMPORT_FIELDS,
  LEAD_SOURCES,
  type CommissionPlanDto,
  type CrmSettingsDto,
  type DealDto,
  type LeadImportField,
  type LeadImportPreviewDto,
  type LeadImportResultDto,
  type LeadSource,
  type PaymentClaimDto,
  type PublicUserDto,
  type QuoteDto,
  type QuoteStatus,
  type SalesUserDto,
  type SubscriptionDto,
  type UpdateCrmSettingsRequest,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Mail,
  Pause,
  Play,
  Plus,
  Printer,
  Send,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Alert,
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
import { SampleFileButton } from '@/components/manage/bulk-import';
import { copyText } from '@/lib/clipboard';
import { formatDay } from '@/lib/format';
import {
  customerFields,
  type CustomerPick,
  Chip,
  ItemsEditor,
  money2,
  newKey,
  PAYMENT_METHOD_LABEL,
  refreshCrm,
  useCrmSettings,
  useCustomers,
  type DraftItem,
} from './crm';
import { SOURCE_LABEL } from './labels';

const QUOTE_STATUS: Record<QuoteStatus, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-surface-3 text-fg' },
  SENT: { label: 'Sent', cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  ACCEPTED: { label: 'Accepted', cls: 'bg-success-soft text-success' },
  DECLINED: { label: 'Declined', cls: 'bg-danger-surface text-danger' },
  EXPIRED: { label: 'Expired', cls: 'bg-surface-3 text-muted' },
};

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ───────────────────────────── Links ─────────────────────────────

function LinkBox({ title, path, hint }: { title: string; path: string; hint: string }) {
  const url = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-2xl border border-line bg-surface-2 p-3">
      <p className="font-semibold">{title}</p>
      <p className="mb-2 text-sm text-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        <input
          readOnly
          value={url}
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Copy className="size-4" aria-hidden />}
          onClick={() => void copyText(url).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(url)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-line-strong/60 bg-surface px-3 text-sm font-semibold hover:bg-surface-3"
        >
          WhatsApp
        </a>
        <a
          href={path}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-10 items-center gap-1 rounded-xl px-3 text-sm font-semibold text-brand hover:bg-surface-3"
        >
          <ExternalLink className="size-4" aria-hidden /> Open
        </a>
      </div>
    </section>
  );
}

/** The customer's pay page link. */
export function PayLinkBox({ path }: { path: string }) {
  return (
    <LinkBox
      title="Pay link for the customer"
      path={path}
      hint="They see the invoice and your JazzCash, Easypaisa and bank details, and can tell you when they have paid."
    />
  );
}

// ───────────────────────────── Payment claims ─────────────────────────────

export function PaymentClaimsBox({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const client = useQueryClient();
  const claims = useQuery({
    queryKey: ['crm', 'claims', 'PENDING'],
    queryFn: () =>
      api<PaymentClaimDto[]>('/sales/crm/payment-claims', { query: { status: 'PENDING' } }),
    refetchInterval: 60_000,
  });
  const review = useMutation({
    mutationFn: (v: { id: string; action: 'confirm' | 'reject' }) =>
      api<PaymentClaimDto[]>(`/sales/crm/payment-claims/${v.id}/review`, {
        method: 'POST',
        body: { action: v.action },
      }),
    onSuccess: (list) => {
      client.setQueryData(['crm', 'claims', 'PENDING'], list);
      refreshCrm(client);
    },
  });
  if (!claims.data?.length) return null;
  return (
    <section className="rounded-3xl border border-warning/40 bg-warning-surface p-4">
      <h2 className="mb-1 font-bold">Payments to confirm ({claims.data.length})</h2>
      <p className="mb-3 text-sm text-muted">
        Customers said they paid. Check that the money arrived in your account, then confirm (it is
        recorded on the invoice) or reject.
      </p>
      {review.isError && <Alert tone="error">{errorMessage(review.error)}</Alert>}
      <ul className="flex flex-col gap-2">
        {claims.data.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {money2(c.amount, c.invoice.currency)} · {PAYMENT_METHOD_LABEL[c.method]} · ref{' '}
                {c.reference}
              </p>
              <p className="text-sm text-muted">
                <button
                  type="button"
                  className="font-semibold text-brand"
                  onClick={() => onOpenInvoice(c.invoice.id)}
                >
                  {c.invoice.number}
                </button>{' '}
                · {c.invoice.billToName}
                {c.payerName ? ` · paid by ${c.payerName}` : ''} · {formatDay(c.createdAt)}
                {c.note ? ` · “${c.note}”` : ''}
              </p>
            </div>
            <Button
              size="sm"
              icon={<CheckCircle2 className="size-4" aria-hidden />}
              busy={review.isPending}
              onClick={() => review.mutate({ id: c.id, action: 'confirm' })}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<XCircle className="size-4" aria-hidden />}
              onClick={() => review.mutate({ id: c.id, action: 'reject' })}
            >
              Reject
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── Quotes ─────────────────────────────

export function QuoteFormDialog({
  deal,
  onClose,
  onSaved,
}: {
  deal?: DealDto;
  onClose: () => void;
  onSaved: (quote: QuoteDto) => void;
}) {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const customers = useCustomers();
  const [businessId, setBusinessId] = useState('');
  const [billToName, setBillToName] = useState('');
  const [billToEmail, setBillToEmail] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [validUntil, setValidUntil] = useState(toDateInput(new Date(Date.now() + 14 * 86_400_000)));
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState(
    'Prices are valid until the date above. Monthly plans are billed in advance.',
  );
  const [items, setItems] = useState<DraftItem[]>([]);
  const cur = deal?.currency ?? currency ?? settings.data?.defaultCurrency ?? 'USD';
  const tax = taxRate ?? settings.data?.taxRate ?? 0;
  const save = useMutation({
    mutationFn: () =>
      api<QuoteDto>('/sales/crm/quotes', {
        method: 'POST',
        body: {
          ...(deal
            ? { dealId: deal.id }
            : {
                ...customerFields(businessId, customers.data),
                currency: cur,
                items: items.map((i) => ({
                  serviceId: i.serviceId ?? null,
                  name: i.name.trim(),
                  quantity: i.quantity,
                  unitPrice: Math.round(i.unitPrice * (1 - (i.discountPct ?? 0) / 100) * 100) / 100,
                  billing: i.billing ?? 'ONE_TIME',
                })),
              }),
          ...(billToName.trim() ? { billToName: billToName.trim() } : {}),
          ...(billToEmail.trim() ? { billToEmail: billToEmail.trim() } : {}),
          validUntil: new Date(`${validUntil}T12:00:00`).toISOString(),
          discount,
          taxRate: tax,
          notes: notes.trim() || null,
          terms: terms.trim() || null,
        },
      }),
    onSuccess: (q) => {
      refreshCrm(client);
      onSaved(q);
    },
  });
  return (
    <Dialog open onClose={onClose} title={deal ? `Quote for “${deal.title}”` : 'New quote'} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {deal ? (
          <Alert
            tone="info"
            title={`${deal.items.length} items · ${money2(deal.amount, deal.currency)}`}
          >
            The deal’s services are copied onto the quote. When the customer accepts it, the deal is
            won and the invoice is created automatically.
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
                label="Quote for"
                required
                maxLength={160}
                value={billToName}
                onChange={(e) => setBillToName(e.target.value)}
              />
            )}
            <SelectField label="Currency" value={cur} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">US dollars (USD)</option>
              <option value="PKR">Pakistani rupees (PKR)</option>
            </SelectField>
            <fieldset>
              <legend className="mb-1 font-semibold">Items</legend>
              <ItemsEditor items={items} onChange={setItems} currency={cur} />
            </fieldset>
          </>
        )}
        <TextField
          label="Customer email (to send the quote)"
          type="email"
          hint="Leave empty to use the email on file"
          value={billToEmail}
          onChange={(e) => setBillToEmail(e.target.value)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField
            label="Valid until"
            type="date"
            required
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
          <TextField
            label={`Discount (${cur})`}
            type="number"
            min={0}
            step="0.01"
            value={discount}
            onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))}
          />
          <TextField
            label={`${settings.data?.taxName ?? 'Tax'} %`}
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={tax}
            onChange={(e) => setTaxRate(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
          />
        </div>
        <TextArea
          label="Message to the customer"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <TextArea
          label="Terms"
          rows={2}
          maxLength={2000}
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={!deal && (items.length === 0 || (!businessId && !billToName.trim()))}
          >
            Create quote
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function QuotePanel({ quoteId, onClose }: { quoteId: string; onClose: () => void }) {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const quote = useQuery({
    queryKey: ['crm', 'quote', quoteId],
    queryFn: () => api<QuoteDto>(`/sales/crm/quotes/${quoteId}`),
  });
  const send = useMutation({
    mutationFn: (email: boolean) =>
      api<QuoteDto & { emailed: boolean }>(`/sales/crm/quotes/${quoteId}/send`, {
        method: 'POST',
        body: { email },
      }),
    onSuccess: (q) => {
      client.setQueryData(['crm', 'quote', quoteId], q);
      refreshCrm(client);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/sales/crm/quotes/${quoteId}`, { method: 'DELETE' }),
    onSuccess: () => {
      refreshCrm(client);
      onClose();
    },
  });
  const q = quote.data;
  return (
    <Dialog open onClose={onClose} title={q ? `Quote ${q.number}` : 'Quote'} wide>
      {quote.isPending && <Spinner />}
      {quote.isError && <Alert tone="error">{errorMessage(quote.error)}</Alert>}
      {q && (
        <div className="flex flex-col gap-4">
          {(send.isError || remove.isError) && (
            <Alert tone="error">{errorMessage(send.error ?? remove.error)}</Alert>
          )}
          {send.data?.emailed && <Alert tone="success">Emailed to {q.billToEmail}.</Alert>}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-bold">{q.billToName}</p>
              <p className="text-sm text-muted">
                {[q.billToEmail, q.billToPhone].filter(Boolean).join(' · ') || 'No contact details'}
              </p>
              {q.deal && <p className="text-sm text-muted">Deal: {q.deal.title}</p>}
            </div>
            <div className="text-right">
              <Chip cls={QUOTE_STATUS[q.status].cls}>{QUOTE_STATUS[q.status].label}</Chip>
              <p className="mt-1 text-sm text-muted">
                Issued {q.issueDate} · Valid until {q.validUntil}
              </p>
              {q.viewedAt && (
                <p className="text-xs text-muted">Opened by the customer {formatDay(q.viewedAt)}</p>
              )}
            </div>
          </div>
          {q.respondedAt && (
            <Alert
              tone={q.status === 'ACCEPTED' ? 'success' : 'warning'}
              title={q.status === 'ACCEPTED' ? 'Accepted' : 'Declined'}
            >
              By {q.responseName} on {formatDay(q.respondedAt)}
              {q.responseNote ? ` — “${q.responseNote}”` : ''}
              {q.status === 'ACCEPTED' && q.invoiceId ? '. The invoice was created.' : ''}
            </Alert>
          )}
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
              {q.items.map((it) => (
                <tr key={it.id} className="border-b border-line/60">
                  <td className="py-2">
                    <span className="font-semibold">{it.name}</span>
                    {it.description && (
                      <span className="block text-xs text-muted">{it.description}</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{it.quantity}</td>
                  <td className="py-2 text-right tabular-nums">
                    {money2(it.unitPrice, q.currency)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{money2(it.total, q.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-right">
            {q.discount > 0 && (
              <span className="block text-sm text-muted">
                Discount −{money2(q.discount, q.currency)}
              </span>
            )}
            {q.taxAmount > 0 && (
              <span className="block text-sm text-muted">
                {settings.data?.taxName ?? 'Tax'} ({q.taxRate}%) {money2(q.taxAmount, q.currency)}
              </span>
            )}
            <span className="text-lg font-bold">Total {money2(q.total, q.currency)}</span>
          </p>
          {q.status !== 'DRAFT' && q.status !== 'EXPIRED' && (
            <LinkBox
              title="Quote link for the customer"
              path={q.publicUrl}
              hint="They can read it and accept or decline online."
            />
          )}
          {q.canManage && (
            <div className="flex flex-wrap gap-2">
              {(q.status === 'DRAFT' || q.status === 'SENT') && (
                <>
                  <Button
                    icon={<Mail className="size-4" aria-hidden />}
                    busy={send.isPending && send.variables === true}
                    disabled={!q.billToEmail || !settings.data?.emailEnabled}
                    title={
                      !settings.data?.emailEnabled
                        ? 'Set up email in Integrations first'
                        : undefined
                    }
                    onClick={() => send.mutate(true)}
                  >
                    Email to customer
                  </Button>
                  {q.status === 'DRAFT' && (
                    <Button
                      variant="secondary"
                      icon={<Send className="size-4" aria-hidden />}
                      busy={send.isPending && send.variables === false}
                      onClick={() => send.mutate(false)}
                    >
                      Mark as sent (share the link yourself)
                    </Button>
                  )}
                </>
              )}
              <a
                href={`/print/quote/${q.id}`}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line-strong/60 bg-surface px-4 font-semibold hover:bg-surface-2"
              >
                <Printer className="size-4" aria-hidden /> Print / PDF
              </a>
              {q.status !== 'ACCEPTED' && (
                <Button
                  variant="ghost"
                  icon={<Trash2 className="size-4" aria-hidden />}
                  busy={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function QuotesTab() {
  const [status, setStatus] = useState<QuoteStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const settings = useCrmSettings();
  const quotes = useQuery({
    queryKey: ['crm', 'quotes', status],
    queryFn: () => api<QuoteDto[]>('/sales/crm/quotes', { query: { status: status || undefined } }),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1"
          role="radiogroup"
          aria-label="Show"
        >
          {(['', 'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const).map((k) => (
            <button
              key={k || 'all'}
              type="button"
              role="radio"
              aria-checked={status === k}
              onClick={() => setStatus(k)}
              className={cx(
                'min-h-10 rounded-lg px-3 text-sm font-semibold',
                status === k ? 'bg-surface shadow-card' : 'text-muted',
              )}
            >
              {k ? QUOTE_STATUS[k].label : 'All'}
            </button>
          ))}
        </div>
        {settings.data?.canManage && (
          <Button
            className="ml-auto"
            icon={<Plus className="size-5" aria-hidden />}
            onClick={() => setCreating(true)}
          >
            New quote
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">
        Tip: open a deal and choose <b>Create quote</b> — accepting the quote then wins the deal and
        creates the invoice.
      </p>
      {quotes.isPending && <Spinner label="Loading quotes" />}
      {quotes.isError && <Alert tone="error">{errorMessage(quotes.error)}</Alert>}
      {quotes.data?.length === 0 && (
        <EmptyState icon={<FileText className="size-9" aria-hidden />} title="No quotes here" />
      )}
      {quotes.data && quotes.data.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-3 font-semibold">Quote</th>
                <th className="px-4 py-3 font-semibold">For</th>
                <th className="px-4 py-3 font-semibold">Valid until</th>
                <th className="px-4 py-3 text-right font-semibold">Total</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.map((q) => (
                <tr
                  key={q.id}
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2"
                  onClick={() => setOpen(q.id)}
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="font-bold text-brand"
                      onClick={() => setOpen(q.id)}
                    >
                      {q.number}
                    </button>
                  </td>
                  <td className="px-4 py-3">{q.billToName}</td>
                  <td className="px-4 py-3">{q.validUntil}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money2(q.total, q.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <Chip cls={QUOTE_STATUS[q.status].cls}>{QUOTE_STATUS[q.status].label}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <QuoteFormDialog
          onClose={() => setCreating(false)}
          onSaved={(q) => {
            setCreating(false);
            setOpen(q.id);
          }}
        />
      )}
      {open && <QuotePanel quoteId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────────────────────────── Monthly billing ─────────────────────────────

export function SubscriptionDialog({
  customer,
  deal,
  subscription,
  onClose,
}: {
  customer: CustomerPick;
  deal?: DealDto;
  subscription?: SubscriptionDto;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const recurring = deal?.items.filter((i) => i.billing !== 'ONE_TIME') ?? [];
  const [name, setName] = useState(
    subscription?.name ?? (deal ? deal.title : `${customer.name} plan`),
  );
  const [interval, setInterval] = useState<'MONTHLY' | 'YEARLY'>(
    subscription?.interval ??
      (recurring.some((i) => i.billing === 'YEARLY') ? 'YEARLY' : 'MONTHLY'),
  );
  const [currency, setCurrency] = useState(
    subscription?.currency ?? deal?.currency ?? settings.data?.defaultCurrency ?? 'USD',
  );
  const [startDate, setStartDate] = useState(
    subscription?.nextInvoiceAt ?? toDateInput(new Date()),
  );
  const [dueDays, setDueDays] = useState(subscription?.dueDays ?? 7);
  const [autoEmail, setAutoEmail] = useState(subscription?.autoEmail ?? true);
  const [items, setItems] = useState<DraftItem[]>(
    subscription
      ? subscription.items.map((i) => ({
          key: newKey(),
          serviceId: null,
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discountPct: 0,
          billing: interval,
        }))
      : recurring.map((i) => ({
          key: newKey(),
          serviceId: i.serviceId,
          name: i.name,
          quantity: 1,
          unitPrice: i.unitPrice,
          discountPct: i.discountPct,
          billing: i.billing,
        })),
  );
  const save = useMutation({
    mutationFn: () => {
      const lines = items.map((i) => ({
        serviceId: i.serviceId ?? null,
        name: i.name.trim(),
        quantity: i.quantity,
        unitPrice: Math.round(i.unitPrice * (1 - (i.discountPct ?? 0) / 100) * 100) / 100,
      }));
      return subscription
        ? api<SubscriptionDto>(`/sales/crm/subscriptions/${subscription.id}`, {
            method: 'PATCH',
            body: {
              items: lines,
              autoEmail,
              dueDays,
              nextInvoiceAt: new Date(`${startDate}T12:00:00`).toISOString(),
            },
          })
        : api<SubscriptionDto>('/sales/crm/subscriptions', {
            method: 'POST',
            body: {
              ...customerFields(customer.id, undefined, customer.kind ?? 'BUSINESS'),
              dealId: deal?.id ?? null,
              name: name.trim(),
              currency,
              interval,
              startDate: new Date(`${startDate}T12:00:00`).toISOString(),
              dueDays,
              autoEmail,
              items: lines,
            },
          });
    },
    onSuccess: () => {
      refreshCrm(client);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={subscription ? 'Edit monthly billing' : `Monthly billing · ${customer.name}`}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <Alert tone="info">
          An invoice is created automatically on the date below and then every{' '}
          {interval === 'MONTHLY' ? 'month' : 'year'}
          {autoEmail ? ', and emailed to the customer' : ''}. Overdue invoices get reminders.
        </Alert>
        {!subscription && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField
              label="Plan name"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="sm:col-span-3"
            />
            <SelectField
              label="Every"
              value={interval}
              onChange={(e) => setInterval(e.target.value as 'MONTHLY' | 'YEARLY')}
            >
              <option value="MONTHLY">Month</option>
              <option value="YEARLY">Year</option>
            </SelectField>
            <SelectField
              label="Currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="USD">USD</option>
              <option value="PKR">PKR</option>
            </SelectField>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField
            label={subscription ? 'Next invoice on' : 'First invoice on'}
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <TextField
            label="Days to pay"
            type="number"
            min={0}
            max={90}
            value={dueDays}
            onChange={(e) => setDueDays(Math.min(90, Math.max(0, Number(e.target.value) || 0)))}
          />
          <label className="flex min-h-12 items-center gap-2 self-end">
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-brand)]"
              checked={autoEmail}
              onChange={(e) => setAutoEmail(e.target.checked)}
            />
            Email each invoice
          </label>
        </div>
        <fieldset>
          <legend className="mb-1 font-semibold">
            Billed each {interval === 'MONTHLY' ? 'month' : 'year'}
          </legend>
          <ItemsEditor items={items} onChange={setItems} currency={currency} />
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={items.length === 0 || !name.trim()}>
            {subscription ? 'Save' : 'Start billing'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SubscriptionsTab() {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const [editing, setEditing] = useState<SubscriptionDto | null>(null);
  const subs = useQuery({
    queryKey: ['crm', 'subscriptions'],
    queryFn: () => api<SubscriptionDto[]>('/sales/crm/subscriptions'),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' }) =>
      api<SubscriptionDto>(`/sales/crm/subscriptions/${v.id}`, {
        method: 'PATCH',
        body: { status: v.status },
      }),
    onSuccess: () => refreshCrm(client),
  });
  const monthly = (subs.data ?? []).filter((s) => s.status === 'ACTIVE');
  const mrr = (cur: string) =>
    monthly
      .filter((s) => s.currency === cur)
      .reduce((sum, s) => sum + (s.interval === 'MONTHLY' ? s.amount : s.amount / 12), 0);
  const canManage = settings.data?.canManage ?? false;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">
        Customers billed automatically. Start one from a won deal (<b>Bill monthly</b>) or a
        customer card (<b>Monthly billing</b>).
      </p>
      {monthly.length > 0 && (
        <p className="font-semibold">
          Monthly recurring revenue:{' '}
          {['USD', 'PKR']
            .filter((c) => mrr(c) > 0)
            .map((c) => money2(mrr(c), c))
            .join(' + ')}
        </p>
      )}
      {(subs.isError || update.isError) && (
        <Alert tone="error">{errorMessage(subs.error ?? update.error)}</Alert>
      )}
      {subs.isPending && <Spinner />}
      {subs.data?.length === 0 && (
        <EmptyState
          icon={<CalendarClock className="size-9" aria-hidden />}
          title="No monthly billing yet"
        />
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {subs.data?.map((s) => (
          <section
            key={s.id}
            className={cx(
              'flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card',
              s.status !== 'ACTIVE' && 'opacity-70',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-bold">{s.customer?.name ?? 'Customer removed'}</p>
                <p className="text-sm text-muted">{s.name}</p>
              </div>
              <Chip
                cls={
                  s.status === 'ACTIVE'
                    ? 'bg-success-soft text-success'
                    : s.status === 'PAUSED'
                      ? 'bg-warning-surface text-warning'
                      : 'bg-surface-3 text-muted'
                }
              >
                {s.status === 'ACTIVE' ? 'Active' : s.status === 'PAUSED' ? 'Paused' : 'Cancelled'}
              </Chip>
            </div>
            <p className="text-xl font-bold tabular-nums">
              {money2(s.amount, s.currency)}{' '}
              <span className="text-sm font-normal text-muted">
                per {s.interval === 'MONTHLY' ? 'month' : 'year'} + tax
              </span>
            </p>
            <p className="text-sm text-muted">
              {s.status === 'ACTIVE'
                ? `Next invoice ${s.nextInvoiceAt}`
                : 'No invoices while not active'}{' '}
              · {s.invoiceCount} invoices so far
              {s.lastInvoice ? ` · last ${s.lastInvoice.number}` : ''}
            </p>
            {canManage && (
              <div className="mt-auto flex flex-wrap gap-2">
                {s.status !== 'CANCELLED' && (
                  <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                )}
                {s.status === 'ACTIVE' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pause className="size-4" aria-hidden />}
                    onClick={() => update.mutate({ id: s.id, status: 'PAUSED' })}
                  >
                    Pause
                  </Button>
                )}
                {s.status !== 'ACTIVE' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play className="size-4" aria-hidden />}
                    onClick={() => update.mutate({ id: s.id, status: 'ACTIVE' })}
                  >
                    Resume
                  </Button>
                )}
                {s.status !== 'CANCELLED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => update.mutate({ id: s.id, status: 'CANCELLED' })}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
      {editing && (
        <SubscriptionDialog
          customer={editing.customer ?? { id: '', name: editing.name }}
          subscription={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ───────────────────────────── Commission ─────────────────────────────

export function CommissionDialog({
  team,
  onClose,
}: {
  team: PublicUserDto[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const plans = useQuery({
    queryKey: ['crm', 'commission'],
    queryFn: () => api<CommissionPlanDto[]>('/sales/crm/commission-plans'),
  });
  const [scope, setScope] = useState('team');
  const current =
    plans.data?.find((p) => p.scope === scope) ?? plans.data?.find((p) => p.scope === 'team');
  const [form, setForm] = useState<{
    baseRate: number;
    bonusRate: number;
    basis: 'WON' | 'COLLECTED';
  } | null>(null);
  const values =
    form ??
    (current
      ? { baseRate: current.baseRate, bonusRate: current.bonusRate, basis: current.basis }
      : null);
  const save = useMutation({
    mutationFn: () =>
      api<CommissionPlanDto[]>('/sales/crm/commission-plans', {
        method: 'PUT',
        body: { scope, ...values },
      }),
    onSuccess: (data) => {
      client.setQueryData(['crm', 'commission'], data);
      void client.invalidateQueries({ queryKey: ['crm', 'targets'] });
      setForm(null);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api<CommissionPlanDto[]>(`/sales/crm/commission-plans/${scope}`, { method: 'DELETE' }),
    onSuccess: (data) => {
      client.setQueryData(['crm', 'commission'], data);
      void client.invalidateQueries({ queryKey: ['crm', 'targets'] });
      setScope('team');
      setForm(null);
    },
  });
  return (
    <Dialog open onClose={onClose} title="Commission rules">
      <div className="flex flex-col gap-4">
        <p className="text-muted">
          Each person earns the base rate on what they win up to their monthly target, and the bonus
          rate on everything above it. Without a target, the base rate applies to everything.
        </p>
        {(save.isError || remove.isError) && (
          <Alert tone="error">{errorMessage(save.error ?? remove.error)}</Alert>
        )}
        <SelectField
          label="Applies to"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setForm(null);
          }}
        >
          <option value="team">Everyone (team rule)</option>
          {team.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
              {plans.data?.some((x) => x.scope === p.id) ? ' (own rule)' : ''}
            </option>
          ))}
        </SelectField>
        {values && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField
              label="Base %"
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={values.baseRate}
              onChange={(e) => setForm({ ...values, baseRate: Number(e.target.value) || 0 })}
            />
            <TextField
              label="Above target %"
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={values.bonusRate}
              onChange={(e) => setForm({ ...values, bonusRate: Number(e.target.value) || 0 })}
            />
            <SelectField
              label="Paid on"
              value={values.basis}
              onChange={(e) => setForm({ ...values, basis: e.target.value as 'WON' | 'COLLECTED' })}
            >
              <option value="WON">Deals won</option>
              <option value="COLLECTED">Money collected</option>
            </SelectField>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {scope !== 'team' && plans.data?.some((x) => x.scope === scope) && (
            <Button variant="ghost" busy={remove.isPending} onClick={() => remove.mutate()}>
              Use the team rule
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button busy={save.isPending} disabled={!values} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── CRM settings ─────────────────────────────

export function CrmSettingsTab() {
  const client = useQueryClient();
  const settings = useCrmSettings();
  const [draft, setDraft] = useState<UpdateCrmSettingsRequest>({});
  const save = useMutation({
    mutationFn: () => api<CrmSettingsDto>('/sales/crm/settings', { method: 'PUT', body: draft }),
    onSuccess: (data) => {
      client.setQueryData(['crm', 'settings'], data);
      setDraft({});
    },
  });
  const s = settings.data;
  if (settings.isPending) return <Spinner />;
  if (!s) return <Alert tone="error">{errorMessage(settings.error)}</Alert>;
  const v = <K extends keyof UpdateCrmSettingsRequest>(
    k: K,
    fallback: UpdateCrmSettingsRequest[K],
  ) => (draft[k] !== undefined ? draft[k] : fallback) as NonNullable<UpdateCrmSettingsRequest[K]>;
  const set = (patch: UpdateCrmSettingsRequest) => setDraft({ ...draft, ...patch });
  const payTo = { ...s.payTo, ...(draft.payTo ?? {}) };
  const disabled = !s.canManage;
  return (
    <form
      className="flex max-w-3xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {!s.canManage && <Alert tone="info">Only sales managers can change these settings.</Alert>}
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-lg font-bold">Money and tax</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Main currency"
            hint="Targets, commission and totals use it"
            disabled={disabled}
            value={v('defaultCurrency', s.defaultCurrency)}
            onChange={(e) => set({ defaultCurrency: e.target.value as 'USD' | 'PKR' })}
          >
            <option value="USD">US dollars (USD)</option>
            <option value="PKR">Pakistani rupees (PKR)</option>
          </SelectField>
          <TextField
            label="1 USD in PKR"
            type="number"
            min={1}
            step="0.01"
            disabled={disabled}
            value={v('usdToPkr', s.usdToPkr)}
            onChange={(e) => set({ usdToPkr: Number(e.target.value) || s.usdToPkr })}
          />
          <TextField
            label="Tax name"
            hint="e.g. GST or Sales tax"
            disabled={disabled}
            maxLength={30}
            value={v('taxName', s.taxName)}
            onChange={(e) => set({ taxName: e.target.value })}
          />
          <TextField
            label="Default tax %"
            type="number"
            min={0}
            max={100}
            step="0.01"
            disabled={disabled}
            value={v('taxRate', s.taxRate)}
            onChange={(e) => set({ taxRate: Number(e.target.value) || 0 })}
          />
          <TextField
            label="Tax number (NTN / STRN)"
            disabled={disabled}
            maxLength={60}
            value={v('taxNumber', s.taxNumber ?? '')}
            onChange={(e) => set({ taxNumber: e.target.value || null })}
          />
        </div>
      </section>
      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-lg font-bold">On invoices and quotes</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Company name"
            disabled={disabled}
            maxLength={160}
            value={v('companyName', s.companyName)}
            onChange={(e) => set({ companyName: e.target.value })}
          />
          <TextField
            label="Email"
            disabled={disabled}
            maxLength={254}
            value={v('companyEmail', s.companyEmail ?? '')}
            onChange={(e) => set({ companyEmail: e.target.value || null })}
          />
          <TextField
            label="Phone"
            disabled={disabled}
            maxLength={40}
            value={v('companyPhone', s.companyPhone ?? '')}
            onChange={(e) => set({ companyPhone: e.target.value || null })}
          />
          <TextArea
            label="Address"
            rows={2}
            disabled={disabled}
            maxLength={500}
            value={v('companyAddress', s.companyAddress ?? '')}
            onChange={(e) => set({ companyAddress: e.target.value || null })}
          />
        </div>
      </section>
      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-1 text-lg font-bold">How customers pay you</h2>
        <p className="mb-3 text-sm text-muted">
          Shown on the pay page and invoices. Customers then tell you the transaction ID.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="JazzCash account"
            hint="Number and account name"
            disabled={disabled}
            maxLength={120}
            value={payTo.jazzcash ?? ''}
            onChange={(e) => set({ payTo: { ...payTo, jazzcash: e.target.value || null } })}
          />
          <TextField
            label="Easypaisa account"
            hint="Number and account name"
            disabled={disabled}
            maxLength={120}
            value={payTo.easypaisa ?? ''}
            onChange={(e) => set({ payTo: { ...payTo, easypaisa: e.target.value || null } })}
          />
          <TextArea
            label="Bank account"
            hint="Bank, title, account number / IBAN"
            rows={3}
            disabled={disabled}
            maxLength={500}
            value={payTo.bank ?? ''}
            onChange={(e) => set({ payTo: { ...payTo, bank: e.target.value || null } })}
          />
          <TextArea
            label="Other payment notes"
            rows={3}
            disabled={disabled}
            maxLength={1000}
            value={v('paymentDetails', s.paymentDetails ?? '')}
            onChange={(e) => set({ paymentDetails: e.target.value || null })}
          />
        </div>
      </section>
      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="mb-1 text-lg font-bold">Payment window and reminders</h2>
        <p className="mb-3 text-sm text-muted">
          Reminders are sent automatically to customers who have not paid.
        </p>
        <TextField
          label="Monthly payments are due by day"
          hint="e.g. 10: monthly invoices are paid from the 1st to the 10th. Leave empty to use each subscription’s own number of days."
          type="number"
          min={1}
          max={28}
          disabled={disabled}
          value={String(
            (draft.paymentDueDay !== undefined ? draft.paymentDueDay : s.paymentDueDay) ?? '',
          )}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            set({ paymentDueDay: Number.isInteger(n) ? Math.min(28, Math.max(1, n)) : null });
          }}
        />
        <TextField
          label="Send reminders this many days after the due date"
          hint="Separate with commas. 0 = on the due date itself, e.g. 0, 3, 7, 14"
          disabled={disabled}
          value={(draft.reminderDays ?? s.reminderDays).join(', ')}
          onChange={(e) =>
            set({
              reminderDays: e.target.value
                .split(',')
                .map((x) => parseInt(x.trim(), 10))
                .filter((x) => Number.isInteger(x) && x >= 0)
                .slice(0, 6),
            })
          }
        />
        <fieldset className="mt-3 flex flex-wrap gap-4">
          <legend className="mb-1 font-semibold">Send by</legend>
          {(['EMAIL', 'WHATSAPP', 'SMS'] as const).map((c) => {
            const list = draft.reminderChannels ?? s.reminderChannels;
            return (
              <label key={c} className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--color-brand)]"
                  disabled={disabled}
                  checked={list.includes(c)}
                  onChange={(e) =>
                    set({
                      reminderChannels: e.target.checked
                        ? [...list, c]
                        : list.filter((x) => x !== c),
                    })
                  }
                />
                {c === 'EMAIL' ? 'Email' : c === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}
                {!s.channels[c] && <span className="text-xs text-muted">(not set up)</span>}
              </label>
            );
          })}
        </fieldset>
      </section>
      {s.canManage && (
        <div className="flex justify-end">
          <Button type="submit" busy={save.isPending} disabled={Object.keys(draft).length === 0}>
            Save settings
          </Button>
        </div>
      )}
    </form>
  );
}

// ───────────────────────────── Lead import ─────────────────────────────

const FIELD_LABEL: Record<LeadImportField, string> = {
  companyName: 'Company',
  contactName: 'Contact',
  contactTitle: 'Title',
  email: 'Email',
  phone: 'Phone',
  website: 'Website',
  industry: 'Industry',
  city: 'City',
  country: 'Country',
  storeCount: 'Stores',
  estimatedValue: 'Value',
  notes: 'Notes',
};

export function LeadImportDialog({
  team,
  canAssign,
  onClose,
}: {
  team: SalesUserDto[];
  canAssign: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState<LeadSource>('COLD_CALL');
  const [ownerId, setOwnerId] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [result, setResult] = useState<LeadImportResultDto | null>(null);
  const preview = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 4 * 1024 * 1024) throw new Error('The file is too big (4 MB at most).');
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return api<LeadImportPreviewDto>('/sales/crm/leads/import/preview', {
        method: 'POST',
        body: { fileName: file.name, contentBase64: btoa(bin) },
      });
    },
  });
  const p = preview.data;
  const importable = (p?.rows ?? []).filter(
    (r) => r.errors.length === 0 && (!skipDuplicates || !r.duplicate),
  );
  const run = useMutation({
    mutationFn: () =>
      api<LeadImportResultDto>('/sales/crm/leads/import', {
        method: 'POST',
        body: {
          source,
          ...(canAssign && ownerId ? { ownerId: ownerId === 'none' ? null : ownerId } : {}),
          skipDuplicates,
          rows: importable.map((r) => {
            const v = r.values;
            return Object.fromEntries(
              Object.entries({
                ...v,
                storeCount: v.storeCount ? Number(v.storeCount) : undefined,
                estimatedValue: v.estimatedValue ? Number(v.estimatedValue) : undefined,
              }).filter(([, x]) => x !== undefined && x !== ''),
            );
          }),
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      void client.invalidateQueries({ queryKey: ['leads'] });
      void client.invalidateQueries({ queryKey: ['sales-overview'] });
    },
  });
  const mapped = LEAD_IMPORT_FIELDS.filter((f) => p?.mapping[f]);
  return (
    <Dialog open onClose={onClose} title="Import leads from Excel" wide>
      <div className="flex flex-col gap-4">
        {result ? (
          <Alert tone="success" title="Import finished">
            {result.created} leads added
            {result.skipped ? `, ${result.skipped} duplicates skipped` : ''}.
            <div className="mt-2">
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </Alert>
        ) : (
          <>
            <p className="text-muted">
              Use an Excel (.xlsx) or CSV file with a heading row. Start from the sample file to get
              the right columns; your own headings (e.g. Company, Contact, Phone) are matched too.
              Leads that already exist are flagged.
            </p>
            <SampleFileButton kind="leads" />
            <input
              ref={input}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFileName(f.name);
                  preview.mutate(f);
                }
                e.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              icon={<Upload className="size-5" aria-hidden />}
              busy={preview.isPending}
              onClick={() => input.current?.click()}
            >
              {fileName ? `Choose another file (${fileName})` : 'Choose a file'}
            </Button>
            {preview.isError && <Alert tone="error">{errorMessage(preview.error)}</Alert>}
            {p && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <SelectField
                    label="Where they came from"
                    value={source}
                    onChange={(e) => setSource(e.target.value as LeadSource)}
                  >
                    {LEAD_SOURCES.map((x) => (
                      <option key={x} value={x}>
                        {SOURCE_LABEL[x]}
                      </option>
                    ))}
                  </SelectField>
                  {canAssign && (
                    <SelectField
                      label="Give them to"
                      value={ownerId}
                      onChange={(e) => setOwnerId(e.target.value)}
                    >
                      <option value="">Me</option>
                      <option value="none">Unassigned queue</option>
                      {team.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </SelectField>
                  )}
                  <label className="flex min-h-12 items-center gap-2 self-end">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--color-brand)]"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                    />
                    Skip duplicates
                  </label>
                </div>
                <p className="text-sm text-muted">
                  Matched columns:{' '}
                  {mapped.map((f) => `${FIELD_LABEL[f]} ← “${p.mapping[f]}”`).join(' · ') || 'none'}
                  {p.truncated ? ' · only the first 2,000 rows are shown' : ''}
                </p>
                <div className="max-h-80 overflow-auto rounded-2xl border border-line">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="sticky top-0 bg-surface-2">
                      <tr className="text-left">
                        <th className="px-2 py-2 font-semibold">Row</th>
                        {mapped.slice(0, 5).map((f) => (
                          <th key={f} className="px-2 py-2 font-semibold">
                            {FIELD_LABEL[f]}
                          </th>
                        ))}
                        <th className="px-2 py-2 font-semibold">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rows.map((r) => (
                        <tr
                          key={r.row}
                          className={cx(
                            'border-t border-line',
                            (r.errors.length > 0 || r.duplicate) && 'bg-warning-surface/50',
                          )}
                        >
                          <td className="px-2 py-1.5 text-muted">{r.row}</td>
                          {mapped.slice(0, 5).map((f) => (
                            <td key={f} className="max-w-40 truncate px-2 py-1.5">
                              {r.values[f] ?? ''}
                            </td>
                          ))}
                          <td className="px-2 py-1.5">
                            {r.errors.length > 0 ? (
                              <span className="text-danger">{r.errors.join('; ')}</span>
                            ) : r.duplicate ? (
                              <span className="text-warning">
                                Duplicate: {r.duplicate.reason}
                                {r.duplicate.companyName ? ` (${r.duplicate.companyName})` : ''}
                              </span>
                            ) : (
                              <span className="text-success">OK</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {run.isError && <Alert tone="error">{errorMessage(run.error)}</Alert>}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    icon={<FileSpreadsheet className="size-5" aria-hidden />}
                    busy={run.isPending}
                    disabled={importable.length === 0}
                    onClick={() => run.mutate()}
                  >
                    Import {importable.length} leads
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
