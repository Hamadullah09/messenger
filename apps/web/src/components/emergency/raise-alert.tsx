'use client';

import {
  EMERGENCY_CATEGORIES,
  type CreateIncidentResponseDto,
  type EmergencyCategory,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ambulance,
  CloudLightning,
  Flame,
  HandMetal,
  HeartPulse,
  ShieldAlert,
  ShoppingBag,
  Siren,
  TriangleAlert,
  Wind,
  ZapOff,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { CATEGORY_LABEL, emergencyKeys } from '@/lib/emergency';
import { Alert, Button, cx, Dialog, Spinner, TextArea } from '../ui';
import { uuid } from '@/lib/uuid';

const CATEGORY_ICON: Record<EmergencyCategory, typeof Flame> = {
  MEDICAL: HeartPulse,
  FIRE: Flame,
  SECURITY: ShieldAlert,
  THEFT: ShoppingBag,
  VIOLENCE: HandMetal,
  ACCIDENT: Ambulance,
  GAS_LEAK: Wind,
  POWER_FAILURE: ZapOff,
  NATURAL_DISASTER: CloudLightning,
  OTHER: TriangleAlert,
};

/**
 * The always-visible "Emergency help" button. `compact` shows a short SOS label (phones);
 * `round` is an icon-only circle for the messenger rail.
 */
export function EmergencyButton({
  compact = false,
  round = false,
}: {
  compact?: boolean;
  round?: boolean;
}) {
  const me = useAuth((s) => s.me);
  const [open, setOpen] = useState(false);
  if (!hasPermission(me, 'emergency.trigger')) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={round ? 'Emergency help' : undefined}
        title={round ? 'Emergency help' : undefined}
        className={cx(
          'inline-flex shrink-0 items-center justify-center gap-2 bg-danger font-bold text-danger-contrast shadow-card transition-opacity hover:opacity-90',
          round ? 'size-11 rounded-full' : 'rounded-xl',
          !round && (compact ? 'min-h-11 px-3 text-sm' : 'min-h-11 px-4'),
        )}
      >
        <Siren className="size-5" aria-hidden />
        {!round && (compact ? 'SOS' : 'Emergency help')}
      </button>
      <RaiseAlertDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function RaiseAlertDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const [storeId, setStoreId] = useState('');
  const [category, setCategory] = useState<EmergencyCategory>('OTHER');
  const [description, setDescription] = useState('');
  // One idempotency key per opened dialog: double taps and retries never raise two alerts.
  const key = useRef<string>('');
  useEffect(() => {
    if (open) {
      key.current = uuid();
      setCategory('OTHER');
      setDescription('');
    }
  }, [open]);

  const stores = useQuery({
    queryKey: emergencyKeys.stores,
    queryFn: () => api<Array<{ id: string; code: string; name: string }>>('/emergency/stores'),
    enabled: open,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (stores.data?.length === 1) setStoreId(stores.data[0]!.id);
  }, [stores.data]);

  const raise = useMutation({
    mutationFn: () =>
      api<CreateIncidentResponseDto>('/emergency/incidents', {
        method: 'POST',
        body: {
          clientIncidentId: key.current,
          storeId: storeId || undefined,
          category,
          description: description.trim() || undefined,
        },
      }),
    onSuccess: (res) => {
      void client.invalidateQueries({ queryKey: emergencyKeys.all });
      onClose();
      router.push(`/emergency?id=${res.incident.id}${res.existing ? '&existing=1' : ''}`);
    },
  });

  const needsStore = (stores.data?.length ?? 0) > 1;
  const noStore = stores.isSuccess && stores.data.length === 0;
  const storeError =
    raise.error instanceof ApiRequestError && raise.error.details.some((d) => d.path === 'storeId');

  return (
    <Dialog open={open} onClose={onClose} title="Emergency help">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          raise.mutate();
        }}
      >
        <Alert
          tone="warning"
          title="If anyone is in immediate danger, call your local emergency number first."
        >
          This alert reaches your store’s emergency contacts. It does not contact police, fire or
          ambulance services.
        </Alert>

        {stores.isPending ? (
          <Spinner label="Finding your store" />
        ) : noStore ? (
          <Alert tone="error" title="You are not assigned to a store">
            There is no store team to alert. Call your local emergency number if you are in danger,
            and ask your administrator to add you to your store.
          </Alert>
        ) : (
          needsStore && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-semibold">Which store are you at?</legend>
              {stores.data?.map((s) => (
                <label
                  key={s.id}
                  className={cx(
                    'flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4',
                    storeId === s.id ? 'border-brand bg-brand-soft' : 'border-line-strong/60',
                  )}
                >
                  <input
                    type="radio"
                    name="store"
                    value={s.id}
                    checked={storeId === s.id}
                    onChange={() => setStoreId(s.id)}
                    className="size-5 accent-[var(--brand)]"
                    required
                  />
                  <span className="font-semibold">{s.name}</span>
                </label>
              ))}
              {storeError && (
                <p role="alert" className="text-sm font-semibold text-danger">
                  Choose the store you are at.
                </p>
              )}
            </fieldset>
          )
        )}

        {!noStore && (
          <>
            <fieldset>
              <legend className="mb-2 font-semibold">What kind of emergency?</legend>
              <div className="grid grid-cols-2 gap-2">
                {EMERGENCY_CATEGORIES.map((c) => {
                  const Icon = CATEGORY_ICON[c];
                  const selected = category === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setCategory(c)}
                      className={cx(
                        'flex min-h-14 items-center gap-2 rounded-xl border px-3 text-left font-semibold transition-colors',
                        selected
                          ? 'border-danger bg-danger-surface text-danger'
                          : 'border-line-strong/60 hover:bg-surface-2',
                      )}
                    >
                      <Icon className="size-5 shrink-0" aria-hidden />
                      {CATEGORY_LABEL[c]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <TextArea
              label={
                category === 'OTHER'
                  ? 'What kind of emergency is it?'
                  : 'What is happening? (optional)'
              }
              hint={
                category === 'OTHER'
                  ? 'Describe it in a few words so responders know what to bring.'
                  : 'Where you are and what you need. You can add photos in the conversation next.'
              }
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                category === 'OTHER'
                  ? 'e.g. Water pipe burst in the stock room'
                  : 'e.g. Customer fainted at checkout 3'
              }
            />
            {raise.error && !storeError && (
              <Alert tone="error" title="The alert was not sent">
                {errorMessage(raise.error)}
              </Alert>
            )}
            <Button
              type="submit"
              variant="danger"
              size="lg"
              busy={raise.isPending}
              disabled={stores.isPending || (needsStore && !storeId)}
              icon={<Siren className="size-6" aria-hidden />}
            >
              Send emergency alert
            </Button>
          </>
        )}
      </form>
    </Dialog>
  );
}
