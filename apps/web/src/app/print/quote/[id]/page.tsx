'use client';

import type { CrmSettingsDto, QuoteDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PublicDocument } from '@/components/sales/public-document';
import { Alert, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';

/** Printable quotation for the sales team (print or save as PDF from the browser). */
export default function PrintQuotePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (status === 'signed-out') router.replace('/login');
  }, [status, router]);
  const quote = useQuery({
    queryKey: ['crm', 'quote', id],
    queryFn: () => api<QuoteDto>(`/sales/crm/quotes/${id}`),
    enabled: status === 'signed-in',
  });
  const settings = useQuery({
    queryKey: ['crm', 'settings'],
    queryFn: () => api<CrmSettingsDto>('/sales/crm/settings'),
    enabled: status === 'signed-in',
  });
  useEffect(() => {
    if (quote.data) document.title = `Quotation ${quote.data.number}`;
  }, [quote.data]);
  if (status !== 'signed-in' || quote.isPending || settings.isPending) return <Spinner label="Preparing quote" />;
  if (quote.isError || settings.isError)
    return (
      <div className="p-6">
        <Alert tone="error">{errorMessage(quote.error ?? settings.error)}</Alert>
      </div>
    );
  const q = quote.data;
  const s = settings.data;
  return (
    <PublicDocument
      kind="Quotation"
      number={q.number}
      company={{ name: s.companyName, address: s.companyAddress, email: s.companyEmail, phone: s.companyPhone, taxNumber: s.taxNumber, taxName: s.taxName }}
      billToName={q.billToName}
      dates={[
        ['Date', q.issueDate],
        ['Valid until', q.validUntil],
      ]}
      currency={q.currency}
      items={q.items}
      totals={[
        { label: 'Subtotal', value: q.subtotal },
        ...(q.discount ? [{ label: 'Discount', value: q.discount, negative: true }] : []),
        ...(q.taxAmount ? [{ label: `${s.taxName} (${q.taxRate}%)`, value: q.taxAmount }] : []),
        { label: 'Total', value: q.total, strong: true },
      ]}
    >
      {q.notes && <p className="whitespace-pre-line">{q.notes}</p>}
      {q.terms && <p className="text-sm whitespace-pre-line text-muted">{q.terms}</p>}
      <button type="button" onClick={() => window.print()} className="mx-auto rounded-xl bg-brand px-4 py-2 font-semibold text-brand-contrast print:hidden">
        Print / Save as PDF
      </button>
    </PublicDocument>
  );
}
