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
  useEffect(() => {
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
        <h1 className="text-2xl font-bold">Request a demo</h1>
        <p className="mt-1 mb-5 text-muted">
          Tell us about your business and our team will contact you.
        </p>
        <DemoRequestForm sourceDetail={page} />
      </div>
    </main>
  );
}
