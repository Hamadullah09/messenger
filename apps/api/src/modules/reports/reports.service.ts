import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEAD_SOURCES, LEAD_STAGES, type ReportDto, type ReportQuery } from '@storeline/shared';
import ExcelJS from 'exceljs';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

const MAX_DAYS = 366;
/** Gaps longer than this start a new conversation rather than count as a slow reply. */
const REPLY_WINDOW_HOURS = 24;

/**
 * Business reports for Business Owners/Admins/Managers (one business) and the Super Admin
 * (one business or the whole platform, plus SMA's own sales funnel). Only counts and timings:
 * no message content is read.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async authorize(actor: Actor, businessId: string | undefined): Promise<boolean> {
    const coverage = await this.authz.coverage(actor, 'report.read');
    if (businessId) {
      if (!(await this.authz.can(actor, 'report.read', { businessId })))
        throw ApiError.forbidden('You cannot see reports for this business.');
      return coverage.all;
    }
    if (!coverage.all) throw ApiError.forbidden('Choose a business.');
    return true;
  }

  async report(actor: Actor, query: ReportQuery): Promise<ReportDto> {
    const platform = await this.authorize(actor, query.businessId);
    const from = query.from;
    const to = query.to;
    if (to <= from) throw ApiError.validation('The end must be after the start.', 'to');
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000)
      throw ApiError.validation('Choose at most one year.', 'to');
    const businessId = query.businessId ?? null;
    const biz = businessId ? Prisma.sql`AND c."businessId" = ${businessId}::uuid` : Prisma.empty;
    const notInternal = Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = c."businessId" AND b."internal")`;

    const [totals, perDay, byKind, stores, replies] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint; senders: bigint }>>`
        SELECT count(*)::bigint AS total, count(DISTINCT m."senderId")::bigint AS senders
          FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
         WHERE m."createdAt" >= ${from} AND m."createdAt" < ${to}
           AND m."kind" <> 'SYSTEM' ${biz} ${notInternal}`,
      this.prisma.$queryRaw<Array<{ day: string; count: bigint }>>`
        SELECT to_char(date_trunc('day', m."createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               count(*)::bigint AS count
          FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
         WHERE m."createdAt" >= ${from} AND m."createdAt" < ${to}
           AND m."kind" <> 'SYSTEM' ${biz} ${notInternal}
         GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<Array<{ kind: string; count: bigint }>>`
        SELECT m."kind"::text AS kind, count(*)::bigint AS count
          FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
         WHERE m."createdAt" >= ${from} AND m."createdAt" < ${to}
           AND m."kind" <> 'SYSTEM' ${biz} ${notInternal}
         GROUP BY 1 ORDER BY 2 DESC`,
      this.prisma.$queryRaw<Array<{ storeId: string; storeName: string; count: bigint }>>`
        SELECT s."id" AS "storeId", s."name" AS "storeName", count(*)::bigint AS count
          FROM "Message" m
          JOIN "Conversation" c ON c."id" = m."conversationId"
          JOIN "Store" s ON s."id" = c."storeId"
         WHERE m."createdAt" >= ${from} AND m."createdAt" < ${to}
           AND m."kind" <> 'SYSTEM' ${biz}
         GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      // Reply time: a message from someone else after the previous message, within a day.
      this.prisma.$queryRaw<Array<{ median: number | null; within15: number | null }>>`
        WITH ordered AS (
          SELECT m."createdAt", m."senderId",
                 lag(m."createdAt") OVER w AS prev_at,
                 lag(m."senderId") OVER w AS prev_sender
            FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
           WHERE m."createdAt" >= ${from} AND m."createdAt" < ${to}
             AND m."kind" NOT IN ('SYSTEM', 'CALL')
             AND c."type" IN ('DIRECT', 'GROUP') ${biz} ${notInternal}
          WINDOW w AS (PARTITION BY m."conversationId" ORDER BY m."seq")
        ), replies AS (
          SELECT extract(epoch FROM ("createdAt" - prev_at)) / 60.0 AS minutes
            FROM ordered
           WHERE prev_sender IS NOT NULL AND prev_sender <> "senderId"
             AND "createdAt" - prev_at < make_interval(hours => ${REPLY_WINDOW_HOURS}::int)
        )
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median,
               avg(CASE WHEN minutes <= 15 THEN 1.0 ELSE 0.0 END) AS within15
          FROM replies`,
    ]);

    const businessWhere = businessId ? { businessId } : { business: { internal: false } };
    // Store tasks only link to their business through the store.
    const taskWhere = businessId ? { businessId } : { store: { business: { internal: false } } };
    const [incidents, tasksCreated, tasksCompleted, overdue, campaigns, customers] =
      await Promise.all([
        this.prisma.emergencyIncident.findMany({
          where: { ...businessWhere, createdAt: { gte: from, lt: to } },
          select: { createdAt: true, acknowledgedAt: true },
        }),
        this.prisma.storeTask.count({
          where: { ...taskWhere, deletedAt: null, createdAt: { gte: from, lt: to } },
        }),
        this.prisma.storeTask.count({
          where: { ...taskWhere, deletedAt: null, completedAt: { gte: from, lt: to } },
        }),
        this.prisma.storeTask.count({
          where: { ...taskWhere, deletedAt: null, status: 'OPEN', dueAt: { lt: new Date() } },
        }),
        this.prisma.customerCampaign.findMany({
          where: { ...businessWhere, createdAt: { gte: from, lt: to } },
          select: {
            channel: true,
            recipients: { select: { state: true } },
          },
        }),
        Promise.all([
          this.prisma.storeCustomer.count({ where: { ...businessWhere, deletedAt: null } }),
          this.prisma.storeCustomer.count({
            where: { ...businessWhere, deletedAt: null, createdAt: { gte: from, lt: to } },
          }),
          this.prisma.storeCustomer.count({
            where: {
              ...businessWhere,
              deletedAt: null,
              marketingOptIn: true,
              unsubscribedAt: null,
            },
          }),
        ]),
      ]);

    const ackMinutes = incidents
      .filter((i) => i.acknowledgedAt)
      .map((i) => (i.acknowledgedAt!.getTime() - i.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);
    const byChannel = new Map<
      string,
      { channel: string; campaigns: number; sent: number; failed: number }
    >();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const c of campaigns) {
      const row = byChannel.get(c.channel) ?? {
        channel: c.channel,
        campaigns: 0,
        sent: 0,
        failed: 0,
      };
      row.campaigns += 1;
      for (const r of c.recipients) {
        if (r.state === 'SENT') {
          row.sent += 1;
          sent += 1;
        } else if (r.state === 'FAILED') {
          row.failed += 1;
          failed += 1;
        } else if (r.state === 'SKIPPED') skipped += 1;
      }
      byChannel.set(c.channel, row);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      businessId,
      messages: {
        total: Number(totals[0]?.total ?? 0),
        perDay: perDay.map((d) => ({ day: d.day, count: Number(d.count) })),
        byKind: byKind.map((k) => ({ kind: k.kind, count: Number(k.count) })),
        activeSenders: Number(totals[0]?.senders ?? 0),
        medianReplyMinutes:
          replies[0]?.median != null ? Math.round(Number(replies[0].median) * 10) / 10 : null,
        repliedWithin15m: replies[0]?.within15 != null ? Number(replies[0].within15) : null,
        busiestStores: stores.map((s) => ({ ...s, count: Number(s.count) })),
      },
      emergencies: {
        total: incidents.length,
        medianAckMinutes:
          ackMinutes.length > 0
            ? Math.round(ackMinutes[Math.floor((ackMinutes.length - 1) / 2)]! * 10) / 10
            : null,
      },
      tasks: { created: tasksCreated, completed: tasksCompleted, overdueOpen: overdue },
      campaigns: {
        total: campaigns.length,
        sent,
        failed,
        skipped,
        byChannel: [...byChannel.values()],
      },
      customers: { total: customers[0], newInPeriod: customers[1], optedIn: customers[2] },
      // SMA's own sales funnel on the platform report; a business's own funnel on its report.
      leads:
        platform && !businessId
          ? await this.leads(from, to, null)
          : businessId && (await this.authz.can(actor, 'sales.lead.read_all', { businessId }))
            ? await this.leads(from, to, businessId)
            : null,
    };
  }

  private async leads(
    from: Date,
    to: Date,
    businessId: string | null,
  ): Promise<NonNullable<ReportDto['leads']>> {
    const tenant: Prisma.LeadWhereInput = businessId
      ? { tenantId: businessId }
      : { tenant: { internal: true } };
    const [created, closed] = await Promise.all([
      this.prisma.lead.findMany({
        where: { ...tenant, deletedAt: null, createdAt: { gte: from, lt: to } },
        select: { stage: true, source: true },
      }),
      this.prisma.lead.groupBy({
        by: ['stage'],
        where: {
          ...tenant,
          deletedAt: null,
          closedAt: { gte: from, lt: to },
          stage: { in: ['WON', 'LOST'] },
        },
        _count: { _all: true },
      }),
    ]);
    const won = closed.find((c) => c.stage === 'WON')?._count._all ?? 0;
    const lost = closed.find((c) => c.stage === 'LOST')?._count._all ?? 0;
    return {
      created: created.length,
      won,
      lost,
      conversionRate: won + lost > 0 ? won / (won + lost) : null,
      byStage: LEAD_STAGES.map((stage) => ({
        stage,
        count: created.filter((l) => l.stage === stage).length,
      })),
      bySource: LEAD_SOURCES.map((source) => ({
        source,
        count: created.filter((l) => l.source === source).length,
      })).filter((s) => s.count > 0),
    };
  }

  /** The same report as an Excel workbook (one sheet per section). */
  async excel(actor: Actor, query: ReportQuery): Promise<{ buffer: Buffer; fileName: string }> {
    // Exporting is for admins (or people given the export right in a custom role).
    await this.authz.require(
      actor,
      'report.export',
      query.businessId ? { businessId: query.businessId } : null,
    );
    const r = await this.report(actor, query);
    const name = r.businessId
      ? ((
          await this.prisma.business.findUnique({
            where: { id: r.businessId },
            select: { name: true },
          })
        )?.name ?? 'Business')
      : 'SMA platform';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SMA Technology';
    wb.created = new Date();
    const period = `${r.from.slice(0, 10)} to ${new Date(Date.parse(r.to) - 1).toISOString().slice(0, 10)}`;
    const sheet = (
      title: string,
      columns: Array<{ header: string; key: string; width: number }>,
    ) => {
      const ws = wb.addWorksheet(title);
      ws.columns = columns;
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      return ws;
    };

    const summary = sheet('Summary', [
      { header: 'Measure', key: 'k', width: 42 },
      { header: 'Value', key: 'v', width: 22 },
    ]);
    const rows: Array<[string, string | number | null]> = [
      ['Report', name],
      ['Period', period],
      ['Messages sent', r.messages.total],
      ['People who sent messages', r.messages.activeSenders],
      ['Median reply time (minutes)', r.messages.medianReplyMinutes],
      [
        'Replies within 15 minutes',
        r.messages.repliedWithin15m === null
          ? null
          : `${Math.round(r.messages.repliedWithin15m * 100)}%`,
      ],
      ['Emergency alerts', r.emergencies.total],
      ['Median time to acknowledge (minutes)', r.emergencies.medianAckMinutes],
      ['Tasks created', r.tasks.created],
      ['Tasks completed', r.tasks.completed],
      ['Open tasks past due (now)', r.tasks.overdueOpen],
      ['Customer campaigns', r.campaigns.total],
      ['Campaign messages sent', r.campaigns.sent],
      ['Campaign messages failed', r.campaigns.failed],
      ['Store customers', r.customers.total],
      ['New store customers', r.customers.newInPeriod],
      ['Customers who accept marketing', r.customers.optedIn],
    ];
    if (r.leads) {
      rows.push(
        ['Leads created', r.leads.created],
        ['Leads won', r.leads.won],
        ['Leads lost', r.leads.lost],
        [
          'Win rate',
          r.leads.conversionRate === null ? null : `${Math.round(r.leads.conversionRate * 100)}%`,
        ],
      );
    }
    for (const [k, v] of rows) summary.addRow({ k, v: v ?? '—' });

    const perDay = sheet('Messages per day', [
      { header: 'Day', key: 'day', width: 14 },
      { header: 'Messages', key: 'count', width: 12 },
    ]);
    r.messages.perDay.forEach((d) => perDay.addRow(d));
    const kinds = sheet('Message types', [
      { header: 'Type', key: 'kind', width: 16 },
      { header: 'Messages', key: 'count', width: 12 },
    ]);
    r.messages.byKind.forEach((d) => kinds.addRow(d));
    const storesWs = sheet('Busiest stores', [
      { header: 'Store', key: 'storeName', width: 32 },
      { header: 'Messages', key: 'count', width: 12 },
    ]);
    r.messages.busiestStores.forEach((d) => storesWs.addRow(d));
    const camp = sheet('Campaigns', [
      { header: 'Channel', key: 'channel', width: 14 },
      { header: 'Campaigns', key: 'campaigns', width: 12 },
      { header: 'Sent', key: 'sent', width: 10 },
      { header: 'Failed', key: 'failed', width: 10 },
    ]);
    r.campaigns.byChannel.forEach((d) => camp.addRow(d));
    if (r.leads) {
      const leadWs = sheet('Leads', [
        { header: 'Stage / source', key: 'k', width: 24 },
        { header: 'Leads', key: 'v', width: 10 },
      ]);
      r.leads.byStage.forEach((s) => leadWs.addRow({ k: s.stage, v: s.count }));
      leadWs.addRow({});
      r.leads.bySource.forEach((s) => leadWs.addRow({ k: s.source, v: s.count }));
    }

    await this.audit.record(actor, {
      action: 'report.exported',
      businessId: r.businessId,
      metadata: { from: r.from, to: r.to },
    });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const safe = name.replace(/[^\w-]+/g, '-').toLowerCase();
    return { buffer, fileName: `sma-report-${safe}-${r.from.slice(0, 10)}.xlsx` };
  }
}
