'use client';

import type { IncidentListItemDto } from '@storeline/shared';
import { ShieldAlert } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RaiseAlertDialog } from '@/components/emergency/raise-alert';
import { IncidentDetail, StatusBadge } from '@/components/emergency/incident-detail';
import { Alert, Button, cx, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { CATEGORY_LABEL, useIncident, useIncidents } from '@/lib/emergency';
import { formatRelativeShort } from '@/lib/format';

function IncidentCard({
  incident,
  selected,
  onSelect,
}: {
  incident: IncidentListItemDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex w-full flex-col gap-1.5 rounded-2xl border p-4 text-left transition-colors',
          selected ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:bg-surface-2',
        )}
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <StatusBadge status={incident.status} />
          <span className="text-sm text-muted">{formatRelativeShort(incident.createdAt)}</span>
        </span>
        <span className="text-lg font-bold">
          {CATEGORY_LABEL[incident.category]} · {incident.store.name}
        </span>
        <span className="text-muted">
          {incident.me.isReporter ? 'Raised by you' : `Raised by ${incident.reporter.displayName}`}
        </span>
      </button>
    </li>
  );
}

function EmergencyScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useAuth((s) => s.me);
  // Opened from a conversation: the incident may be closed, so search all incidents.
  const [view, setView] = useState<'active' | 'all'>(params.get('conversation') ? 'all' : 'active');
  const [raising, setRaising] = useState(false);
  const list = useIncidents(view === 'active');
  const conversationId = params.get('conversation');
  const fromConversation = conversationId
    ? list.data?.items.find((i) => i.conversationId === conversationId)?.id
    : undefined;
  const selectedId = params.get('id') ?? fromConversation ?? null;
  const detail = useIncident(selectedId);
  const select = (id: string | null) => router.replace(id ? `/emergency?id=${id}` : '/emergency');
  const canRaise = hasPermission(me, 'emergency.trigger');

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
        <div className={cx(selectedId && 'hidden lg:block')}>
          <PageHeader
            title="Emergency"
            subtitle="Alerts for your stores and what happened with them"
            actions={
              canRaise && (
                <Button
                  variant="danger"
                  icon={<ShieldAlert className="size-5" aria-hidden />}
                  onClick={() => setRaising(true)}
                >
                  Emergency help
                </Button>
              )
            }
          />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <section className={cx('flex flex-col gap-3', selectedId && 'hidden lg:flex')}>
            <div
              role="tablist"
              aria-label="Incidents"
              className="flex gap-1 rounded-2xl bg-surface-2 p-1"
            >
              {(
                [
                  ['active', 'Active'],
                  ['all', 'All'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  className={cx(
                    'min-h-11 flex-1 rounded-xl font-semibold',
                    view === key ? 'bg-surface shadow-card' : 'text-muted hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {list.isPending ? (
              <Spinner label="Loading incidents" />
            ) : list.error ? (
              <Alert tone="error">{errorMessage(list.error)}</Alert>
            ) : list.data.items.length === 0 ? (
              <EmptyState
                icon={<ShieldAlert className="size-9" aria-hidden />}
                title="No incidents"
              >
                {view === 'active'
                  ? 'Nothing needs attention right now.'
                  : 'Emergency alerts you raise or respond to will be listed here.'}
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {list.data.items.map((incident) => (
                  <IncidentCard
                    key={incident.id}
                    incident={incident}
                    selected={incident.id === selectedId}
                    onSelect={() => select(incident.id)}
                  />
                ))}
              </ul>
            )}
          </section>
          <section className={cx(!selectedId && 'hidden lg:block')} aria-label="Incident details">
            {!selectedId ? (
              <EmptyState
                icon={<ShieldAlert className="size-9" aria-hidden />}
                title="Choose an incident"
              >
                Select an alert to see who was alerted, its status and the timeline.
              </EmptyState>
            ) : detail.isPending ? (
              <Spinner label="Loading incident" />
            ) : detail.error ? (
              <Alert tone="error">{errorMessage(detail.error)}</Alert>
            ) : (
              <IncidentDetail
                incident={detail.data}
                existing={params.get('existing') === '1'}
                onBack={() => select(null)}
              />
            )}
          </section>
        </div>
      </div>
      <RaiseAlertDialog open={raising} onClose={() => setRaising(false)} />
    </div>
  );
}

export default function EmergencyPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <EmergencyScreen />
    </Suspense>
  );
}
