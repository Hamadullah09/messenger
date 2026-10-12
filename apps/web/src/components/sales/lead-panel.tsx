'use client';

import {
  ACTIVITY_OUTCOMES,
  LEAD_ACTIVITY_TYPES,
  STUCK_AFTER_DAYS_IDLE,
  STUCK_AFTER_DAYS_IN_STAGE,
  type ActivityOutcome,
  LEAD_STAGES,
  type LeadActivityKind,
  type LeadDetailDto,
  type LeadStage,
  type SalesContextDto,
  type SalesUserDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Building2,
  CalendarClock,
  Globe,
  Hand,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Store,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { LeadDeals } from './crm';
import { countryName } from '@/lib/countries';
import { formatDay, formatRelativeShort, formatTime } from '@/lib/format';
import {
  Alert,
  Avatar,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '../ui';
import {
  ACTIVITY_LABEL,
  DIRECTION_LABEL,
  money,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SOURCE_LABEL,
  STAGE_LABEL,
  STAGE_TONE,
} from './labels';
import { LeadFormDialog } from './lead-form';

export function StageChip({ stage }: { stage: LeadStage }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold',
        STAGE_TONE[stage].chip,
      )}
    >
      <span className={cx('size-1.5 rounded-full', STAGE_TONE[stage].dot)} aria-hidden />
      {STAGE_LABEL[stage]}
    </span>
  );
}

/** Everything about one lead: contact, funnel stage, owner, activity and conversion. */
export function LeadPanel({
  leadId,
  context,
  team,
  myId,
  onClose,
}: {
  leadId: string;
  context: SalesContextDto;
  team: SalesUserDto[];
  myId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const lead = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<LeadDetailDto>(`/sales/leads/${leadId}`),
  });
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [converting, setConverting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activity, setActivity] = useState<{
    type: LeadActivityKind;
    body: string;
    next: string;
    outcome: ActivityOutcome | '';
  }>({ type: 'CALL', body: '', next: '', outcome: '' });
  const done = (data: LeadDetailDto) => {
    client.setQueryData(['lead', leadId], data);
    void client.invalidateQueries({ queryKey: ['leads'] });
    void client.invalidateQueries({ queryKey: ['sales-overview'] });
    void client.invalidateQueries({ queryKey: ['sales-team'] });
  };
  const stage = useMutation({
    mutationFn: (body: { stage: LeadStage; lostReason?: string }) =>
      api<LeadDetailDto>(`/sales/leads/${leadId}/stage`, { method: 'PUT', body }),
    onSuccess: (data) => {
      setLosing(false);
      setLostReason('');
      done(data);
    },
  });
  const assign = useMutation({
    mutationFn: (ownerId: string | null) =>
      api<LeadDetailDto>(`/sales/leads/${leadId}/owner`, { method: 'PUT', body: { ownerId } }),
    onSuccess: done,
  });
  const claim = useMutation({
    mutationFn: () => api<LeadDetailDto>(`/sales/leads/${leadId}/claim`, { method: 'POST' }),
    onSuccess: done,
  });
  const log = useMutation({
    mutationFn: () =>
      api<LeadDetailDto>(`/sales/leads/${leadId}/activities`, {
        method: 'POST',
        body: {
          type: activity.type,
          body: activity.body.trim(),
          ...(activity.outcome && activity.type !== 'NOTE' ? { outcome: activity.outcome } : {}),
          ...(activity.next ? { nextFollowUpAt: new Date(activity.next).toISOString() } : {}),
        },
      }),
    onSuccess: (data) => {
      setActivity({ type: activity.type, body: '', next: '', outcome: '' });
      done(data);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/sales/leads/${leadId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['leads'] });
      void client.invalidateQueries({ queryKey: ['sales-overview'] });
      onClose();
    },
  });

  const l = lead.data;
  const mine = l?.owner?.id === myId;
  const canWork = !!l && (mine || context.canSeeAll);
  const error = stage.error ?? assign.error ?? claim.error ?? log.error ?? remove.error;

  return (
    <Dialog open onClose={onClose} title={l?.companyName ?? 'Lead'} wide>
      {!l ? (
        lead.isError ? (
          <Alert tone="error">{errorMessage(lead.error)}</Alert>
        ) : (
          <Spinner label="Loading lead" />
        )
      ) : (
        <div className="flex flex-col gap-6">
          {error && <Alert tone="error">{errorMessage(error)}</Alert>}

          {/* Summary */}
          <div className="flex flex-wrap items-start gap-4">
            <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Building2 className="size-7" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StageChip stage={l.stage} />
                <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold">
                  {DIRECTION_LABEL[l.direction]} · {SOURCE_LABEL[l.source]}
                  {l.sourceDetail ? ` · ${l.sourceDetail}` : ''}
                </span>
                {l.stuck && (
                  <span className="rounded-full bg-danger-surface px-2.5 py-0.5 text-xs font-bold text-danger">
                    Stuck
                  </span>
                )}
              </div>
              <p className="mt-1 text-lg font-semibold">
                {l.contactName}
                {l.contactTitle && (
                  <span className="font-normal text-muted"> · {l.contactTitle}</span>
                )}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                {l.phone && (
                  <span className="inline-flex items-center gap-1 select-all">
                    <Phone className="size-4" aria-hidden /> {l.phone}
                  </span>
                )}
                {l.email && (
                  <span className="inline-flex items-center gap-1 select-all">
                    <Mail className="size-4" aria-hidden /> {l.email}
                  </span>
                )}
                {(l.city || l.country) && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-4" aria-hidden />
                    {[l.city, countryName(l.country)].filter(Boolean).join(', ')}
                  </span>
                )}
                {l.storeCount !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Store className="size-4" aria-hidden /> {l.storeCount} stores
                  </span>
                )}
                {l.website && (
                  <a
                    href={l.website}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    <Globe className="size-4" aria-hidden /> Website
                  </a>
                )}
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted">Expected / month</p>
              <p className="text-xl font-bold">{money(l.estimatedValue, l.currency)}</p>
            </div>
          </div>

          {/* Effort and progress at a glance */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ['Calls', l.callCount],
              ['Messages', l.messageCount],
              ['Meetings', l.meetingCount],
              ['Days in this stage', l.daysInStage],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-surface-2 px-3 py-2">
                <p className="text-xs text-muted">{label}</p>
                <p className="text-lg font-bold tabular-nums">{value}</p>
              </div>
            ))}
            <div className="col-span-2 rounded-2xl bg-surface-2 px-3 py-2 sm:col-span-1">
              <p className="text-xs text-muted">Last response</p>
              <p
                className={cx(
                  'truncate font-bold',
                  l.lastOutcome ? OUTCOME_TONE[l.lastOutcome] : 'text-muted',
                )}
              >
                {l.lastOutcome ? OUTCOME_LABEL[l.lastOutcome] : 'None yet'}
              </p>
            </div>
          </div>
          {l.stuck && (
            <Alert tone="warning" title="This lead is stuck">
              It has been in “{STAGE_LABEL[l.stage]}” for {l.daysInStage} days or has had no
              activity for over {STUCK_AFTER_DAYS_IDLE} days (limits: {STUCK_AFTER_DAYS_IN_STAGE}{' '}
              days in a stage, {STUCK_AFTER_DAYS_IDLE} days idle). Log a call or move it on.
            </Alert>
          )}

          {l.customer && (
            <Alert tone="success" title="SMA customer">
              Became the business “{l.customer.businessName}” on {formatDay(l.customer.convertedAt)}
              . Manage it in Administration → Businesses.
            </Alert>
          )}

          {/* Funnel */}
          <section>
            <h3 className="mb-2 font-bold">Stage</h3>
            <ol className="flex flex-wrap gap-1.5" aria-label="Sales funnel">
              {LEAD_STAGES.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    disabled={!canWork || stage.isPending || !!l.customer}
                    aria-pressed={l.stage === s}
                    onClick={() => (s === 'LOST' ? setLosing(true) : stage.mutate({ stage: s }))}
                    className={cx(
                      'rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed',
                      l.stage === s
                        ? cx('border-transparent', STAGE_TONE[s].chip)
                        : 'border-line text-muted enabled:hover:bg-surface-2',
                    )}
                  >
                    {STAGE_LABEL[s]}
                  </button>
                </li>
              ))}
            </ol>
            {l.stage === 'LOST' && l.lostReason && (
              <p className="mt-2 text-sm text-muted">Lost because: {l.lostReason}</p>
            )}
            {losing && (
              <form
                className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl bg-surface-2 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  stage.mutate({ stage: 'LOST', lostReason });
                }}
              >
                <TextField
                  className="min-w-60 flex-1"
                  label="Why was it lost?"
                  placeholder="e.g. Chose a competitor, no budget"
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                  autoFocus
                />
                <Button
                  type="submit"
                  variant="danger"
                  disabled={!lostReason.trim()}
                  busy={stage.isPending}
                >
                  Mark as lost
                </Button>
                <Button type="button" variant="ghost" onClick={() => setLosing(false)}>
                  Cancel
                </Button>
              </form>
            )}
          </section>

          {/* Owner */}
          <section className="flex flex-wrap items-end gap-3">
            {context.canAssign ? (
              <SelectField
                label="Lead owner"
                className="min-w-60"
                value={l.owner?.id ?? ''}
                disabled={assign.isPending}
                onChange={(e) => assign.mutate(e.target.value || null)}
              >
                <option value="">Unassigned queue</option>
                {team.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </SelectField>
            ) : (
              <p>
                <span className="font-semibold">Owner: </span>
                {l.owner ? l.owner.displayName : 'Unassigned'}
              </p>
            )}
            {!l.owner && (
              <Button
                variant="secondary"
                icon={<Hand className="size-5" aria-hidden />}
                busy={claim.isPending}
                onClick={() => claim.mutate()}
              >
                Take this lead
              </Button>
            )}
            <span className="flex-1" />
            {canWork && (
              <Button
                variant="secondary"
                icon={<Pencil className="size-5" aria-hidden />}
                onClick={() => setEditing(true)}
              >
                Edit details
              </Button>
            )}
            {context.canConvert && !l.customer && l.stage !== 'LOST' && (
              <Button
                icon={<BadgeCheck className="size-5" aria-hidden />}
                onClick={() => setConverting(true)}
              >
                Convert to SMA customer
              </Button>
            )}
            {context.canAssign && (
              <Button
                variant="ghost"
                className="text-danger"
                icon={<Trash2 className="size-5" aria-hidden />}
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            )}
          </section>

          <LeadDeals lead={{ id: l.id, companyName: l.companyName }} context={context} team={team} />

          {l.notes && (
            <section>
              <h3 className="mb-1 font-bold">Notes</h3>
              <p className="whitespace-pre-wrap text-muted">{l.notes}</p>
            </section>
          )}

          {/* Log activity */}
          {canWork && (
            <section className="rounded-2xl border border-line p-4">
              <h3 className="mb-3 font-bold">Log activity</h3>
              <div
                className="mb-3 flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label="Activity type"
              >
                {LEAD_ACTIVITY_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={activity.type === t}
                    onClick={() => setActivity({ ...activity, type: t })}
                    className={cx(
                      'rounded-full border px-3 py-1 text-sm font-semibold',
                      activity.type === t
                        ? 'border-brand bg-brand-soft text-brand-strong'
                        : 'border-line text-muted hover:bg-surface-2',
                    )}
                  >
                    {ACTIVITY_LABEL[t]}
                  </button>
                ))}
              </div>
              {activity.type !== 'NOTE' && (
                <div className="mb-3">
                  <SelectField
                    label="Their response"
                    value={activity.outcome}
                    onChange={(e) =>
                      setActivity({ ...activity, outcome: e.target.value as ActivityOutcome | '' })
                    }
                  >
                    <option value="">Not recorded</option>
                    {ACTIVITY_OUTCOMES.map((o) => (
                      <option key={o} value={o}>
                        {OUTCOME_LABEL[o]}
                      </option>
                    ))}
                  </SelectField>
                </div>
              )}
              <TextArea
                label="What happened?"
                rows={2}
                maxLength={2000}
                placeholder="e.g. Called the owner, wants a demo for 3 stores next week"
                value={activity.body}
                onChange={(e) => setActivity({ ...activity, body: e.target.value })}
              />
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <TextField
                  label="Next follow-up (optional)"
                  type="datetime-local"
                  value={activity.next}
                  onChange={(e) => setActivity({ ...activity, next: e.target.value })}
                />
                <Button
                  busy={log.isPending}
                  disabled={!activity.body.trim()}
                  onClick={() => log.mutate()}
                >
                  Save activity
                </Button>
              </div>
              {l.nextFollowUpAt && (
                <p
                  className={cx(
                    'mt-3 flex items-center gap-1.5 text-sm font-semibold',
                    new Date(l.nextFollowUpAt) <= new Date() ? 'text-danger' : 'text-muted',
                  )}
                >
                  <CalendarClock className="size-4" aria-hidden />
                  Follow up {formatDay(l.nextFollowUpAt)} {formatTime(l.nextFollowUpAt)}
                </p>
              )}
            </section>
          )}

          {/* Timeline */}
          <section>
            <h3 className="mb-3 font-bold">History</h3>
            <ol className="relative flex flex-col gap-4 border-l-2 border-line pl-5">
              {l.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span
                    className="absolute top-1.5 -left-[27px] size-3 rounded-full border-2 border-surface bg-brand"
                    aria-hidden
                  />
                  <p className="text-sm">
                    <span className="font-semibold">{ACTIVITY_LABEL[a.type]}</span>
                    {a.toStage && a.type !== 'CREATED' && (
                      <>
                        {' '}
                        {a.fromStage ? `${STAGE_LABEL[a.fromStage]} → ` : ''}
                        {STAGE_LABEL[a.toStage]}
                      </>
                    )}
                    {a.outcome && (
                      <span className={cx('font-semibold', OUTCOME_TONE[a.outcome])}>
                        {' · '}
                        {OUTCOME_LABEL[a.outcome]}
                      </span>
                    )}
                    <span className="text-muted">
                      {' · '}
                      {a.actor?.displayName ?? 'Website'} · {formatRelativeShort(a.createdAt)}
                    </span>
                  </p>
                  {a.body && <p className="mt-0.5 whitespace-pre-wrap">{a.body}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {editing && l && (
        <LeadFormDialog
          lead={l}
          team={team}
          canAssign={context.canAssign}
          onClose={() => setEditing(false)}
          onSaved={(data) => {
            setEditing(false);
            done(data);
          }}
        />
      )}
      {converting && l && (
        <ConvertDialog
          leadId={l.id}
          companyName={l.companyName}
          contactName={l.contactName}
          email={l.email}
          onClose={() => setConverting(false)}
          onDone={(data) => {
            setConverting(false);
            done(data);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title="Delete this lead?"
        message="It disappears from the pipeline and reports. This cannot be undone."
        confirmLabel="Delete lead"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
      />
    </Dialog>
  );
}

function ConvertDialog({
  leadId,
  companyName,
  contactName,
  email,
  onClose,
  onDone,
}: {
  leadId: string;
  companyName: string;
  contactName: string;
  email: string | null;
  onClose: () => void;
  onDone: (lead: LeadDetailDto) => void;
}) {
  const slugify = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
  const [business, setBusiness] = useState({ name: companyName, slug: slugify(companyName) });
  const [admin, setAdmin] = useState({
    displayName: contactName,
    username: '',
    email: email ?? '',
    password: '',
  });
  const withAdmin = Object.values({ ...admin, displayName: '' }).some((v) => v.trim());
  const convert = useMutation({
    mutationFn: () =>
      api<LeadDetailDto>(`/sales/leads/${leadId}/convert`, {
        method: 'POST',
        body: {
          businessName: business.name.trim(),
          slug: business.slug.trim(),
          ...(withAdmin
            ? {
                admin: {
                  displayName: admin.displayName.trim(),
                  username: admin.username.trim().toLowerCase(),
                  email: admin.email.trim(),
                  password: admin.password,
                },
              }
            : {}),
        },
      }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onClose={onClose} title="Convert to SMA customer" wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          convert.mutate();
        }}
      >
        {convert.isError && <Alert tone="error">{errorMessage(convert.error)}</Alert>}
        <Alert tone="info" title="This creates a new customer business on SMA">
          The lead is marked Won. The business appears in Administration → Businesses, where stores
          and people are added. This is SMA’s customer, not a store customer of a business.
        </Alert>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Business name"
            required
            value={business.name}
            onChange={(e) => setBusiness({ name: e.target.value, slug: slugify(e.target.value) })}
          />
          <TextField
            label="Short name"
            hint="Lowercase letters, numbers and dashes"
            required
            value={business.slug}
            onChange={(e) => setBusiness({ ...business, slug: e.target.value })}
          />
        </div>
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-1 font-bold">Their business admin (optional)</legend>
          <p className="text-sm text-muted sm:col-span-2">
            Creates the customer’s first admin account. Leave username and password empty to add one
            later.
          </p>
          <TextField
            label="Full name"
            value={admin.displayName}
            onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })}
          />
          <TextField
            label="Username"
            hint="No spaces"
            autoCapitalize="none"
            value={admin.username}
            onChange={(e) => setAdmin({ ...admin, username: e.target.value.replace(/\s/g, '') })}
          />
          <TextField
            label="Email"
            type="email"
            value={admin.email}
            onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={admin.password}
            onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
          />
        </fieldset>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={convert.isPending}
            icon={<BadgeCheck className="size-5" aria-hidden />}
          >
            Create SMA customer
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function OwnerBadge({ name }: { name: string | null }) {
  return name ? (
    <span className="inline-flex items-center gap-1.5">
      <Avatar name={name} size={22} />
      <span className="truncate text-xs">{name}</span>
    </span>
  ) : (
    <span className="text-xs font-semibold text-warning">Unassigned</span>
  );
}
