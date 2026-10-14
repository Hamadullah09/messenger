'use client';

import {
  LEAD_DIRECTIONS,
  LEAD_SOURCES,
  LEAD_STAGES,
  OPEN_LEAD_STAGES,
  STUCK_AFTER_DAYS_IDLE,
  STUCK_AFTER_DAYS_IN_STAGE,
  type LeadDirection,
  type LeadDto,
  type LeadSource,
  type LeadStage,
  type SalesContextDto,
  type SalesOverviewDto,
  type SalesUserDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownUp,
  BadgeCheck,
  BarChart3,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  Download,
  FileText,
  Globe,
  Kanban,
  List,
  Mail,
  MessageCircle,
  Package,
  PhoneCall,
  Plus,
  Receipt,
  Search,
  Target,
  TrendingUp,
  Trophy,
  Upload,
  UserPlus,
  Users,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  CrmCustomersTab,
  DealsTab,
  InvoicesTab,
  RevenueStrip,
  ServicesTab,
  TargetsTab,
  WebsiteFormDialog,
} from '@/components/sales/crm';
import {
  CrmSettingsTab,
  LeadImportDialog,
  QuotesTab,
  SubscriptionsTab,
} from '@/components/sales/crm-more';
import { AgendaTab } from '@/components/sales/agenda';
import { LeadFormDialog } from '@/components/sales/lead-form';
import { LeadPanel, OwnerBadge, StageChip } from '@/components/sales/lead-panel';
import {
  DIRECTION_LABEL,
  FOLLOW_UP_LABEL,
  money,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SOURCE_LABEL,
  STAGE_LABEL,
  STAGE_TONE,
} from '@/components/sales/labels';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { formatDay, formatRelativeShort } from '@/lib/format';

type Tab =
  | 'overview'
  | 'pipeline'
  | 'leads'
  | 'deals'
  | 'customers'
  | 'invoices'
  | 'quotes'
  | 'billing'
  | 'today'
  | 'targets'
  | 'services'
  | 'settings'
  | 'team';
const TABS: Array<{ key: Tab; label: string; Icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', Icon: BarChart3 },
  { key: 'today', label: 'Today', Icon: CalendarCheck },
  { key: 'pipeline', label: 'Pipeline', Icon: Kanban },
  { key: 'leads', label: 'Leads', Icon: List },
  { key: 'deals', label: 'Deals', Icon: Briefcase },
  { key: 'customers', label: 'Customers', Icon: BadgeCheck },
  { key: 'quotes', label: 'Quotes', Icon: FileText },
  { key: 'invoices', label: 'Invoices', Icon: Receipt },
  { key: 'billing', label: 'Monthly billing', Icon: CalendarClock },
  { key: 'targets', label: 'Targets', Icon: Trophy },
  { key: 'services', label: 'Services', Icon: Package },
  { key: 'settings', label: 'CRM settings', Icon: Settings2 },
  { key: 'team', label: 'Team', Icon: Users },
];

function SalesScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useAuth((s) => s.me)!;
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview') as Tab;
  const [creating, setCreating] = useState(false);
  const [websiteForm, setWebsiteForm] = useState(false);
  const [importing, setImporting] = useState(false);
  // ?lead=<id> (e.g. from a reminder) opens that lead.
  const [openLead, setOpenLead] = useState<string | null>(params.get('lead'));
  const leadParam = params.get('lead');
  useEffect(() => {
    if (leadParam) setOpenLead(leadParam);
  }, [leadParam]);
  // Each business has its own CRM: switching business drops what was loaded for the last one.
  const activeBusinessId = useAuth((s) => s.activeBusinessId);
  const queryClient = useQueryClient();
  const shownFor = useRef(activeBusinessId);
  useEffect(() => {
    if (shownFor.current === activeBusinessId) return;
    shownFor.current = activeBusinessId;
    setOpenLead(null);
    void queryClient.resetQueries({
      predicate: (q) =>
        ['sales-context', 'sales-team', 'sales-overview', 'crm', 'lead', 'leads', 'lead-duplicates'].includes(
          String(q.queryKey[0]),
        ),
    });
  }, [activeBusinessId, queryClient]);
  const context = useQuery({
    queryKey: ['sales-context'],
    queryFn: () => api<SalesContextDto>('/sales/context'),
  });
  const team = useQuery({
    queryKey: ['sales-team'],
    queryFn: () => api<SalesUserDto[]>('/sales/team'),
    enabled: context.isSuccess,
  });

  if (context.isPending) return <Spinner label="Opening Sales" />;
  if (context.isError)
    return (
      <div className="p-6">
        <Alert tone="error" title="Sales & Marketing is not available">
          {errorMessage(context.error)}
        </Alert>
      </div>
    );
  const ctx = context.data;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title={ctx.platformTeam ? 'Sales & Marketing' : `Sales & Marketing · ${ctx.businessName}`}
          subtitle={
            ctx.platformTeam
              ? 'Leads for SMA, from first contact to SMA customer. Store customers of a business are not part of this.'
              : `${ctx.businessName}’s own leads, deals, quotes, invoices and customers. Only your business sees them.`
          }
          actions={
            <>
              {ctx.teamGroupId && (
                <Link
                  href={`/chats?c=${ctx.teamGroupId}`}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-strong/60 bg-surface px-4 font-semibold hover:bg-surface-2"
                >
                  <MessageCircle className="size-5" aria-hidden /> Team chat
                </Link>
              )}
              <Button
                variant="secondary"
                onClick={() => setImporting(true)}
                icon={<Upload className="size-5" aria-hidden />}
              >
                Import
              </Button>
              <Button
                variant="secondary"
                onClick={() => setWebsiteForm(true)}
                icon={<Globe className="size-5" aria-hidden />}
              >
                Website form
              </Button>
              <Button
                onClick={() => setCreating(true)}
                icon={<Plus className="size-5" aria-hidden />}
              >
                New lead
              </Button>
            </>
          }
        />
        <div
          role="tablist"
          aria-label="Sales sections"
          className="scroll-thin flex gap-1 overflow-x-auto border-b border-line"
        >
          {TABS.filter((t) => t.key !== 'team' || ctx.canManageTeam || ctx.canSeeAll).map(
            ({ key, label, Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => router.replace(`/sales?tab=${key}`)}
                className={cx(
                  'relative flex min-h-12 items-center gap-2 px-4 font-semibold whitespace-nowrap',
                  tab === key ? 'text-brand' : 'text-muted hover:text-fg',
                )}
              >
                <Icon className="size-5" aria-hidden /> {label}
                {tab === key && (
                  <span
                    className="absolute right-3 bottom-0 left-3 h-0.5 rounded-full bg-brand"
                    aria-hidden
                  />
                )}
              </button>
            ),
          )}
        </div>
        <div role="tabpanel">
          {tab === 'overview' && (
            <div className="flex flex-col gap-6">
              <RevenueStrip myId={me.user.id} />
              <Overview context={ctx} onOpen={setOpenLead} />
            </div>
          )}
          {tab === 'today' && <AgendaTab context={ctx} onOpenLead={setOpenLead} />}
          {tab === 'pipeline' && <Pipeline context={ctx} onOpen={setOpenLead} />}
          {tab === 'leads' && <Leads context={ctx} team={team.data ?? []} onOpen={setOpenLead} />}
          {tab === 'deals' && <DealsTab context={ctx} team={team.data ?? []} />}
          {tab === 'customers' && (
            <Customers context={ctx} team={team.data ?? []} onOpen={setOpenLead} />
          )}
          {tab === 'invoices' && <InvoicesTab />}
          {tab === 'quotes' && <QuotesTab />}
          {tab === 'billing' && <SubscriptionsTab />}
          {tab === 'settings' && <CrmSettingsTab />}
          {tab === 'targets' && <TargetsTab />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'team' && <TeamTab context={ctx} team={team.data} loading={team.isLoading} />}
        </div>
      </div>
      {creating && (
        <LeadFormDialog
          team={team.data ?? []}
          canAssign={ctx.canAssign}
          onClose={() => setCreating(false)}
          onSaved={(lead) => {
            setCreating(false);
            setOpenLead(lead.id);
          }}
        />
      )}
      {websiteForm && <WebsiteFormDialog context={ctx} onClose={() => setWebsiteForm(false)} />}
      {importing && (
        <LeadImportDialog
          team={team.data ?? []}
          canAssign={ctx.canAssign}
          onClose={() => setImporting(false)}
        />
      )}
      {openLead && (
        <LeadPanel
          leadId={openLead}
          context={ctx}
          team={team.data ?? []}
          myId={me.user.id}
          onClose={() => setOpenLead(null)}
        />
      )}
    </div>
  );
}

export default function SalesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SalesScreen />
    </Suspense>
  );
}

function useLeads(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ['leads', params],
    queryFn: () => api<LeadDto[]>('/sales/leads', { query: params }),
  });
}

// ───────────────────────────── Overview ─────────────────────────────

function Tile({
  Icon,
  label,
  value,
  hint,
  tone = 'brand',
}: {
  Icon: LucideIcon;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'brand' | 'success' | 'warn';
}) {
  const tones = {
    brand: 'bg-brand-soft text-brand-strong',
    success: 'bg-success-soft text-success',
    warn: 'bg-warning-surface text-warning',
  };
  return (
    <div className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <span
        className={cx('inline-flex size-11 items-center justify-center rounded-2xl', tones[tone])}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function Overview({ context, onOpen }: { context: SalesContextDto; onOpen: (id: string) => void }) {
  const overview = useQuery({
    queryKey: ['sales-overview'],
    queryFn: () => api<SalesOverviewDto>('/sales/overview'),
  });
  const due = useLeads({ open: 'true', ownerId: context.canSeeAll ? undefined : 'me' });
  if (overview.isPending) return <Spinner label="Loading numbers" />;
  if (overview.isError) return <Alert tone="error">{errorMessage(overview.error)}</Alert>;
  const o = overview.data;
  const funnel = LEAD_STAGES.filter((s) => s !== 'LOST');
  const max = Math.max(1, ...funnel.map((s) => o.byStage[s]));
  const followUps = (due.data ?? [])
    .filter(
      (l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) <= new Date(Date.now() + 86_400_000),
    )
    .sort((a, b) => Date.parse(a.nextFollowUpAt!) - Date.parse(b.nextFollowUpAt!))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-5">
      {!context.canSeeAll && (
        <p className="text-sm text-muted">Showing your leads and the unassigned queue.</p>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          Icon={Target}
          label="Open leads"
          value={OPEN_LEAD_STAGES.reduce((n, s) => n + o.byStage[s], 0)}
          hint={`${o.newThisWeek} new this week`}
        />
        <Tile
          Icon={TrendingUp}
          label="Open pipeline / month"
          value={money(o.openPipelineValue)}
          hint="Expected monthly value"
        />
        <Tile
          Icon={BadgeCheck}
          label="Won this month"
          value={o.wonThisMonth}
          hint={money(o.wonValueThisMonth)}
          tone="success"
        />
        <Tile
          Icon={CalendarClock}
          label="Follow-ups due"
          value={o.followUpsDue}
          hint={
            o.winRate === null ? 'No closed leads yet' : `Win rate ${Math.round(o.winRate * 100)}%`
          }
          tone={o.followUpsDue > 0 ? 'warn' : 'brand'}
        />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          Icon={AlertTriangle}
          label="Stuck leads"
          value={o.stuck}
          hint={`No move for ${STUCK_AFTER_DAYS_IN_STAGE} days or idle ${STUCK_AFTER_DAYS_IDLE} days`}
          tone={o.stuck > 0 ? 'warn' : 'brand'}
        />
        <Tile Icon={PhoneCall} label="Calls logged" value={o.callsLogged} />
        <Tile
          Icon={Mail}
          label="Messages logged"
          value={o.messagesLogged}
          hint="Email and WhatsApp"
        />
        <Tile
          Icon={ArrowDownUp}
          label="Inbound / outbound"
          value={`${o.byDirection.INBOUND.total} / ${o.byDirection.OUTBOUND.total}`}
          hint={`Won ${o.byDirection.INBOUND.won} / ${o.byDirection.OUTBOUND.won}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card lg:col-span-3">
          <h2 className="mb-4 text-lg font-bold">Funnel</h2>
          <ol className="flex flex-col gap-2.5">
            {funnel.map((s) => (
              <li key={s} className="grid grid-cols-[8.5rem_1fr_3rem] items-center gap-3">
                <span className="text-sm font-semibold">{STAGE_LABEL[s]}</span>
                <span className="h-7 overflow-hidden rounded-lg bg-surface-2">
                  <span
                    className={cx('block h-full rounded-lg', STAGE_TONE[s].dot)}
                    style={{ width: `${Math.max(2, (o.byStage[s] / max) * 100)}%` }}
                  />
                </span>
                <span className="text-right font-bold tabular-nums">{o.byStage[s]}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-muted">{o.byStage.LOST} lost so far.</p>
        </section>

        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card lg:col-span-2">
          <h2 className="mb-4 text-lg font-bold">Follow-ups (today and overdue)</h2>
          {followUps.length === 0 ? (
            <p className="text-muted">Nothing due. Nice work.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {followUps.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(l.id)}
                    className="flex w-full items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left hover:bg-surface-3"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{l.companyName}</span>
                      <span className="block truncate text-sm text-muted">
                        {FOLLOW_UP_LABEL[l.nextFollowUpKind ?? 'OTHER']} · {l.contactName}
                      </span>
                    </span>
                    <span
                      className={cx(
                        'shrink-0 text-sm font-semibold',
                        new Date(l.nextFollowUpAt!) < new Date() ? 'text-danger' : 'text-muted',
                      )}
                    >
                      {formatRelativeShort(l.nextFollowUpAt!)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <h2 className="mb-3 text-lg font-bold">Where leads come from</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 font-semibold">Source</th>
                <th className="py-1.5 text-right font-semibold">Leads</th>
                <th className="py-1.5 text-right font-semibold">Won</th>
                <th className="py-1.5 text-right font-semibold">Win %</th>
              </tr>
            </thead>
            <tbody>
              {o.bySource.map((s) => (
                <tr key={s.source} className="border-t border-line">
                  <td className="py-2">{SOURCE_LABEL[s.source]}</td>
                  <td className="py-2 text-right tabular-nums">{s.total}</td>
                  <td className="py-2 text-right tabular-nums">{s.won}</td>
                  <td className="py-2 text-right tabular-nums">
                    {Math.round((s.won / Math.max(1, s.total)) * 100)}%
                  </td>
                </tr>
              ))}
              {o.bySource.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-muted">
                    No leads yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
          <h2 className="mb-3 text-lg font-bold">By person</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 font-semibold">Owner</th>
                <th className="py-1.5 text-right font-semibold">Open</th>
                <th className="py-1.5 text-right font-semibold">Won</th>
                <th className="py-1.5 text-right font-semibold">Lost</th>
              </tr>
            </thead>
            <tbody>
              {o.byOwner.map((r) => (
                <tr key={r.owner?.id ?? 'none'} className="border-t border-line">
                  <td className="py-2">
                    <OwnerBadge name={r.owner?.displayName ?? null} />
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.open}</td>
                  <td className="py-2 text-right tabular-nums">{r.won}</td>
                  <td className="py-2 text-right tabular-nums">{r.lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

// ───────────────────────────── Pipeline (board) ─────────────────────────────

function Pipeline({ context, onOpen }: { context: SalesContextDto; onOpen: (id: string) => void }) {
  const client = useQueryClient();
  const [mineOnly, setMineOnly] = useState(false);
  const leads = useLeads({ ownerId: mineOnly ? 'me' : undefined });
  const [dragging, setDragging] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<LeadDto | null>(null);
  const [reason, setReason] = useState('');
  const move = useMutation({
    mutationFn: ({
      id,
      stage,
      lostReason,
    }: {
      id: string;
      stage: LeadStage;
      lostReason?: string;
    }) => api(`/sales/leads/${id}/stage`, { method: 'PUT', body: { stage, lostReason } }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['leads'] });
      void client.invalidateQueries({ queryKey: ['sales-overview'] });
    },
  });
  const all = leads.data ?? [];
  const drop = (stage: LeadStage) => (e: DragEvent) => {
    e.preventDefault();
    const lead = all.find((l) => l.id === e.dataTransfer.getData('text/plain'));
    setDragging(null);
    if (!lead || lead.stage === stage || lead.customer) return;
    if (stage === 'LOST') {
      setLostFor(lead);
      return;
    }
    move.mutate({ id: lead.id, stage });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Drag a card to another column to move it through the funnel. Open a card to log calls and
          notes.
        </p>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            className="size-4"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />
          Only my leads
        </label>
      </div>
      {move.isError && <Alert tone="error">{errorMessage(move.error)}</Alert>}
      {leads.isLoading && <Spinner label="Loading pipeline" />}
      <div className="scroll-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-3">
        {LEAD_STAGES.map((stage) => {
          const column = all.filter((l) => l.stage === stage);
          const value = column.reduce((n, l) => n + (l.estimatedValue ?? 0), 0);
          return (
            <section
              key={stage}
              aria-label={STAGE_LABEL[stage]}
              onDragOver={(e) => e.preventDefault()}
              onDrop={drop(stage)}
              className={cx(
                'flex w-72 shrink-0 flex-col rounded-2xl border bg-surface-2/70 transition-colors',
                dragging ? 'border-dashed border-brand/40' : 'border-line',
              )}
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className={cx('size-2.5 rounded-full', STAGE_TONE[stage].dot)} aria-hidden />
                <h3 className="flex-1 font-bold">{STAGE_LABEL[stage]}</h3>
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-bold tabular-nums">
                  {column.length}
                </span>
              </header>
              <p className="px-3 pb-2 text-xs text-muted">{money(value)} / month</p>
              <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
                {column.map((l) => {
                  const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date();
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        draggable={!l.customer}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', l.id);
                          setDragging(l.id);
                        }}
                        onDragEnd={() => setDragging(null)}
                        onClick={() => onOpen(l.id)}
                        className={cx(
                          'w-full rounded-xl border border-line bg-surface p-3 text-left shadow-card transition-shadow hover:border-brand/40',
                          dragging === l.id && 'opacity-50',
                        )}
                      >
                        <p className="truncate font-semibold">{l.companyName}</p>
                        <p className="truncate text-sm text-muted">{l.contactName}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-semibold">
                            {SOURCE_LABEL[l.source]}
                          </span>
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-semibold">
                            {DIRECTION_LABEL[l.direction]}
                          </span>
                          {l.storeCount !== null && (
                            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-semibold">
                              {l.storeCount} stores
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-semibold">
                            <PhoneCall className="size-3" aria-hidden /> {l.callCount}
                          </span>
                          {l.stuck && (
                            <span className="rounded-md bg-danger-surface px-1.5 py-0.5 text-[0.7rem] font-bold text-danger">
                              Stuck {l.daysInStage}d
                            </span>
                          )}
                          {l.customer && (
                            <span className="rounded-md bg-success-soft px-1.5 py-0.5 text-[0.7rem] font-bold text-success">
                              Customer
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <OwnerBadge name={l.owner?.displayName ?? null} />
                          <span className="text-xs font-semibold tabular-nums">
                            {money(l.estimatedValue, l.currency)}
                          </span>
                        </div>
                        {l.nextFollowUpAt && (
                          <p
                            className={cx(
                              'mt-1.5 flex items-center gap-1 text-xs font-semibold',
                              overdue ? 'text-danger' : 'text-muted',
                            )}
                          >
                            <CalendarClock className="size-3.5" aria-hidden />
                            {overdue ? 'Overdue · ' : ''}
                            {formatDay(l.nextFollowUpAt)}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
                {column.length === 0 && (
                  <li className="rounded-xl border-2 border-dashed border-line p-4 text-center text-xs text-muted">
                    Drop leads here
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
      {!context.canSeeAll && (
        <p className="text-sm text-muted">You see your leads and the unassigned queue.</p>
      )}
      <Dialog
        open={!!lostFor}
        onClose={() => setLostFor(null)}
        title={`Mark ${lostFor?.companyName ?? ''} as lost`}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (lostFor) move.mutate({ id: lostFor.id, stage: 'LOST', lostReason: reason });
            setLostFor(null);
            setReason('');
          }}
        >
          <TextField
            label="Why was it lost?"
            placeholder="e.g. Chose a competitor, no budget"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" variant="danger" disabled={!reason.trim()}>
            Mark as lost
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

// ───────────────────────────── Leads (table) ─────────────────────────────

function Leads({
  context,
  team,
  onOpen,
}: {
  context: SalesContextDto;
  team: SalesUserDto[];
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<LeadStage | ''>('');
  const [source, setSource] = useState<LeadSource | ''>('');
  const [owner, setOwner] = useState('');
  const [stuckOnly, setStuckOnly] = useState(false);
  const [direction, setDirection] = useState<LeadDirection | ''>('');
  const leads = useLeads({
    q: q.trim() || undefined,
    stage: stage || undefined,
    source: source || undefined,
    ownerId: owner || undefined,
    direction: direction || undefined,
    stuck: stuckOnly ? 'true' : undefined,
  });
  const exporting = useMutation({
    mutationFn: () => downloadFile('/sales/leads-export.csv', 'sma-leads.csv'),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative min-w-60 flex-1">
          <span className="mb-1.5 block font-semibold">Search</span>
          <Search
            className="pointer-events-none absolute bottom-3.5 left-3 size-5 text-muted"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Company, contact, phone, email or city"
            className="min-h-12 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-10"
          />
        </label>
        <SelectField
          label="Stage"
          value={stage}
          onChange={(e) => setStage(e.target.value as LeadStage | '')}
        >
          <option value="">All stages</option>
          {LEAD_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value as LeadSource | '')}
        >
          <option value="">All sources</option>
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="In / out"
          value={direction}
          onChange={(e) => setDirection(e.target.value as LeadDirection | '')}
        >
          <option value="">Both</option>
          {LEAD_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABEL[d]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone{context.canSeeAll ? '' : ' I can see'}</option>
          <option value="me">My leads</option>
          <option value="unassigned">Unassigned queue</option>
          {context.canSeeAll &&
            team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
        </SelectField>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="size-4"
            checked={stuckOnly}
            onChange={(e) => setStuckOnly(e.target.checked)}
          />
          Only stuck leads
        </label>
        <span className="flex-1" />
        {context.canSeeAll && (
          <Button
            variant="secondary"
            size="sm"
            busy={exporting.isPending}
            icon={<Download className="size-4" aria-hidden />}
            onClick={() => exporting.mutate()}
          >
            Export all leads (CSV)
          </Button>
        )}
      </div>
      {exporting.isError && <Alert tone="error">{errorMessage(exporting.error)}</Alert>}
      {leads.isLoading && <Spinner label="Loading leads" />}
      {leads.isError && <Alert tone="error">{errorMessage(leads.error)}</Alert>}
      {leads.data?.length === 0 && (
        <EmptyState icon={<Target className="size-9" aria-hidden />} title="No leads match">
          Try another filter, or add a lead with New lead.
        </EmptyState>
      )}
      {!!leads.data?.length && (
        <div className="scroll-thin overflow-x-auto rounded-3xl border border-line bg-surface shadow-card">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="p-3 font-semibold">Company</th>
                <th className="p-3 font-semibold">Contact</th>
                <th className="p-3 font-semibold">Stage</th>
                <th className="p-3 font-semibold">Source</th>
                <th className="p-3 text-right font-semibold">Calls</th>
                <th className="p-3 font-semibold">Last response</th>
                <th className="p-3 font-semibold">Owner</th>
                <th className="p-3 text-right font-semibold">Value / month</th>
                <th className="p-3 font-semibold">Follow-up</th>
                <th className="p-3 font-semibold">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {leads.data.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => onOpen(l.id)}
                  className="cursor-pointer border-t border-line hover:bg-surface-2"
                >
                  <td className="p-3">
                    <button
                      type="button"
                      className="text-left font-semibold hover:underline"
                      onClick={() => onOpen(l.id)}
                    >
                      {l.companyName}
                    </button>
                    {l.city && <span className="block text-xs text-muted">{l.city}</span>}
                  </td>
                  <td className="p-3">
                    {l.contactName}
                    {l.phone && <span className="block text-xs text-muted">{l.phone}</span>}
                  </td>
                  <td className="p-3">
                    <StageChip stage={l.stage} />
                    {l.stuck && (
                      <span className="mt-1 block text-xs font-bold text-danger">
                        Stuck · {l.daysInStage} days
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {SOURCE_LABEL[l.source]}
                    <span className="block text-xs text-muted">{DIRECTION_LABEL[l.direction]}</span>
                  </td>
                  <td className="p-3 text-right tabular-nums">{l.callCount}</td>
                  <td
                    className={cx(
                      'p-3',
                      l.lastOutcome ? OUTCOME_TONE[l.lastOutcome] : 'text-muted',
                    )}
                  >
                    {l.lastOutcome ? OUTCOME_LABEL[l.lastOutcome] : '—'}
                  </td>
                  <td className="p-3">
                    <OwnerBadge name={l.owner?.displayName ?? null} />
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {money(l.estimatedValue, l.currency)}
                  </td>
                  <td
                    className={cx(
                      'p-3',
                      l.nextFollowUpAt &&
                        new Date(l.nextFollowUpAt) < new Date() &&
                        'font-semibold text-danger',
                    )}
                  >
                    {l.nextFollowUpAt ? formatDay(l.nextFollowUpAt) : '—'}
                  </td>
                  <td className="p-3 text-muted">{formatRelativeShort(l.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Customers ─────────────────────────────

function Customers({
  context,
  team,
  onOpen,
}: {
  context: SalesContextDto;
  team: SalesUserDto[];
  onOpen: (id: string) => void;
}) {
  const won = useLeads({ stage: 'WON' });
  const exporting = useMutation({
    mutationFn: () => downloadFile('/sales/leads-export.csv?customers=true', 'customers.csv'),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted">
          {context.platformTeam
            ? 'Businesses that buy SMA: what they bought, paid and owe. Use Upsell to sell them more.'
            : 'Your won leads: what they bought, paid and owe. Use Upsell to sell them more.'}
        </p>
        {context.canSeeAll && (
          <Button
            variant="secondary"
            size="sm"
            busy={exporting.isPending}
            icon={<Download className="size-4" aria-hidden />}
            onClick={() => exporting.mutate()}
          >
            Export (CSV)
          </Button>
        )}
      </div>
      <CrmCustomersTab
        context={context}
        team={team}
        wonNotSetUp={(won.data ?? []).filter((l) => !l.customer)}
        onOpenLead={onOpen}
      />
    </div>
  );
}

// ───────────────────────────── Team ─────────────────────────────

function TeamTab({
  context,
  team,
  loading,
}: {
  context: SalesContextDto;
  team: SalesUserDto[] | undefined;
  loading: boolean;
}) {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    email: '',
    password: '',
    roleKey: 'SALES_AGENT' as 'SALES_AGENT' | 'SALES_MANAGER',
  });
  const add = useMutation({
    mutationFn: () =>
      api<SalesUserDto[]>('/sales/team', {
        method: 'POST',
        body: { ...form, username: form.username.trim().toLowerCase(), email: form.email.trim() },
      }),
    onSuccess: (data) => {
      client.setQueryData(['sales-team'], data);
      setAdding(false);
      setForm({ displayName: '', username: '', email: '', password: '', roleKey: 'SALES_AGENT' });
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-muted">
          Sales & Marketing people only see this module and the sales team chats. They have no
          access to customer businesses, their stores or their chats.
        </p>
        {context.canManageTeam && (
          <Button
            onClick={() => setAdding(true)}
            icon={<UserPlus className="size-5" aria-hidden />}
          >
            Add sales person
          </Button>
        )}
      </div>
      {loading && <Spinner label="Loading team" />}
      {team?.length === 0 && (
        <EmptyState icon={<Users className="size-9" aria-hidden />} title="No sales people yet">
          Add the first Sales Manager or Sales Agent.
        </EmptyState>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {team?.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
          >
            <Avatar name={p.displayName} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{p.displayName}</p>
              <p className="truncate text-sm text-muted">
                @{p.username} ·{' '}
                {p.roleKey === 'SALES_MANAGER'
                  ? 'Sales Manager'
                  : p.roleKey === 'BUSINESS_OWNER'
                    ? 'Business Owner'
                    : p.roleKey === 'BUSINESS_ADMIN'
                      ? 'Business Admin'
                      : 'Sales Agent'}
              </p>
            </div>
            <div className="text-right text-sm">
              <p>
                <span className="font-bold tabular-nums">{p.openLeads}</span> open
              </p>
              <p className="text-success">
                <span className="font-bold tabular-nums">{p.wonLeads}</span> won
              </p>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a sales person" wide>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          {add.isError && <Alert tone="error">{errorMessage(add.error)}</Alert>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Full name"
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <TextField
              label="Username"
              hint="Used to sign in. No spaces."
              required
              autoCapitalize="none"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.replace(/\s/g, '') })}
            />
            <TextField
              label="Email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <SelectField
              label="Role"
              value={form.roleKey}
              onChange={(e) => setForm({ ...form, roleKey: e.target.value as typeof form.roleKey })}
            >
              <option value="SALES_AGENT">Sales Agent: own leads and the unassigned queue</option>
              <option value="SALES_MANAGER">
                Sales Manager: all leads, team, reports, conversions
              </option>
            </SelectField>
          </div>
          <p className="text-sm text-muted">
            They join the “Sales & Marketing team” chat automatically.
          </p>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={add.isPending}>
              Add sales person
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
