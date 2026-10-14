'use client';

import type {
  CheckoutDto,
  GatewayMethod,
  PaymentGateway,
  PublicInvoiceDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Copy, CreditCard, Printer, Smartphone } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { money2 } from '@/components/sales/crm';
import { PublicDocument } from '@/components/sales/public-document';
import { Alert, Button, SelectField, Spinner, TextArea, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

const METHODS = [
  { value: 'ONLINE', label: 'JazzCash / Easypaisa' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CARD', label: 'Card' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OTHER', label: 'Other' },
] as const;

function PayOption({
  icon,
  title,
  details,
}: {
  icon: React.ReactNode;
  title: string;
  details: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-surface-2 p-3">
      <span className="mt-0.5 text-brand">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm whitespace-pre-line">{details}</p>
      </div>
      <button
        type="button"
        aria-label={`Copy ${title} details`}
        onClick={() => void copyText(details).then(() => setCopied(true))}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-brand hover:bg-surface-3"
      >
        <Copy className="size-4" aria-hidden /> {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Sends the browser to the gateway's own payment page (a normal form post; no secrets in it). */
function submitToGateway({ action, fields }: CheckoutDto) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

const GATEWAY_LABEL: Record<PaymentGateway, string> = {
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
};

/** Pay now with JazzCash or Easypaisa (wallet or card), when the business has turned it on. */
function PayOnline({ token, invoice }: { token: string; invoice: PublicInvoiceDto }) {
  const [mobile, setMobile] = useState('');
  const [choice, setChoice] = useState<{ gateway: PaymentGateway; method: GatewayMethod } | null>(
    null,
  );
  const go = useMutation({
    mutationFn: (body: { gateway: PaymentGateway; method: GatewayMethod; mobile?: string }) =>
      api<CheckoutDto>(`/public/invoices/${token}/checkout`, { method: 'POST', body }),
    onSuccess: submitToGateway,
  });
  if (invoice.gateways.length === 0 || invoice.currency !== 'PKR') return null;
  const needsMobile = choice?.gateway === 'EASYPAISA' && choice.method === 'WALLET';
  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-card">
      <p className="text-lg font-bold">Pay now · {money2(invoice.balance, invoice.currency)}</p>
      {go.isError && <Alert tone="error">{errorMessage(go.error)}</Alert>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {invoice.gateways.flatMap((g) =>
          g.methods.map((m) => (
            <Button
              key={`${g.gateway}-${m}`}
              variant={
                choice?.gateway === g.gateway && choice.method === m ? 'primary' : 'secondary'
              }
              icon={
                m === 'CARD' ? (
                  <CreditCard className="size-5" aria-hidden />
                ) : (
                  <Smartphone className="size-5" aria-hidden />
                )
              }
              busy={go.isPending && choice?.gateway === g.gateway && choice.method === m}
              onClick={() => {
                setChoice({ gateway: g.gateway, method: m });
                if (!(g.gateway === 'EASYPAISA' && m === 'WALLET'))
                  go.mutate({ gateway: g.gateway, method: m });
              }}
            >
              {m === 'CARD'
                ? `Card (${GATEWAY_LABEL[g.gateway]})`
                : `${GATEWAY_LABEL[g.gateway]} wallet`}
              {g.sandbox ? ' · test' : ''}
            </Button>
          )),
        )}
      </div>
      {needsMobile && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go.mutate({ gateway: 'EASYPAISA', method: 'WALLET', mobile: mobile.trim() });
          }}
        >
          <TextField
            label="Your Easypaisa number"
            inputMode="numeric"
            placeholder="03XXXXXXXXX"
            maxLength={11}
            value={mobile}
            onChange={(e) => setMobile(e.target.value.replace(/D/g, ''))}
          />
          <Button type="submit" busy={go.isPending} disabled={!/^03d{9}$/.test(mobile)}>
            Continue
          </Button>
        </form>
      )}
      <p className="text-sm text-muted">
        You pay on {invoice.gateways.map((g) => GATEWAY_LABEL[g.gateway]).join(' or ')}'s own secure
        page, then come back here.
      </p>
    </section>
  );
}

/** The customer's pay page: the invoice, where to pay, and "I have paid" (no sign-in). */
export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const result = useSearchParams().get('payment');
  const client = useQueryClient();
  const invoice = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => api<PublicInvoiceDto>(`/public/invoices/${token}`),
    retry: false,
  });
  const [form, setForm] = useState({
    amount: '',
    method: 'ONLINE',
    reference: '',
    payerName: '',
    note: '',
    website: '',
  });
  const [done, setDone] = useState(false);
  const claim = useMutation({
    mutationFn: () =>
      api<PublicInvoiceDto>(`/public/invoices/${token}/claims`, {
        method: 'POST',
        body: {
          amount: Number(form.amount),
          method: form.method,
          reference: form.reference.trim(),
          ...(form.payerName.trim() ? { payerName: form.payerName.trim() } : {}),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
          website: form.website,
        },
      }),
    onSuccess: (data) => {
      client.setQueryData(['public-invoice', token], data);
      setDone(true);
    },
  });
  if (invoice.isPending) return <Spinner label="Opening the invoice" />;
  if (invoice.isError)
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="error" title="This invoice is not available">
          {errorMessage(invoice.error)}
        </Alert>
      </div>
    );
  const i = invoice.data;
  const paid = i.status === 'PAID';
  const options = [
    i.payTo.jazzcash && {
      icon: <Smartphone className="size-5" aria-hidden />,
      title: 'JazzCash',
      details: i.payTo.jazzcash,
    },
    i.payTo.easypaisa && {
      icon: <Smartphone className="size-5" aria-hidden />,
      title: 'Easypaisa',
      details: i.payTo.easypaisa,
    },
    i.payTo.bank && {
      icon: <Building2 className="size-5" aria-hidden />,
      title: 'Bank transfer',
      details: i.payTo.bank,
    },
  ].filter(Boolean) as Array<{ icon: React.ReactNode; title: string; details: string }>;
  return (
    <PublicDocument
      kind="Invoice"
      number={i.number}
      company={i.company}
      billToName={i.billToName}
      dates={[
        ['Issued', i.issueDate],
        ['Due', i.dueDate],
      ]}
      currency={i.currency}
      items={i.items}
      badge={
        <span
          className={`mt-1 inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold ${paid ? 'bg-success-soft text-success' : 'bg-warning-surface text-warning'}`}
        >
          {paid ? 'Paid' : i.amountPaid > 0 ? 'Part paid' : 'Unpaid'}
        </span>
      }
      totals={[
        { label: 'Subtotal', value: i.subtotal },
        ...(i.discount ? [{ label: 'Discount', value: i.discount, negative: true }] : []),
        ...(i.taxAmount
          ? [{ label: `${i.company.taxName} (${i.taxRate}%)`, value: i.taxAmount }]
          : []),
        { label: 'Total', value: i.total, strong: true },
        ...(i.amountPaid ? [{ label: 'Paid', value: i.amountPaid, negative: true }] : []),
        { label: 'Balance due', value: i.balance, strong: true },
      ]}
    >
      {result === 'failed' && !paid && (
        <Alert tone="error" title="The payment did not go through">
          You were not charged. Try again, or use another way to pay.
        </Alert>
      )}
      {result === 'pending' && !paid && (
        <Alert tone="info" title="We are checking your payment">
          {i.company.name} will confirm it shortly. You do not need to pay again.
        </Alert>
      )}
      {paid ? (
        <Alert tone="success" title="Paid in full — thank you!" />
      ) : (
        <>
          <PayOnline token={token} invoice={i} />
          <section className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-card">
            <p className="text-lg font-bold">How to pay {money2(i.balance, i.currency)}</p>
            {options.length === 0 && !i.paymentDetails && (
              <p className="text-muted">Please contact {i.company.name} for payment details.</p>
            )}
            {options.map((o) => (
              <PayOption key={o.title} {...o} />
            ))}
            {i.paymentDetails && (
              <p className="text-sm whitespace-pre-line text-muted">{i.paymentDetails}</p>
            )}
            <p className="text-sm text-muted">Use {i.number} as the payment reference.</p>
          </section>
          <section className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-card">
            <p className="text-lg font-bold">Already paid?</p>
            {done || i.pendingClaims > 0 ? (
              <Alert tone="success" title="We received your payment details">
                {i.company.name} will check and confirm it. This page updates once it is confirmed.
              </Alert>
            ) : null}
            {!done && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  claim.mutate();
                }}
              >
                {claim.isError && <Alert tone="error">{errorMessage(claim.error)}</Alert>}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField
                    label={`Amount paid (${i.currency})`}
                    type="number"
                    min={0.01}
                    step="0.01"
                    required
                    placeholder={String(i.balance)}
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                  <SelectField
                    label="Paid by"
                    value={form.method}
                    onChange={(e) => setForm({ ...form, method: e.target.value })}
                  >
                    {METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <TextField
                  label="Transaction ID / reference"
                  required
                  maxLength={120}
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                />
                <TextField
                  label="Your name (optional)"
                  maxLength={120}
                  value={form.payerName}
                  onChange={(e) => setForm({ ...form, payerName: e.target.value })}
                />
                <TextArea
                  label="Note (optional)"
                  rows={2}
                  maxLength={500}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
                <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
                  <input
                    tabIndex={-1}
                    autoComplete="off"
                    value={form.website}
                    onChange={(e) => setForm({ ...form, website: e.target.value })}
                  />
                </div>
                <Button
                  type="submit"
                  icon={<CheckCircle2 className="size-5" aria-hidden />}
                  busy={claim.isPending}
                  disabled={
                    !form.amount || Number(form.amount) <= 0 || form.reference.trim().length < 3
                  }
                >
                  I have paid
                </Button>
              </form>
            )}
          </section>
        </>
      )}
      <button
        type="button"
        onClick={() => window.print()}
        className="mx-auto inline-flex items-center gap-2 text-sm font-semibold text-brand print:hidden"
      >
        <Printer className="size-4" aria-hidden /> Print or save as PDF
      </button>
    </PublicDocument>
  );
}
