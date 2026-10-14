'use client';

import { useEffect, useState } from 'react';
import { DemoRequestForm } from '@/components/sales/demo-request-form';

/**
 * The "Request a demo" form for embedding on the company website (iframe). Leads land in
 * Sales & Marketing as WEBSITE leads, tagged with the page they came from.
 *
 *   <iframe src="https://<sma address>/embed/lead-form" style="width:100%;height:760px;border:0"></iframe>
 */
export default function EmbeddedLeadForm() {
  const [page, setPage] = useState<string | undefined>(undefined);
  // ?business=<short name>: a business's own form (its leads land in its own Sales & Marketing).
  const [business, setBusiness] = useState<string | undefined>(undefined);
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('business')?.trim();
    if (slug) setBusiness(slug.slice(0, 64));
    // The website page that embeds the form (sent by the browser as the referrer).
    if (document.referrer) {
      try {
        const url = new URL(document.referrer);
        setPage(`Website form · ${url.host}${url.pathname}`);
      } catch {
        setPage('Website form');
      }
    } else {
      setPage('Website form');
    }
  }, []);
  return (
    <main id="main" className="min-h-dvh bg-surface p-4 text-fg sm:p-6">
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold">{business ? 'Contact us' : 'Request a demo'}</h1>
        <p className="mt-1 mb-5 text-muted">
          {business
            ? 'Leave your details and our team will contact you.'
            : 'Tell us about your business and our team will contact you.'}
        </p>
        <DemoRequestForm sourceDetail={page} business={business} />
      </div>
    </main>
  );
}
