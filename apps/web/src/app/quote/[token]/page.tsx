'use client';

import type { PublicQuoteDto } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Printer, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PublicDocument } from '@/components/sales/public-document';
import { Alert, Button, Spinner, TextArea, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** The customer's quotation: read it, then accept or decline (no sign-in). */
export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const client = useQueryClient();
  const quote = useQuery({
    queryKey: ['public-quote', token],
    queryFn: () => api<PublicQuoteDto>(`/public/quotes/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const respond = useMutation({
    mutationFn: (accept: boolean) =>
      api<PublicQuoteDto>(`/public/quotes/${token}/respond`, {
        method: 'POST',
        body: { accept, name: name.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: (q) => client.setQueryData(['public-quote', token], q),
  });
  if (quote.isPending) return <Spinner label="Opening the quote" />;
  if (quote.isError)
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="error" title="This quote is not available">
          {errorMessage(quote.error)}
        </Alert>
      </div>
    );
  const q = quote.data;
  const open = q.status === 'SENT';
  return (
    <PublicDocument
      kind="Quotation"
      number={q.number}
      company={q.company}
      billToName={q.billToName}
      dates={[
        ['Date', q.issueDate],
        ['Valid until', q.validUntil],
      ]}
      currency={q.currency}
      items={q.items.map((i) => ({
        ...i,
        description:
          [
            i.billing === 'MONTHLY' ? 'per month' : i.billing === 'YEARLY' ? 'per year' : null,
            i.description,
          ]
            .filter(Boolean)
            .join(' · ') || null,
      }))}
      totals={[
        { label: 'Subtotal', value: q.subtotal },
        ...(q.discount ? [{ label: 'Discount', value: q.discount, negative: true }] : []),
        ...(q.taxAmount
          ? [{ label: `${q.company.taxName} (${q.taxRate}%)`, value: q.taxAmount }]
          : []),
        { label: 'Total', value: q.total, strong: true },
      ]}
    >
      {q.notes && (
        <p className="rounded-3xl border border-line bg-surface p-5 whitespace-pre-line shadow-card">
          {q.notes}
        </p>
      )}
      {q.terms && (
        <section className="rounded-3xl border border-line bg-surface p-5 text-sm shadow-card">
          <p className="mb-1 font-bold">Terms</p>
          <p className="whitespace-pre-line text-muted">{q.terms}</p>
        </section>
      )}
      {q.status === 'ACCEPTED' && (
        <Alert tone="success" title="Thank you — the quote is accepted">
          {q.payUrl ? (
            <a href={q.payUrl} className="font-bold text-brand underline">
              View the invoice and pay
            </a>
          ) : (
            'We will be in touch.'
          )}
        </Alert>
      )}
      {q.status === 'DECLINED' && (
        <Alert tone="info">You declined this quote. Thank you for letting us know.</Alert>
      )}
      {q.status === 'EXPIRED' && (
        <Alert tone="warning" title="This quote has expired">
          Please contact {q.company.name} for an updated quote.
        </Alert>
      )}
      {open && (
        <section className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-card">
          <p className="font-bold">Your answer</p>
          {respond.isError && <Alert tone="error">{errorMessage(respond.error)}</Alert>}
          <TextField
            label="Your name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextArea
            label="Message (optional)"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<CheckCircle2 className="size-5" aria-hidden />}
              busy={respond.isPending && respond.variables === true}
              disabled={!name.trim()}
              onClick={() => respond.mutate(true)}
            >
              Accept quote
            </Button>
            <Button
              variant="secondary"
              icon={<XCircle className="size-5" aria-hidden />}
              busy={respond.isPending && respond.variables === false}
              disabled={!name.trim()}
              onClick={() => respond.mutate(false)}
            >
              Decline
            </Button>
          </div>
          <p className="text-xs text-muted">Accepting creates the invoice for this quote.</p>
        </section>
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
