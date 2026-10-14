import Link from 'next/link';
import type { ReactNode } from 'react';

/** Company details for the legal pages (set NEXT_PUBLIC_LEGAL_NAME / NEXT_PUBLIC_LEGAL_EMAIL). */
export const LEGAL = {
  name: process.env.NEXT_PUBLIC_LEGAL_NAME ?? 'SMA Technology',
  email: process.env.NEXT_PUBLIC_LEGAL_EMAIL ?? '',
  updated: '14 October 2026',
};

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main id="main" className="min-h-dvh bg-bg px-4 py-8 text-fg">
      <article className="mx-auto flex max-w-3xl flex-col gap-4 rounded-3xl border border-line bg-surface p-6 leading-relaxed shadow-card sm:p-10 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc">
        <p className="text-sm text-muted">
          <Link href="/" className="font-semibold text-brand">
            ← {LEGAL.name}
          </Link>
        </p>
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="text-sm text-muted">Last updated {LEGAL.updated}</p>
        {children}
        <p className="mt-6 text-sm text-muted">
          See also the{' '}
          <Link href="/privacy" className="text-brand underline">
            Privacy policy
          </Link>{' '}
          and the{' '}
          <Link href="/terms" className="text-brand underline">
            Terms of service
          </Link>
          .
        </p>
      </article>
    </main>
  );
}

export function ContactLine() {
  return LEGAL.email ? (
    <p>
      Questions or requests:{' '}
      <a href={`mailto:${LEGAL.email}`} className="text-brand underline">
        {LEGAL.email}
      </a>
      .
    </p>
  ) : (
    <p>Questions or requests: contact {LEGAL.name} through your account administrator.</p>
  );
}
