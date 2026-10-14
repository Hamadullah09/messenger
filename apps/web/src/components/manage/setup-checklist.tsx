'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface SetupStatus {
  details: boolean;
  stores: number;
  people: number;
  groups: number;
  salesReady: boolean;
}

const hiddenKey = (businessId: string) => `sma.setupHidden.${businessId}`;

/**
 * "Set up your business" for owners and admins of a new business: each step ticks itself off
 * from what is already done. Hidden once everything is done, or when they close it.
 */
export function SetupChecklist({ businessId }: { businessId: string }) {
  const [hidden, setHidden] = useState(true);
  const [notifications, setNotifications] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(hiddenKey(businessId)) === '1');
    } catch {
      setHidden(false);
    }
    setNotifications(typeof Notification !== 'undefined' && Notification.permission === 'granted');
  }, [businessId]);
  const status = useQuery({
    queryKey: ['business-setup', businessId],
    queryFn: () => api<SetupStatus>(`/businesses/${businessId}/setup`),
    enabled: !hidden,
    retry: false,
  });
  const s = status.data;
  if (hidden || !s) return null;
  const steps = [
    {
      done: s.details,
      title: 'Add your business details',
      hint: 'Logo, address and phone',
      href: '/admin?tab=stores',
    },
    {
      done: s.stores > 0,
      title: 'Add your stores',
      hint: 'Each branch or outlet',
      href: '/admin?tab=stores',
    },
    {
      done: s.people > 1,
      title: 'Invite your staff',
      hint: 'Managers and employees sign in with their own account',
      href: '/admin?tab=people',
    },
    {
      done: s.groups > 0,
      title: 'Make team groups',
      hint: 'A group per store or team',
      href: '/chats',
    },
    {
      done: s.salesReady,
      title: 'Set up Sales & Marketing',
      hint: 'Your services, tax and how customers pay',
      href: '/sales?tab=settings',
    },
    {
      done: notifications,
      title: 'Turn on phone notifications',
      hint: 'So nobody misses a message or an alert',
      href: '/settings',
    },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  const hide = () => {
    try {
      window.localStorage.setItem(hiddenKey(businessId), '1');
    } catch {
      // Storage unavailable: hidden for this visit only.
    }
    setHidden(true);
  };
  return (
    <section
      aria-labelledby="setup-title"
      className="rounded-3xl border border-brand/30 bg-surface p-5 shadow-card"
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="flex-1">
          <h2 id="setup-title" className="text-lg font-bold">
            Set up your business
          </h2>
          <p className="text-muted">
            {done} of {steps.length} done
          </p>
        </div>
        <button
          type="button"
          aria-label="Hide the setup list"
          onClick={hide}
          className="rounded-full p-2 text-muted hover:bg-surface-2"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <ol className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {steps.map((step) => (
          <li key={step.title}>
            <Link
              href={step.href}
              className="flex items-start gap-3 rounded-2xl p-3 hover:bg-surface-2"
              aria-label={`${step.title}${step.done ? ' (done)' : ''}`}
            >
              {step.done ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
              )}
              <span>
                <span
                  className={
                    step.done
                      ? 'block font-semibold text-muted line-through'
                      : 'block font-semibold'
                  }
                >
                  {step.title}
                </span>
                <span className="block text-sm text-muted">{step.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
