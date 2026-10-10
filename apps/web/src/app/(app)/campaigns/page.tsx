'use client';

import type { AdminUserDto, CampaignDto, CampaignSuppressionDto, Page } from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Megaphone, Plus, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CampaignDetail, CampaignStatusBadge } from '@/components/campaigns/campaign-detail';
import { CampaignEditor } from '@/components/campaigns/campaign-editor';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  IconButton,
  PageHeader,
  SelectField,
  Spinner,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { hasTenantPermission, useAuth } from '@/lib/auth-store';
import { formatRelativeShort } from '@/lib/format';

function CampaignsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useAuth((s) => s.me);
  const businessId = useAuth((s) => s.activeBusinessId);
  const [suppressions, setSuppressions] = useState(false);
  const selectedId = params.get('id');
  const mode = params.get('mode'); // "new" | "edit"
  const go = (query: string) => router.replace(`/campaigns${query}`);

  const list = useQuery({
    queryKey: ['campaigns', businessId],
    queryFn: () =>
      api<Page<CampaignDto>>(`/businesses/${businessId}/campaigns`, { query: { limit: 100 } }),
    enabled: !!businessId,
    refetchInterval: (q) =>
      q.state.data?.items.some((c) => c.status === 'SENDING' || c.status === 'SCHEDULED')
        ? 5000
        : false,
  });
  const detail = useQuery({
    queryKey: ['campaign', selectedId],
    queryFn: () => api<CampaignDto>(`/campaigns/${selectedId}`),
    enabled: !!selectedId,
    // Live progress while sending.
    refetchInterval: (q) =>
      q.state.data?.status === 'SENDING' || q.state.data?.status === 'SCHEDULED' ? 2000 : false,
  });

  if (!businessId || !hasTenantPermission(me, 'bulk_message.send', businessId)) {
    return (
      <EmptyState icon={<Megaphone className="size-9" aria-hidden />} title="Campaigns">
        Campaigns are available to administrators with permission to send business announcements.
      </EmptyState>
    );
  }
  const showSide = !!selectedId || mode === 'new';

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
        <div className={cx(showSide && 'hidden lg:block')}>
          <PageHeader
            title="Campaigns"
            subtitle="Announcements to people in your business, delivered in the background"
            actions={
              <>
                <Button
                  variant="secondary"
                  icon={<Ban className="size-5" aria-hidden />}
                  onClick={() => setSuppressions(true)}
                >
                  Do-not-send list
                </Button>
                <Button
                  icon={<Plus className="size-5" aria-hidden />}
                  onClick={() => go('?mode=new')}
                >
                  New campaign
                </Button>
              </>
            }
          />
        </div>
        {!me?.session.mfaVerified && (
          <Alert tone="warning" title="Two-step verification needed">
            Sending campaigns requires a session verified with two-step verification.
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <section className={cx('flex flex-col gap-2', showSide && 'hidden lg:flex')}>
            {list.isPending ? (
              <Spinner label="Loading campaigns" />
            ) : list.error ? (
              <Alert tone="error">{errorMessage(list.error)}</Alert>
            ) : list.data.items.length === 0 ? (
              <EmptyState
                icon={<Megaphone className="size-9" aria-hidden />}
                title="No campaigns yet"
              >
                Create one to send an announcement to a store, a group or the whole business.
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {list.data.items.map((c) => {
                  const done = c.counts ? c.counts.total - c.counts.QUEUED : 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => go(`?id=${c.id}`)}
                        aria-current={c.id === selectedId ? 'true' : undefined}
                        className={cx(
                          'flex w-full flex-col gap-2 rounded-2xl border p-4 text-left',
                          c.id === selectedId
                            ? 'border-brand bg-brand-soft'
                            : 'border-line bg-surface hover:bg-surface-2',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-lg font-bold">{c.name}</span>
                          <CampaignStatusBadge status={c.status} />
                        </span>
                        <span className="text-sm text-muted">
                          {c.counts
                            ? `${done.toLocaleString()} of ${c.counts.total.toLocaleString()} processed`
                            : 'Not sent yet'}{' '}
                          · {formatRelativeShort(c.createdAt)}
                        </span>
                        {c.counts && c.counts.total > 0 && (
                          <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                            <span
                              className="block h-full bg-brand"
                              style={{ width: `${(done / c.counts.total) * 100}%` }}
                            />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className={cx(!showSide && 'hidden lg:block')}>
            {mode === 'new' ? (
              <CampaignEditor
                businessId={businessId}
                campaign={null}
                onSaved={(c) => go(`?id=${c.id}`)}
                onCancel={() => go('')}
              />
            ) : !selectedId ? (
              <EmptyState
                icon={<Megaphone className="size-9" aria-hidden />}
                title="Choose a campaign"
              >
                Select a campaign to see its delivery report, or create a new one.
              </EmptyState>
            ) : detail.isPending ? (
              <Spinner label="Loading campaign" />
            ) : detail.error ? (
              <Alert tone="error">{errorMessage(detail.error)}</Alert>
            ) : mode === 'edit' && detail.data.status === 'DRAFT' ? (
              <CampaignEditor
                businessId={businessId}
                campaign={detail.data}
                onSaved={(c) => go(`?id=${c.id}`)}
                onCancel={() => go(`?id=${detail.data.id}`)}
              />
            ) : (
              <CampaignDetail
                campaign={detail.data}
                onEdit={() => go(`?id=${detail.data.id}&mode=edit`)}
                onBack={() => go('')}
              />
            )}
          </section>
        </div>
      </div>
      <SuppressionDialog
        businessId={businessId}
        open={suppressions}
        onClose={() => setSuppressions(false)}
      />
    </div>
  );
}

/** People who never receive campaigns from this business (admin list + customers' opt-outs). */
function SuppressionDialog({
  businessId,
  open,
  onClose,
}: {
  businessId: string;
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [userId, setUserId] = useState('');
  const key = ['campaign-suppressions', businessId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<CampaignSuppressionDto[]>(`/businesses/${businessId}/campaign-suppressions`),
    enabled: open,
  });
  const people = useQuery({
    queryKey: ['people', businessId, '', ''],
    queryFn: () =>
      api<Page<AdminUserDto>>(`/businesses/${businessId}/users`, { query: { limit: 100 } }),
    enabled: open,
  });
  const change = useMutation({
    mutationFn: ({ id, add }: { id: string; add: boolean }) =>
      add
        ? api(`/businesses/${businessId}/campaign-suppressions`, {
            method: 'POST',
            body: { userId: id },
          })
        : api(`/businesses/${businessId}/campaign-suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setUserId('');
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const listed = new Set((list.data ?? []).map((s) => s.user.id));
  return (
    <Dialog open={open} onClose={onClose} title="Do-not-send list" wide>
      <div className="flex flex-col gap-4">
        <p className="text-muted">
          People here are skipped by every campaign. Customers who turned announcements off appear
          too; only they can turn them back on.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Add a person"
            className="min-w-64 flex-1"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Choose…</option>
            {(people.data?.items ?? [])
              .filter((u) => !listed.has(u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
          </SelectField>
          <Button
            disabled={!userId}
            busy={change.isPending}
            onClick={() => change.mutate({ id: userId, add: true })}
          >
            Add
          </Button>
        </div>
        {change.error && <Alert tone="error">{errorMessage(change.error)}</Alert>}
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <Alert tone="error">{errorMessage(list.error)}</Alert>
        ) : list.data.length === 0 ? (
          <p className="text-muted">No one is on the list.</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.data.map((s) => (
              <li key={s.user.id} className="flex items-center gap-3 py-2">
                <Avatar name={s.user.displayName} size={36} />
                <span className="min-w-0 flex-1 truncate">{s.user.displayName}</span>
                <span className="text-sm text-muted">
                  {s.reason === 'SELF_OPT_OUT' ? 'Opted out themselves' : 'Added by an admin'}
                </span>
                {s.reason === 'ADMIN' && (
                  <IconButton
                    label={`Remove ${s.user.displayName}`}
                    onClick={() => change.mutate({ id: s.user.id, add: false })}
                  >
                    <Trash2 className="size-5" aria-hidden />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export default function CampaignsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CampaignsScreen />
    </Suspense>
  );
}
