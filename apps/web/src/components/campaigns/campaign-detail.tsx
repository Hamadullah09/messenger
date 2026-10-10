'use client';

import type {
  CampaignDeliveryBucket,
  CampaignDto,
  CampaignPreviewDto,
  CampaignRecipientDto,
  CampaignStatus,
  Page,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  Download,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, downloadFile, errorMessage } from '@/lib/api';
import { hasTenantPermission, useAuth } from '@/lib/auth-store';
import { Alert, Avatar, Button, ConfirmDialog, cx, Dialog, Spinner, TextField } from '../ui';

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  SENDING: 'Sending',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const STATUS_TONE: Record<CampaignStatus, string> = {
  DRAFT: 'bg-surface-3 text-fg',
  SCHEDULED: 'bg-brand-soft text-brand-strong',
  SENDING: 'bg-brand text-brand-contrast',
  PAUSED: 'bg-warning-surface text-warning',
  COMPLETED: 'bg-success-soft text-success',
  CANCELLED: 'bg-surface-3 text-muted',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={cx('rounded-full px-3 py-1 text-sm font-bold', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Funnel buckets in display order; colours follow the meaning (grey → brand → green, red). */
const BUCKETS: Array<{ key: CampaignDeliveryBucket; label: string; hint: string; color: string }> =
  [
    { key: 'READ', label: 'Read', hint: 'Opened by the recipient', color: 'bg-success' },
    { key: 'DELIVERED', label: 'Delivered', hint: 'Confirmed by their device', color: 'bg-brand' },
    {
      key: 'SENT_TO_GATEWAY',
      label: 'Sent',
      hint: 'Left our servers; not yet confirmed',
      color: 'bg-brand/50',
    },
    { key: 'ACCEPTED', label: 'Saved', hint: 'Stored, being sent', color: 'bg-line-strong' },
    { key: 'QUEUED', label: 'Queued', hint: 'Waiting to be processed', color: 'bg-surface-3' },
    { key: 'FAILED', label: 'Failed', hint: 'Could not be delivered', color: 'bg-danger' },
    {
      key: 'SKIPPED',
      label: 'Skipped',
      hint: 'Opted out, suppressed, expired or unavailable',
      color: 'bg-warning',
    },
    {
      key: 'CANCELLED',
      label: 'Cancelled',
      hint: 'Not sent because the campaign was cancelled',
      color: 'bg-muted',
    },
  ];

export function CampaignDetail({
  campaign,
  onEdit,
  onBack,
}: {
  campaign: CampaignDto;
  onEdit: () => void;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);
  const [confirmSend, setConfirmSend] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [typedCount, setTypedCount] = useState('');
  const [when, setWhen] = useState('');
  const [filter, setFilter] = useState<CampaignDeliveryBucket | null>(null);
  const draft = campaign.status === 'DRAFT';
  const counts = campaign.counts;

  const preview = useQuery({
    queryKey: ['campaign-preview', campaign.id, campaign.updatedAt],
    queryFn: () => api<CampaignPreviewDto>(`/campaigns/${campaign.id}/preview`),
    enabled: draft || campaign.status === 'SCHEDULED',
  });
  const recipients = useQuery({
    queryKey: ['campaign-recipients', campaign.id, filter, counts?.total],
    queryFn: () =>
      api<Page<CampaignRecipientDto>>(`/campaigns/${campaign.id}/recipients`, {
        query: { status: filter ?? undefined, limit: 50 },
      }),
    enabled: !!counts,
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api<CampaignDto>(`/campaigns/${campaign.id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: (saved) => {
      client.setQueryData(['campaign', saved.id], saved);
      void client.invalidateQueries({ queryKey: ['campaigns', saved.businessId] });
      setConfirmSend(false);
      setScheduling(false);
      setCancelling(false);
      setTypedCount('');
    },
  });
  const exportCsv = useMutation({
    mutationFn: () => downloadFile(`/campaigns/${campaign.id}/report.csv`, 'campaign-report.csv'),
  });

  const requiresConfirmation = preview.data?.requiresConfirmation ?? false;
  const confirmBody = requiresConfirmation ? { confirmRecipientCount: Number(typedCount) } : {};
  const countOk = !requiresConfirmation || Number(typedCount) === preview.data?.recipients;
  const canExport = hasTenantPermission(me, 'report.export', campaign.businessId);
  const actionError =
    act.error instanceof ApiRequestError
      ? act.error.message
      : act.error
        ? errorMessage(act.error)
        : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="lg:hidden">
        <Button
          variant="ghost"
          icon={<ArrowLeft className="size-5" aria-hidden />}
          onClick={onBack}
        >
          All campaigns
        </Button>
      </div>
      <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold tracking-tight break-words">{campaign.name}</h2>
            <p className="text-muted">
              By {campaign.createdBy.displayName} · {new Date(campaign.createdAt).toLocaleString()}
            </p>
            {campaign.description && <p className="mt-1">{campaign.description}</p>}
          </div>
          <CampaignStatusBadge status={campaign.status} />
        </div>
        <div className="rounded-2xl bg-chat p-4">
          <div className="ml-auto max-w-prose rounded-2xl rounded-tr-md bg-bubble-out p-3 whitespace-pre-wrap shadow-card">
            {campaign.media && (
              <p className="mb-2 rounded-xl bg-surface/70 px-3 py-2 text-sm font-semibold">
                📎 {campaign.media.fileName}
              </p>
            )}
            {campaign.body ?? <span className="text-muted">(attachment only)</span>}
          </div>
        </div>
        <p className="text-sm text-muted">
          Audience: {describeAudience(campaign)}
          {campaign.expiresAt && ` · stops after ${new Date(campaign.expiresAt).toLocaleString()}`}
          {campaign.scheduledAt &&
            ` · scheduled for ${new Date(campaign.scheduledAt).toLocaleString()}`}
        </p>

        {(draft || campaign.status === 'SCHEDULED') && (
          <div className="rounded-2xl border border-line p-4">
            {preview.isPending ? (
              <Spinner label="Counting recipients" />
            ) : preview.error ? (
              <Alert tone="error">{errorMessage(preview.error)}</Alert>
            ) : (
              <p className="text-lg">
                <strong>{preview.data.recipients.toLocaleString()}</strong> people will receive this
                {preview.data.suppressed > 0 && (
                  <span className="text-muted">
                    {' '}
                    · {preview.data.suppressed} excluded (opted out or on the do-not-send list)
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        {actionError && <Alert tone="error">{actionError}</Alert>}
        <div className="flex flex-wrap gap-2">
          {draft && (
            <>
              <Button
                icon={<Send className="size-5" aria-hidden />}
                onClick={() => setConfirmSend(true)}
              >
                Send now
              </Button>
              <Button
                variant="secondary"
                icon={<CalendarClock className="size-5" aria-hidden />}
                onClick={() => setScheduling(true)}
              >
                Schedule
              </Button>
              <Button
                variant="secondary"
                icon={<Pencil className="size-5" aria-hidden />}
                onClick={onEdit}
              >
                Edit
              </Button>
            </>
          )}
          {campaign.status === 'SCHEDULED' && (
            <Button
              variant="secondary"
              busy={act.isPending}
              onClick={() => act.mutate({ path: 'unschedule' })}
            >
              Back to draft
            </Button>
          )}
          {campaign.status === 'SENDING' && (
            <Button
              variant="secondary"
              busy={act.isPending}
              icon={<Pause className="size-5" aria-hidden />}
              onClick={() => act.mutate({ path: 'pause' })}
            >
              Pause
            </Button>
          )}
          {campaign.status === 'PAUSED' && (
            <Button
              busy={act.isPending}
              icon={<Play className="size-5" aria-hidden />}
              onClick={() => act.mutate({ path: 'resume' })}
            >
              Resume
            </Button>
          )}
          {counts && counts.FAILED > 0 && campaign.status !== 'CANCELLED' && (
            <Button
              variant="secondary"
              busy={act.isPending}
              icon={<RotateCcw className="size-5" aria-hidden />}
              onClick={() => act.mutate({ path: 'retry-failed' })}
            >
              Retry {counts.FAILED} failed
            </Button>
          )}
          {['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'].includes(campaign.status) && (
            <Button
              variant="ghost"
              icon={<XCircle className="size-5" aria-hidden />}
              onClick={() => setCancelling(true)}
            >
              Cancel campaign
            </Button>
          )}
          {counts && canExport && (
            <Button
              variant="secondary"
              busy={exportCsv.isPending}
              icon={<Download className="size-5" aria-hidden />}
              onClick={() => exportCsv.mutate()}
            >
              Export report (CSV)
            </Button>
          )}
        </div>
        {exportCsv.error && <Alert tone="error">{errorMessage(exportCsv.error)}</Alert>}
      </section>

      {counts && (
        <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-bold">Delivery</h3>
            <span className="text-muted">{counts.total.toLocaleString()} recipients</span>
          </div>
          <div
            className="flex h-4 w-full overflow-hidden rounded-full bg-surface-3"
            role="img"
            aria-label="Delivery progress"
          >
            {BUCKETS.map((b) =>
              counts[b.key] > 0 ? (
                <span
                  key={b.key}
                  className={b.color}
                  style={{ width: `${(counts[b.key] / Math.max(1, counts.total)) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {BUCKETS.filter((b) => b.key !== 'READ' || counts.readReceipts).map((b) => (
              <li key={b.key}>
                <button
                  type="button"
                  onClick={() => setFilter(filter === b.key ? null : b.key)}
                  aria-pressed={filter === b.key}
                  title={b.hint}
                  className={cx(
                    'flex w-full flex-col items-start rounded-2xl border p-3 text-left',
                    filter === b.key
                      ? 'border-brand bg-brand-soft'
                      : 'border-line hover:bg-surface-2',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm text-muted">
                    <span className={cx('size-2.5 rounded-full', b.color)} aria-hidden />
                    {b.label}
                  </span>
                  <span className="text-2xl font-bold">{counts[b.key].toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
          {!counts.readReceipts && (
            <p className="text-sm text-muted">
              Read receipts are off for this business, so reads count as delivered.
            </p>
          )}
          <div>
            <h4 className="mb-2 font-semibold">
              {filter ? `${BUCKETS.find((b) => b.key === filter)!.label} recipients` : 'Recipients'}
            </h4>
            {recipients.isPending ? (
              <Spinner label="Loading recipients" />
            ) : recipients.error ? (
              <Alert tone="error">{errorMessage(recipients.error)}</Alert>
            ) : recipients.data.items.length === 0 ? (
              <p className="text-muted">No one here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {recipients.data.items.map((r) => (
                  <li key={r.user.id} className="flex items-center gap-3 py-2">
                    <Avatar name={r.user.displayName} size={36} />
                    <span className="min-w-0 flex-1 truncate">{r.user.displayName}</span>
                    <span className="text-sm text-muted">
                      {BUCKETS.find((b) => b.key === r.status)?.label}
                      {r.reason && ` · ${r.reason.replace(/_/g, ' ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {recipients.data?.nextCursor && (
              <p className="mt-2 text-sm text-muted">
                Showing the first 50 — export the report for everyone.
              </p>
            )}
          </div>
        </section>
      )}

      <Dialog open={confirmSend} onClose={() => setConfirmSend(false)} title="Send campaign now?">
        <div className="flex flex-col gap-4">
          <p>
            This will message <strong>{preview.data?.recipients.toLocaleString() ?? '…'}</strong>{' '}
            people. Sent messages cannot be recalled, but you can pause or cancel what has not been
            sent yet.
          </p>
          {requiresConfirmation && (
            <TextField
              label="Type the number of recipients to confirm"
              inputMode="numeric"
              value={typedCount}
              onChange={(e) => setTypedCount(e.target.value.replace(/\D/g, ''))}
            />
          )}
          {actionError && <Alert tone="error">{actionError}</Alert>}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setConfirmSend(false)}>
              Back
            </Button>
            <Button
              busy={act.isPending}
              disabled={!countOk || !preview.data}
              onClick={() => act.mutate({ path: 'send', body: confirmBody })}
            >
              Send to {preview.data?.recipients.toLocaleString() ?? '…'} people
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={scheduling} onClose={() => setScheduling(false)} title="Schedule campaign">
        <div className="flex flex-col gap-4">
          <TextField
            label="Send at"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          {requiresConfirmation && (
            <TextField
              label={`Type ${preview.data?.recipients ?? ''} to confirm the audience size`}
              inputMode="numeric"
              value={typedCount}
              onChange={(e) => setTypedCount(e.target.value.replace(/\D/g, ''))}
            />
          )}
          {actionError && <Alert tone="error">{actionError}</Alert>}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setScheduling(false)}>
              Back
            </Button>
            <Button
              busy={act.isPending}
              disabled={!when || !countOk}
              onClick={() =>
                act.mutate({
                  path: 'schedule',
                  body: { ...confirmBody, scheduledAt: new Date(when).toISOString() },
                })
              }
            >
              Schedule
            </Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={cancelling}
        title="Cancel this campaign?"
        message="Nothing more will be sent. Messages already delivered stay in people's Announcements chat."
        confirmLabel="Cancel campaign"
        danger
        busy={act.isPending}
        onConfirm={() => act.mutate({ path: 'cancel' })}
        onClose={() => setCancelling(false)}
      />
    </div>
  );
}

function describeAudience(c: CampaignDto): string {
  const a = c.audience;
  const parts: string[] = [];
  if (a.everyone) parts.push('everyone');
  if (a.storeIds.length)
    parts.push(`${a.storeIds.length} store${a.storeIds.length > 1 ? 's' : ''}`);
  if (a.groupIds.length)
    parts.push(`${a.groupIds.length} group${a.groupIds.length > 1 ? 's' : ''}`);
  let text = parts.join(' + ');
  if (a.roleKeys.length)
    text += ` (only ${a.roleKeys.map((r) => r.toLowerCase().replace('_', ' ')).join(', ')})`;
  if (a.includeCustomers) text += ', including customers';
  return text;
}
