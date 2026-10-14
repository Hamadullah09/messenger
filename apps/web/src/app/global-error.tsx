'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/error-reporter';

/** The whole app failed to render (even the layout): a minimal page that still works. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          padding: 24,
          textAlign: 'center',
          background: '#f8f9fb',
          color: '#111',
        }}
      >
        <h1 style={{ fontSize: 24 }}>SMA could not load</h1>
        <p style={{ color: '#555' }}>The team has been told. Please reload the page.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 44,
            padding: '0 18px',
            borderRadius: 12,
            border: 0,
            background: '#c2410c',
            color: '#fff',
            fontWeight: 600,
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
