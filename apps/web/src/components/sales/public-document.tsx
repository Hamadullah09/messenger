'use client';

import type { ReactNode } from 'react';
import { money2 } from './crm';

/** Shared layout of the customer's quote and pay pages (no sign-in). */
export function PublicDocument({
  kind,
  number,
  company,
  billToName,
  dates,
  currency,
  items,
  totals,
  badge,
  children,
}: {
  kind: string;
  number: string;
  company: {
    name: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    taxNumber: string | null;
    taxName: string;
  };
  billToName: string;
  dates: Array<[string, string]>;
  currency: string;
  items: Array<{
    name: string;
    description: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  totals: Array<{ label: string; value: number; strong?: boolean; negative?: boolean }>;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main id="main" className="min-h-dvh bg-bg px-3 py-6 text-fg sm:px-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <header className="flex items-start justify-between gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
          <div className="min-w-0">
            <img src="/brand/sma-logo.webp" alt="" className="mb-2 h-10 w-auto" />
            <p className="font-bold">{company.name}</p>
            <p className="text-sm text-muted">
              {[company.address, company.email, company.phone].filter(Boolean).join(' · ')}
            </p>
            {company.taxNumber && (
              <p className="text-sm text-muted">
                {company.taxName} no. {company.taxNumber}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-2xl font-black tracking-tight text-brand uppercase">{kind}</p>
            <p className="font-bold">{number}</p>
            {badge}
          </div>
        </header>
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <p className="text-xs font-bold tracking-wider text-muted uppercase">For</p>
              <p className="text-lg font-bold">{billToName}</p>
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-3 text-sm">
              {dates.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <ul className="mt-4 flex flex-col divide-y divide-line">
            {items.map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block font-semibold">{it.name}</span>
                  <span className="block text-sm text-muted">
                    {it.quantity} × {money2(it.unitPrice, currency)}
                    {it.description ? ` · ${it.description}` : ''}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {money2(it.total, currency)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            {totals.map((t) => (
              <div key={t.label} className="contents">
                <dt className={t.strong ? 'text-base font-bold' : 'text-muted'}>{t.label}</dt>
                <dd className={`text-right tabular-nums ${t.strong ? 'text-base font-bold' : ''}`}>
                  {t.negative ? '−' : ''}
                  {money2(t.value, currency)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {children}
        <p className="text-center text-xs text-muted">
          {company.name} · powered by SMA ·{' '}
          <a href="/privacy" className="underline">
            Privacy
          </a>
        </p>
      </div>
    </main>
  );
}
