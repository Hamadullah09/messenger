'use client';

import { CheckCircle2 } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Opened from the link in a campaign message: stops marketing to this customer. */
function Unsubscribe() {
  const params = useSearchParams();
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'error'>('ready');
  const [business, setBusiness] = useState('');
  const [error, setError] = useState('');
  const c = params.get('c');
  const t = params.get('t');

  useEffect(() => {
    if (!c || !t) {
      setState('error');
      setError('This unsubscribe link is incomplete.');
    }
  }, [c, t]);

  async function confirm() {
    setState('busy');
    try {
      const res = await api<{ businessName: string }>('/public/unsubscribe', {
        method: 'POST',
        body: { c, t },
      });
      setBusiness(res.businessName);
      setState('done');
    } catch (e) {
      setError(errorMessage(e));
      setState('error');
    }
  }

  return (
    <AuthCard title="Unsubscribe" subtitle="Stop receiving offers and announcements.">
      {state === 'done' ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="size-12 text-success" aria-hidden />
          <p className="text-lg font-semibold">You are unsubscribed.</p>
          <p className="text-muted">{business} will not send you marketing messages any more.</p>
        </div>
      ) : state === 'error' ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <p>Press the button to stop receiving marketing messages from this business.</p>
          <Button size="lg" busy={state === 'busy'} onClick={() => void confirm()}>
            Unsubscribe
          </Button>
        </div>
      )}
    </AuthCard>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Unsubscribe />
    </Suspense>
  );
}
