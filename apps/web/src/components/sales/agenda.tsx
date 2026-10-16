'use client';

import {
  ACTIVITY_OUTCOMES,
  type ActivityOutcome,
  type FollowUpKind,
  type LeadDetailDto,
  type LeadDto,
  type SalesContextDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  CalendarCheck,
  CheckCircle2,
  MessageCircle,
  Phone,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  cx,
  Dialog,
  EmptyState,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDay, formatTime } from '@/lib/format';
import { FOLLOW_UP_ACTIVITY, FOLLOW_UP_LABEL, OUTCOME_LABEL } from './labels';
import { FOLLOW_UP_ICON, FollowUpKindField } from './follow-up';
import { OwnerBadge, StageChip } from './lead-panel';

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Digits for a wa.me link (Pakistani numbers given as 03… become 923…). */
function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits;
}

/** Today's (and this week's) meetings, calls and other follow-ups with leads and customers. */
export function AgendaTab({
  context,
  onOpenLead,
}: {
  context: SalesContextDto;
  onOpenLead: (id: string) => void;
}) {
  const [range, setRange] = useState<'today' | 'week'>('today');
  const [mine, setMine] = useState(!context.canSeeAll);
  const [doneFor, setDoneFor] = useState<LeadDto | null>(null);
  // The day boundaries are the viewer's own (their phone's time zone).
  const today = startOfDay(new Date());
  const until = new Date(today.getTime() + (range === 'today' ? 1 : 7) * 86_400_000 - 1);
  const agenda = useQuery({
    queryKey: ['leads', 'agenda', { range, mine, day: today.toISOString() }],
    queryFn: () =>
      api<LeadDto[]>('/sales/agenda', {
        query: { until: until.toISOString(), mine: String(mine) },
      }),
    refetchInterval: 60_000,
  });

  const groups = useMemo(() => {
    const rows = agenda.data ?? [];
    const overdue = rows.filter((l) => new Date(l.nextFollowUpAt!) < today);
    const byDay = new Map<string, { date: Date; items: LeadDto[] }>();
    for (const l of rows) {
      const at = new Date(l.nextFollowUpAt!);
      if (at < today) continue;
      const key = dayKey(at);
      const group = byDay.get(key) ?? { date: startOfDay(at), items: [] };
      group.items.push(l);
      byDay.set(key, group);
    }
    return { overdue, days: [...byDay.values()] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenda.data, today.getTime()]);

  const todays = groups.days.find((g) => dayKey(g.date) === dayKey(today))?.items ?? [];
  const meetingsToday = todays.filter(
    (l) => l.nextFollowUpKind === 'MEETING' || l.nextFollowUpKind === 'VISIT',
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Show" className="flex rounded-xl bg-surface-2 p-1">
          {(
            [
              ['today', 'Today'],
              ['week', 'Next 7 days'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={range === key}
              onClick={() => setRange(key)}
              className={cx(
                'min-h-10 rounded-lg px-4 text-sm font-semibold',
                range === key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {context.canSeeAll && (
          <div role="radiogroup" aria-label="Whose" className="flex rounded-xl bg-surface-2 p-1">
            {(
              [
                [true, 'Mine'],
                [false, 'Everyone'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={mine === value}
                onClick={() => setMine(value)}
                className={cx(
                  'min-h-10 rounded-lg px-4 text-sm font-semibold',
                  mine === value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <SummaryTile label="Today" value={todays.length} Icon={CalendarCheck} />
        <SummaryTile label="Meetings and visits today" value={meetingsToday} Icon={Users} />
        <SummaryTile
          label="Overdue"
          value={groups.overdue.length}
          Icon={AlarmClock}
          warn={groups.overdue.length > 0}
          onClick={
            groups.overdue.length > 0
              ? () =>
                  document
                    .getElementById('agenda-overdue')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              : undefined
          }
        />
      </div>

      {agenda.isPending && <Spinner label="Loading follow-ups" />}
      {agenda.isError && <Alert tone="error">{errorMessage(agenda.error)}</Alert>}
      {agenda.isSuccess && agenda.data.length === 0 && (
        <EmptyState
          icon={<CalendarCheck className="size-9" aria-hidden />}
          title={range === 'today' ? 'Nothing planned for today' : 'Nothing planned this week'}
        >
          Plan the next meeting or call when you log an activity on a lead, and it shows up here.
        </EmptyState>
      )}

      {agenda.isSuccess && todays.length === 0 && groups.overdue.length > 0 && (
        <p className="rounded-2xl border border-line bg-surface p-4 text-muted shadow-card">
          Nothing planned for today. {groups.overdue.length} follow-up
          {groups.overdue.length === 1 ? ' from an earlier day is' : 's from earlier days are'}{' '}
          still waiting below.
        </p>
      )}
      {groups.days.map((g) => (
        <AgendaGroup
          key={dayKey(g.date)}
          title={dayKey(g.date) === dayKey(today) ? 'Today' : formatDay(g.date.toISOString())}
          items={g.items}
          showOwner={!mine}
          onOpen={onOpenLead}
          onDone={setDoneFor}
        />
      ))}
      {groups.overdue.length > 0 && (
        <AgendaGroup
          id="agenda-overdue"
          title="Overdue · from earlier days"
          tone="danger"
          items={groups.overdue}
          showDate
          showOwner={!mine}
          onOpen={onOpenLead}
          onDone={setDoneFor}
        />
      )}

      {doneFor && <FollowUpDoneDialog lead={doneFor} onClose={() => setDoneFor(null)} />}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  Icon,
  warn,
  onClick,
}: {
  label: string;
  value: number;
  Icon: LucideIcon;
  warn?: boolean;
  /** Overdue: jumps to the overdue list further down. */
  onClick?: () => void;
}) {
  const Box = onClick ? 'button' : 'div';
  return (
    <Box
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cx(
        'rounded-2xl border border-line bg-surface p-3 text-left shadow-card sm:p-4',
        onClick && 'hover:border-danger/50',
      )}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted sm:text-sm">
        <Icon className="size-4 shrink-0" aria-hidden /> {label}
      </p>
      <p className={cx('mt-1 text-2xl font-bold tabular-nums sm:text-3xl', warn && 'text-danger')}>
        {value}
      </p>
    </Box>
  );
}

function AgendaGroup({
  id,
  title,
  tone,
  items,
  showDate,
  showOwner,
  onOpen,
  onDone,
}: {
  id?: string;
  title: string;
  tone?: 'danger';
  items: LeadDto[];
  showDate?: boolean;
  showOwner: boolean;
  onOpen: (id: string) => void;
  onDone: (lead: LeadDto) => void;
}) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-2">
      <h2 className={cx('text-lg font-bold', tone === 'danger' && 'text-danger')}>
        {title} <span className="text-sm font-semibold text-muted">· {items.length}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((l) => {
          const kind = l.nextFollowUpKind ?? 'OTHER';
          const Icon = FOLLOW_UP_ICON[kind];
          return (
            <li
              key={l.id}
              className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:items-center"
            >
              <button
                type="button"
                onClick={() => onOpen(l.id)}
                className="flex min-w-0 flex-1 items-start gap-3 text-left"
              >
                <span className="flex w-16 shrink-0 flex-col items-center rounded-xl bg-surface-2 py-2">
                  <Icon
                    className={cx('size-5', tone === 'danger' ? 'text-danger' : 'text-brand')}
                    aria-hidden
                  />
                  <span className="mt-1 text-sm font-bold tabular-nums">
                    {formatTime(l.nextFollowUpAt!)}
                  </span>
                  {showDate && (
                    <span className="text-xs text-muted">{formatDay(l.nextFollowUpAt!)}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{FOLLOW_UP_LABEL[kind]}</span>
                    <span className="truncate font-semibold">· {l.companyName}</span>
                    <StageChip stage={l.stage} />
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {l.contactName}
                    {l.phone ? ` · ${l.phone}` : ''}
                  </span>
                  {l.nextFollowUpNote && (
                    <span className="mt-0.5 block text-sm">{l.nextFollowUpNote}</span>
                  )}
                  {showOwner && (
                    <span className="mt-1 block text-sm">
                      <OwnerBadge name={l.owner?.displayName ?? null} />
                    </span>
                  )}
                </span>
              </button>
              <div className="flex shrink-0 flex-wrap gap-2">
                {l.phone && (
                  <a
                    href={`tel:${l.phone}`}
                    aria-label={`Call ${l.contactName}`}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-strong/60 px-3 text-sm font-semibold hover:bg-surface-2"
                  >
                    <Phone className="size-4" aria-hidden /> Call
                  </a>
                )}
                {l.phone && (
                  <a
                    href={`https://wa.me/${whatsappNumber(l.phone)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`WhatsApp ${l.contactName}`}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-strong/60 px-3 text-sm font-semibold hover:bg-surface-2"
                  >
                    <MessageCircle className="size-4" aria-hidden /> WhatsApp
                  </a>
                )}
                <Button
                  size="sm"
                  icon={<CheckCircle2 className="size-4" aria-hidden />}
                  onClick={() => onDone(l)}
                >
                  Done
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Marks a planned follow-up done: logs what happened and, optionally, plans the next one. */
function FollowUpDoneDialog({ lead, onClose }: { lead: LeadDto; onClose: () => void }) {
  const client = useQueryClient();
  const kind = lead.nextFollowUpKind ?? 'OTHER';
  const [body, setBody] = useState('');
  const [outcome, setOutcome] = useState<ActivityOutcome | ''>('');
  const [next, setNext] = useState('');
  const [nextKind, setNextKind] = useState<FollowUpKind | ''>('');
  const [nextNote, setNextNote] = useState('');
  const activity = FOLLOW_UP_ACTIVITY[kind];
  const save = useMutation({
    mutationFn: () =>
      api<LeadDetailDto>(`/sales/leads/${lead.id}/activities`, {
        method: 'POST',
        body: {
          type: activity,
          body: body.trim(),
          ...(outcome && activity !== 'NOTE' ? { outcome } : {}),
          completeFollowUp: true,
          ...(next
            ? {
                nextFollowUpAt: new Date(next).toISOString(),
                nextFollowUpKind: nextKind || null,
                nextFollowUpNote: nextNote.trim() || null,
              }
            : {}),
        },
      }),
    onSuccess: (data) => {
      client.setQueryData(['lead', lead.id], data);
      void client.invalidateQueries({ queryKey: ['leads'] });
      void client.invalidateQueries({ queryKey: ['sales-overview'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`${FOLLOW_UP_LABEL[kind]} done · ${lead.companyName}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <TextArea
          label="What happened?"
          required
          rows={3}
          maxLength={2000}
          placeholder="e.g. Met the owner, they want a price for 3 stores"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {activity !== 'NOTE' && (
          <SelectField
            label="Their response"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as ActivityOutcome | '')}
          >
            <option value="">Not recorded</option>
            {ACTIVITY_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </SelectField>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Next follow-up (optional)"
            type="datetime-local"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          {next && <FollowUpKindField value={nextKind} onChange={setNextKind} />}
        </div>
        {next && (
          <TextField
            label="Note for the next one (optional)"
            maxLength={300}
            placeholder="e.g. At their head office, bring the price list"
            value={nextNote}
            onChange={(e) => setNextNote(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!body.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
