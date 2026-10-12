'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiRequestError, refreshSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { hydrateChatPrefs } from '@/lib/chat-prefs';
import { RealtimeProvider } from '@/lib/realtime';

/**
 * Restores the session from the refresh cookie on page load (access tokens are memory-only).
 * If the server is temporarily unreachable it keeps retrying instead of signing the user out.
 */
function SessionBootstrap() {
  useEffect(() => hydrateChatPrefs(), []);
  useEffect(() => {
    if (useAuth.getState().status !== 'loading') return;
    let cancelled = false;
    let delay = 2_000;
    const attempt = async () => {
      const result = await refreshSession();
      if (cancelled) return;
      if (result === 'invalid') useAuth.getState().clear();
      if (result === 'unavailable' && useAuth.getState().status === 'loading') {
        setTimeout(() => void attempt(), delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, error) =>
              !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) &&
              count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionBootstrap />
      <RealtimeProvider>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
}
