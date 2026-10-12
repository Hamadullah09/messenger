'use client';

import type { InvoiceDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PAYMENT_METHOD_LABEL, money2 } from '@/components/sales/crm';
import { Alert, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';

interface InvoiceSettings {
  companyName: string;
  companyAddress: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  paymentDetails: string | null;
}

/**
 * Printable invoice (A4). "Print / Save as PDF" uses the browser's print dialog, so no PDF
 * library is needed. Always printed on white, whatever the app theme.
 */
export default function PrintInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (status === 'signed-out') router.replace('/login');
  }, [status, router]);
  const invoice = useQuery({
    queryKey: ['crm', 'invoice', id],
    queryFn: () => api<InvoiceDto>(`/sales/crm/invoices/${id}`),
    enabled: status === 'signed-in',
  });
  const settings = useQuery({
    queryKey: ['crm', 'print-settings'],
    queryFn: () => api<InvoiceSettings>('/sales/crm/settings'),
    enabled: status === 'signed-in',
  });
  useEffect(() => {
    if (invoice.data) document.title = `Invoice ${invoice.data.number}`;
  }, [invoice.data]);

  if (status !== 'signed-in' || invoice.isPending || settings.isPending)
    return <Spinner label="Preparing invoice" />;
  if (invoice.isError || settings.isError)
    return (
      <div className="p-6">
        <Alert tone="error">{errorMessage(invoice.error ?? settings.error)}</Alert>
      </div>
    );
  const i = invoice.data;
  const s = settings.data;
  const paid = i.payments.filter((p) => !p.voided);
  const stamp =
    i.status === 'PAID'
      ? 'PAID'
      : i.status === 'VOID'
        ? 'VOID'
        : i.status === 'DRAFT'
          ? 'DRAFT'
          : i.overdue
            ? 'OVERDUE'
            : null;

  return (
    <div className="min-h-dvh bg-neutral-200 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end gap-2 px-4 print:hidden">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#ea580c] px-4 font-semibold text-white"
        >
          <Printer className="size-5" aria-hidden /> Print / Save as PDF
        </button>
      </div>
      <main
        id="main"
        className="relative mx-auto min-h-[297mm] max-w-[210mm] bg-white p-[14mm] text-[13px] leading-relaxed text-neutral-900 shadow-xl print:min-h-0 print:shadow-none"
      >
        {stamp && (
          <span
            className={`absolute top-[60mm] right-[14mm] rotate-[-12deg] rounded-lg border-4 px-4 py-1 text-3xl font-black tracking-widest opacity-70 ${
              stamp === 'PAID'
                ? 'border-green-700 text-green-700'
                : stamp === 'OVERDUE'
                  ? 'border-red-700 text-red-700'
                  : 'border-neutral-500 text-neutral-500'
            }`}
          >
            {stamp}
          </span>
        )}
        <header className="flex items-start justify-between gap-6 border-b-4 border-[#ea580c] pb-6">
          <div>
            <img src="/brand/sma-logo.webp" alt="" className="mb-2 h-12 w-auto" />
            <p className="text-lg font-bold">{s.companyName}</p>
            {s.companyAddress && <p className="whitespace-pre-line text-neutral-600">{s.companyAddress}</p>}
            <p className="text-neutral-600">
              {[s.companyEmail, s.companyPhone].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="text-right">
            <h1 className="text-3xl font-black tracking-tight text-[#ea580c]">INVOICE</h1>
            <p className="mt-1 text-base font-bold">{i.number}</p>
            <table className="mt-2 ml-auto text-left">
              <tbody>
                <tr>
                  <td className="pr-3 text-neutral-500">Issued</td>
                  <td className="font-semibold">{i.issueDate}</td>
                </tr>
                <tr>
                  <td className="pr-3 text-neutral-500">Due</td>
                  <td className="font-semibold">{i.dueDate}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </header>

        <section className="mt-6">
          <p className="text-xs font-bold tracking-wider text-neutral-500 uppercase">Bill to</p>
          <p className="text-base font-bold">{i.billToName}</p>
          {i.billToAddress && <p className="text-neutral-700">{i.billToAddress}</p>}
          <p className="text-neutral-700">
            {[i.billToEmail, i.billToPhone].filter(Boolean).join(' · ')}
          </p>
        </section>

        <table className="mt-6 w-full border-collapse">
          <thead>
            <tr className="bg-[#fff7ed] text-left">
              <th className="px-3 py-2 font-bold">Description</th>
              <th className="px-3 py-2 text-right font-bold">Qty</th>
              <th className="px-3 py-2 text-right font-bold">Unit price</th>
              <th className="px-3 py-2 text-right font-bold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {i.items.map((it) => (
              <tr key={it.id} className="border-b border-neutral-200">
                <td className="px-3 py-2.5">
                  <span className="font-semibold">{it.name}</span>
                  {it.description && <span className="block text-xs text-neutral-500">{it.description}</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{it.quantity}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{money2(it.unitPrice, i.currency)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{money2(it.total, i.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 ml-auto w-72">
          <Row label="Subtotal" value={money2(i.subtotal, i.currency)} />
          {i.discount > 0 && <Row label="Discount" value={`−${money2(i.discount, i.currency)}`} />}
          {i.taxAmount > 0 && <Row label={`Tax (${i.taxRate}%)`} value={money2(i.taxAmount, i.currency)} />}
          <div className="my-1 border-t-2 border-neutral-900" />
          <Row label="Total" value={money2(i.total, i.currency)} strong />
          {i.amountPaid > 0 && <Row label="Paid" value={`−${money2(i.amountPaid, i.currency)}`} />}
          <div className="mt-1 rounded-lg bg-[#ea580c] px-3 py-2 text-white">
            <Row label="Balance due" value={money2(i.balance, i.currency)} strong />
          </div>
        </div>

        {paid.length > 0 && (
          <section className="mt-6">
            <p className="text-xs font-bold tracking-wider text-neutral-500 uppercase">Payments received</p>
            <ul className="mt-1">
              {paid.map((p) => (
                <li key={p.id} className="text-neutral-700">
                  {new Date(p.paidAt).toLocaleDateString()} · {PAYMENT_METHOD_LABEL[p.method]}
                  {p.reference ? ` (${p.reference})` : ''} · {money2(p.amount, i.currency)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {s.paymentDetails && i.balance > 0 && (
          <section className="mt-6 rounded-lg bg-neutral-100 p-4">
            <p className="font-bold">How to pay</p>
            <p className="whitespace-pre-line text-neutral-700">{s.paymentDetails}</p>
          </section>
        )}
        {i.notes && <p className="mt-6 whitespace-pre-line text-neutral-700">{i.notes}</p>}
        <footer className="mt-10 border-t border-neutral-200 pt-3 text-center text-xs text-neutral-500">
          Thank you for your business · {s.companyName}
        </footer>
      </main>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 ${strong ? 'text-base font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
