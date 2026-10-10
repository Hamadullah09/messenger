'use client';

import type {
  IncidentDetailDto,
  IncidentEventDto,
  IncidentRecipientDto,
  IncidentStatus,
} from '@storeline/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  MessageCircle,
  ShieldCheck,
  Siren,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import {
  ACTIVE,
  ALERT_STATE_LABEL,
  AWAITING,
  CATEGORY_LABEL,
  emergencyKeys,
  sendReceipt,
  SOURCE_LABEL,
  STATUS_LABEL,
  useEmergencyAlerts,
} from '@/lib/emergency';
import { formatRelativeShort, formatTime } from '@/lib/format';
import { Alert, Avatar, Button, ConfirmDialog, cx, Dialog, TextArea } from '../ui';

const STATUS_STYLE: Record<IncidentStatus, string> = {
  OPEN: 'bg-danger text-danger-contrast',
  ESCALATED: 'bg-danger text-danger-contrast',
  ACKNOWLEDGED: 'bg-warning-surface text-warning border border-warning/40',
  RESOLVED: 'bg-success-soft text-success border border-success/40',
  CANCELLED: 'bg-surface-3 text-fg',
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold whitespace-nowrap',
        STATUS_STYLE[status],
      )}
    >
      {AWAITING.includes(status) && <Siren className="size-4" aria-hidden />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function useCountdown(deadline: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!deadline) return null;
  const left = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const STATE_TONE: Record<string, string> = {
  ACKNOWLEDGED: 'bg-success-soft text-success',
  READ: 'bg-brand-soft text-brand-strong',
  DELIVERED_TO_DEVICE: 'bg-brand-soft text-brand-strong',
  FAILED: 'bg-danger-surface text-danger',
  SKIPPED: 'bg-surface-3 text-muted',
};

function RecipientRow({ r }: { r: IncidentRecipientDto }) {
  const at = r.acknowledgedAt ?? r.readAt ?? r.deliveredAt ?? r.sentAt ?? r.notifiedAt;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Avatar name={r.user.displayName} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{r.user.displayName}</p>
        <p className="text-sm text-muted">
          {SOURCE_LABEL[r.source]} · level {r.level}
        </p>
      </div>
      <div className="text-right">
        <span
          className={cx(
            'inline-block rounded-lg px-2 py-0.5 text-sm font-bold',
            STATE_TONE[r.state] ?? 'bg-surface-3 text-fg',
          )}
        >
          {ALERT_STATE_LABEL[r.state]}
        </span>
        {at && <p className="mt-0.5 text-xs text-muted">{formatTime(at)}</p>}
      </div>
    </li>
  );
}

function describeEvent(e: IncidentEventDto): string {
  const actor = e.actor?.displayName ?? 'Someone';
  const users = e.users.map((u) => u.displayName).join(', ') || 'nobody';
  switch (e.type) {
    case 'CREATED':
      return `${actor} raised the alert`;
    case 'NOTIFIED':
      return `Alerted ${users}`;
    case 'ESCALATED':
      return `No response in time — escalated to level ${e.level ?? ''}`;
    case 'RECIPIENT_SKIPPED':
      return `Skipped ${users} (no longer available)`;
    case 'CHAIN_EXHAUSTED':
      return 'Everyone in the escalation chain has been alerted';
    case 'NOTIFY_FAILED':
      return `The alert could not be delivered to ${users}`;
    case 'JOINED':
      return `${actor} joined the response`;
    case 'ACKNOWLEDGED':
      return `${actor} is responding`;
    case 'RESOLVED':
      return `${actor} marked it resolved`;
    case 'CANCELLED':
      return `${actor} cancelled the alert`;
  }
}

export function IncidentDetail({
  incident,
  onBack,
  existing,
}: {
  incident: IncidentDetailDto;
  onBack?: () => void;
  existing?: boolean;
}) {
  const client = useQueryClient();
  const removeAlert = useEmergencyAlerts((s) => s.remove);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const countdown = useCountdown(
    AWAITING.includes(incident.status) ? incident.ackDeadlineAt : null,
  );
  const awaiting = AWAITING.includes(incident.status);
  const active = ACTIVE.includes(incident.status);
  const { me } = incident;

  // Opening the incident counts as "seen" for an alerted responder.
  useEffect(() => {
    if (
      me.alertState &&
      ['QUEUED', 'SENT_TO_GATEWAY', 'DELIVERED_TO_DEVICE', 'FAILED'].includes(me.alertState)
    )
      sendReceipt(incident.id, 'READ');
  }, [incident.id, me.alertState]);

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api<IncidentDetailDto>(`/emergency/incidents/${incident.id}/${path}`, {
        method: 'POST',
        body,
      }),
    onSuccess: (detail) => {
      client.setQueryData(emergencyKeys.detail(detail.id), detail);
      void client.invalidateQueries({ queryKey: ['emergency', 'list'] });
      if (!AWAITING.includes(detail.status) || detail.me.alertState === 'ACKNOWLEDGED')
        removeAlert(detail.id);
      setResolving(false);
      setCancelling(false);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {onBack && (
        <div className="lg:hidden">
          <Button
            variant="ghost"
            icon={<ArrowLeft className="size-5" aria-hidden />}
            onClick={onBack}
          >
            All incidents
          </Button>
        </div>
      )}
      {existing && (
        <Alert tone="info" title="Your alert is still active">
          We added your new details to the existing alert instead of sending a second one.
        </Alert>
      )}

      <section
        className={cx(
          'overflow-hidden rounded-3xl border shadow-card',
          awaiting ? 'border-danger/50' : 'border-line',
        )}
      >
        <div
          className={cx('flex flex-col gap-3 p-5', awaiting ? 'bg-danger-surface' : 'bg-surface')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatusBadge status={incident.status} />
            <span className="text-sm text-muted">
              {new Date(incident.createdAt).toLocaleString()}
            </span>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">
            {CATEGORY_LABEL[incident.category]} · {incident.store.name}
          </h2>
          <p>
            Raised by <strong>{incident.reporter.displayName}</strong>
            {me.isReporter && ' (you)'} · {formatRelativeShort(incident.createdAt)}
          </p>
          {incident.description && (
            <p className="rounded-2xl bg-surface p-4 text-lg whitespace-pre-wrap">
              {incident.description}
            </p>
          )}
          {awaiting && countdown && (
            <p className="flex items-center gap-2 font-semibold">
              <Clock className="size-5" aria-hidden />
              {incident.level < incident.maxLevel
                ? 'Escalates to the next contact in ' + countdown
                : 'Waiting for the last contact in the chain (' + countdown + ')'}
            </p>
          )}
          {awaiting && incident.chainExhaustedAt && (
            <Alert tone="error" title="No one has responded yet">
              Everyone in the escalation chain has been alerted. Call your local emergency number if
              anyone is in danger.
            </Alert>
          )}
          {incident.acknowledgedBy && (
            <p className="flex items-center gap-2 font-semibold text-success">
              <ShieldCheck className="size-5" aria-hidden />
              {incident.acknowledgedBy.displayName} is responding
              {incident.acknowledgedAt && ` · since ${formatTime(incident.acknowledgedAt)}`}
            </p>
          )}
          {incident.status === 'RESOLVED' && (
            <p className="flex items-center gap-2 font-semibold text-success">
              <CheckCircle2 className="size-5" aria-hidden />
              Resolved by {incident.resolvedBy?.displayName ?? 'a responder'}
              {incident.resolutionNote && ` — “${incident.resolutionNote}”`}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line bg-surface p-4">
          {me.canRespond && awaiting && (
            <Button
              variant="danger"
              size="lg"
              busy={action.isPending}
              icon={<ShieldCheck className="size-5" aria-hidden />}
              onClick={() => action.mutate({ path: 'acknowledge' })}
            >
              I’m responding
            </Button>
          )}
          {me.isConversationMember ? (
            <Link
              href={`/chats?c=${incident.conversationId}`}
              className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-brand-contrast hover:bg-brand-strong"
            >
              <MessageCircle className="size-5" aria-hidden /> Open conversation
            </Link>
          ) : (
            me.canRespond &&
            active && (
              <Button
                variant="secondary"
                busy={action.isPending}
                icon={<UserPlus className="size-5" aria-hidden />}
                onClick={() => action.mutate({ path: 'join' })}
              >
                Join conversation
              </Button>
            )
          )}
          {me.canRespond && active && (
            <Button variant="secondary" onClick={() => setResolving(true)}>
              Mark resolved
            </Button>
          )}
          {me.canCancel && (
            <Button variant="secondary" onClick={() => setCancelling(true)}>
              I’m safe — cancel alert
            </Button>
          )}
        </div>
        {action.error && !resolving && !cancelling && (
          <div className="px-4 pb-4">
            <Alert tone="error">{errorMessage(action.error)}</Alert>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-lg font-bold">Who has been alerted</h3>
        <p className="text-sm text-muted">
          “Sent” means the alert left our servers; “Delivered” and “Seen” are confirmed by their
          device.
        </p>
        {incident.recipients.length === 0 ? (
          <p className="py-3 text-muted">No one yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {incident.recipients.map((r) => (
              <RecipientRow key={r.user.id} r={r} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h3 className="mb-2 text-lg font-bold">Timeline</h3>
        <ol className="flex flex-col gap-3 border-l-2 border-line pl-4">
          {incident.events.map((e) => (
            <li key={e.id} className="relative">
              <span
                className={cx(
                  'absolute top-1.5 -left-[1.4rem] size-3 rounded-full',
                  e.type === 'ESCALATED' ||
                    e.type === 'CHAIN_EXHAUSTED' ||
                    e.type === 'NOTIFY_FAILED'
                    ? 'bg-danger'
                    : e.type === 'ACKNOWLEDGED' || e.type === 'RESOLVED'
                      ? 'bg-success'
                      : 'bg-line-strong',
                )}
                aria-hidden
              />
              <p className="font-medium">{describeEvent(e)}</p>
              <p className="text-sm text-muted">{formatTime(e.createdAt)}</p>
            </li>
          ))}
        </ol>
      </section>

      <Dialog open={resolving} onClose={() => setResolving(false)} title="Mark as resolved">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate({ path: 'resolve', body: { note: note.trim() || undefined } });
          }}
        >
          <TextArea
            label="What happened? (optional)"
            hint="A short note for the record, e.g. “Paramedics took over at 14:20”."
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          {action.error && <Alert tone="error">{errorMessage(action.error)}</Alert>}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={() => setResolving(false)}>
              Back
            </Button>
            <Button type="submit" busy={action.isPending}>
              Mark resolved
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={cancelling}
        title="Cancel your alert?"
        message="Only cancel if you are safe and no longer need help. The people alerted will be told it was cancelled."
        confirmLabel="Yes, I’m safe"
        busy={action.isPending}
        onConfirm={() => action.mutate({ path: 'cancel' })}
        onClose={() => setCancelling(false)}
      />
    </div>
  );
}
