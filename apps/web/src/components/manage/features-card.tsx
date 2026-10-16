'use client';

import { FEATURE_KEYS, FEATURES, type FeatureKey, type FeaturesDto } from '@storeline/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToggleRight } from 'lucide-react';
import { Alert, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useFeatures } from '@/lib/features';

/** Super Admin: switch parts of SMA off for everyone (and back on) without removing them. */
export function FeaturesCard() {
  const client = useQueryClient();
  const features = useFeatures();
  const save = useMutation({
    mutationFn: (change: Partial<FeaturesDto>) =>
      api<FeaturesDto>('/platform/features', { method: 'PUT', body: { features: change } }),
    onSuccess: (next) => client.setQueryData(['features'], next),
  });
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand-soft text-brand-strong">
          <ToggleRight className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">Features</h2>
          <p className="text-sm text-muted">
            Turn parts of SMA off for everyone, and back on whenever you need them. Nothing is
            deleted.
          </p>
        </div>
      </div>
      <ul className="mt-4 divide-y divide-line">
        {FEATURE_KEYS.map((key: FeatureKey) => {
          const on = features[key];
          return (
            <li key={key} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{FEATURES[key].label}</p>
                <p className="text-sm text-muted">{FEATURES[key].description}</p>
              </div>
              <span className={cx('text-sm font-bold', on ? 'text-success' : 'text-muted')}>
                {on ? 'On' : 'Off'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={FEATURES[key].label}
                disabled={save.isPending}
                onClick={() => save.mutate({ [key]: !on })}
                className={cx(
                  'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
                  on ? 'bg-brand' : 'bg-line-strong/60',
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    'absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform',
                    on ? 'translate-x-[22px]' : 'translate-x-0.5',
                  )}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
    </section>
  );
}
