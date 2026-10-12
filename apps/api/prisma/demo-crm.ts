/**
 * Demo data for the CRM (development only): services catalog, deals (new customers, upsells,
 * open and lost), invoices with payments, and six months of sales targets.
 *
 *   npm run db:demo-crm -w @storeline/api
 *
 * Run after db:demo-sales (it uses its sales users and leads). Idempotent: each part is skipped
 * when it already exists. All amounts are made up.
 */
import '../src/load-env';
import { PrismaClient, type DealStatus, type DealType, type ServiceBilling } from '@prisma/client';

const prisma = new PrismaClient();
const CURRENCY = (process.env.CRM_CURRENCY ?? 'USD').toUpperCase();
const DEMO = '[demo]';

const now = new Date();
/** A date `months` months ago on day `day` (clamped to today for the current month). */
function monthsAgo(months: number, day: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth() - months, day, 11, 0, 0);
  return d > now ? new Date(now.getTime() - 3_600_000) : d;
}
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const dateOnly = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const round2 = (v: number) => Math.round(v * 100) / 100;

const SERVICES: Array<{
  name: string;
  category: string;
  price: number;
  billing: ServiceBilling;
  description: string;
}> = [
  { name: 'SMA Starter', category: 'Plans', price: 29, billing: 'MONTHLY', description: 'Team chat, groups and emergency button for one store.' },
  { name: 'SMA Business', category: 'Plans', price: 49, billing: 'MONTHLY', description: 'Everything in Starter plus campaigns, store customers and admin roles, per store.' },
  { name: 'SMA Enterprise', category: 'Plans', price: 499, billing: 'MONTHLY', description: 'Unlimited stores, priority support and a dedicated account manager.' },
  { name: 'WhatsApp campaigns', category: 'Add-ons', price: 39, billing: 'MONTHLY', description: 'Send approved WhatsApp campaigns to store customers.' },
  { name: 'SMS campaigns', category: 'Add-ons', price: 25, billing: 'MONTHLY', description: 'Send SMS campaigns to store customers.' },
  { name: 'Emergency alert system', category: 'Add-ons', price: 19, billing: 'MONTHLY', description: 'Escalating emergency alerts with acknowledgement, per store.' },
  { name: 'Extra 100 GB storage', category: 'Add-ons', price: 15, billing: 'MONTHLY', description: 'More space for photos, videos and documents.' },
  { name: 'Priority support', category: 'Add-ons', price: 99, billing: 'MONTHLY', description: 'Same-day answers and a WhatsApp support line.' },
  { name: 'Setup & onboarding', category: 'Services', price: 300, billing: 'ONE_TIME', description: 'Stores, staff, roles and groups set up for you.' },
  { name: 'Staff training session', category: 'Services', price: 150, billing: 'ONE_TIME', description: 'Two-hour training for store teams, on site or online.' },
  { name: 'Data migration', category: 'Services', price: 450, billing: 'ONE_TIME', description: 'Bring contacts, customers and history from your old tools.' },
];

type Line = [service: string, quantity: number, discountPct?: number];

interface DemoDeal {
  key: string;
  title: string;
  type: DealType;
  status: DealStatus;
  owner: string;
  lead?: string;
  customer?: string;
  lines: Line[];
  closedAt?: Date;
  expectedCloseAt?: Date;
  lostReason?: string;
  invoice?: {
    issued: Date;
    dueDays: number;
    draft?: boolean;
    payments?: Array<{ fraction: number; at: Date; method: 'BANK_TRANSFER' | 'CARD' | 'CASH' | 'CHEQUE'; reference?: string }>;
  };
}

const DEALS: DemoDeal[] = [
  {
    key: 'abc-new',
    title: 'ABC Retail — Enterprise, 12 months',
    type: 'NEW_BUSINESS',
    status: 'WON',
    owner: 'sales.bilal',
    customer: 'ABC Retail Group',
    lines: [['SMA Enterprise', 12], ['Data migration', 1], ['Staff training session', 2]],
    closedAt: monthsAgo(4, 18),
    invoice: {
      issued: monthsAgo(4, 19),
      dueDays: 14,
      payments: [
        { fraction: 0.5, at: monthsAgo(4, 25), method: 'BANK_TRANSFER', reference: 'HBL-88213' },
        { fraction: 0.5, at: monthsAgo(3, 20), method: 'BANK_TRANSFER', reference: 'HBL-90155' },
      ],
    },
  },
  {
    key: 'khaadi-new',
    title: 'Khaadi — Business plan, 3 stores',
    type: 'NEW_BUSINESS',
    status: 'WON',
    owner: 'sales.hira',
    lead: 'Khadi',
    lines: [['SMA Business', 36], ['Setup & onboarding', 1], ['Staff training session', 1]],
    closedAt: monthsAgo(2, 9),
    invoice: {
      issued: monthsAgo(2, 10),
      dueDays: 14,
      payments: [{ fraction: 1, at: monthsAgo(2, 21), method: 'BANK_TRANSFER', reference: 'MCB-41102' }],
    },
  },
  {
    key: 'smab-new',
    title: 'SMA Business — Starter, 2 stores',
    type: 'NEW_BUSINESS',
    status: 'WON',
    owner: 'sales.hira',
    lead: 'SMA Business',
    lines: [['SMA Starter', 24], ['Setup & onboarding', 1]],
    closedAt: monthsAgo(1, 6),
    invoice: {
      issued: monthsAgo(1, 7),
      dueDays: 14,
      payments: [{ fraction: 0.5, at: monthsAgo(1, 15), method: 'CHEQUE', reference: 'Cheque 004512' }],
    },
  },
  {
    key: 'khaadi-upsell',
    title: 'Khaadi — WhatsApp campaigns + emergency alerts',
    type: 'UPSELL',
    status: 'WON',
    owner: 'sales.hira',
    customer: 'Khaadi',
    lines: [['WhatsApp campaigns', 12], ['Emergency alert system', 36, 10]],
    closedAt: daysAgo(6),
    invoice: { issued: daysAgo(5), dueDays: 14 },
  },
  {
    key: 'abc-upsell',
    title: 'ABC Retail — Priority support',
    type: 'UPSELL',
    status: 'WON',
    owner: 'sales.bilal',
    customer: 'ABC Retail Group',
    lines: [['Priority support', 12]],
    closedAt: daysAgo(10),
    invoice: {
      issued: daysAgo(9),
      dueDays: 7,
      payments: [{ fraction: 1, at: daysAgo(4), method: 'CARD', reference: 'Visa •• 4411' }],
    },
  },
  {
    key: 'greenvalley-new',
    title: 'Green Valley Pharmacy — Starter, 4 stores',
    type: 'NEW_BUSINESS',
    status: 'WON',
    owner: 'sales.bilal',
    lead: 'Green Valley Pharmacy',
    lines: [['SMA Starter', 48], ['Setup & onboarding', 1]],
    closedAt: daysAgo(3),
    invoice: { issued: daysAgo(2), dueDays: 14, draft: true },
  },
  {
    key: 'smab-upsell',
    title: 'SMA Business — more storage and SMS',
    type: 'UPSELL',
    status: 'OPEN',
    owner: 'sales.manager',
    customer: 'SMA Business',
    lines: [['Extra 100 GB storage', 12], ['SMS campaigns', 12]],
    expectedCloseAt: daysAgo(-7),
  },
  {
    key: 'hyperstar',
    title: 'Hyperstar Express — Enterprise',
    type: 'NEW_BUSINESS',
    status: 'OPEN',
    owner: 'sales.manager',
    lead: 'Hyperstar Express',
    lines: [['SMA Enterprise', 12], ['Data migration', 1]],
    expectedCloseAt: daysAgo(-12),
  },
  {
    key: 'gourmet',
    title: 'Gourmet Foods — Business plan, 5 stores',
    type: 'NEW_BUSINESS',
    status: 'OPEN',
    owner: 'sales.manager',
    lead: 'Gourmet Foods',
    lines: [['SMA Business', 60], ['Setup & onboarding', 1]],
    expectedCloseAt: daysAgo(-20),
  },
  {
    key: 'imtiaz',
    title: 'Imtiaz Super Market — Business plan, 8 stores',
    type: 'NEW_BUSINESS',
    status: 'OPEN',
    owner: 'sales.bilal',
    lead: 'Imtiaz Super Market',
    lines: [['SMA Business', 96, 5], ['Staff training session', 2]],
    expectedCloseAt: daysAgo(-15),
  },
  {
    key: 'sapphire',
    title: 'Sapphire Outlets — Starter, 10 stores',
    type: 'NEW_BUSINESS',
    status: 'OPEN',
    owner: 'sales.manager',
    lead: 'Sapphire Outlets',
    lines: [['SMA Starter', 120]],
    expectedCloseAt: daysAgo(-25),
  },
  {
    key: 'dawood',
    title: 'Dawood Pharmacy — Starter, 6 stores',
    type: 'NEW_BUSINESS',
    status: 'OPEN',
    owner: 'sales.bilal',
    lead: 'Dawood Pharmacy',
    lines: [['SMA Starter', 72], ['Emergency alert system', 72]],
    expectedCloseAt: daysAgo(-30),
  },
  {
    key: 'naheed',
    title: 'Naheed Supermarket — Business plan',
    type: 'NEW_BUSINESS',
    status: 'LOST',
    owner: 'sales.bilal',
    lead: 'Naheed Supermarket',
    lines: [['SMA Business', 48]],
    closedAt: monthsAgo(1, 20),
    lostReason: 'Chose a cheaper local tool for now; follow up in 6 months.',
  },
];

/** Targets per person: [5 months ago … this month]. */
const TARGETS: Record<string, number[]> = {
  'sales.manager': [3000, 3000, 3000, 3500, 3500, 3000],
  'sales.bilal': [2000, 5000, 2500, 2500, 2500, 2500],
  'sales.hira': [1500, 1500, 2000, 2000, 2000, 2000],
};

async function main(): Promise<void> {
  // 1. Services catalog.
  const existingServices = await prisma.crmService.count();
  if (existingServices === 0) {
    await prisma.crmService.createMany({ data: SERVICES });
    console.log(`Services: added ${SERVICES.length}.`);
  } else {
    console.log('Services: already present, skipped.');
  }
  const services = new Map(
    (await prisma.crmService.findMany()).map((s) => [s.name, s] as const),
  );

  const users = new Map(
    (
      await prisma.user.findMany({
        where: { username: { in: Object.keys(TARGETS) }, deletedAt: null },
        select: { id: true, username: true },
      })
    ).map((u) => [u.username, u.id] as const),
  );
  if (users.size === 0) {
    console.log('No sales users found. Run npm run db:demo-sales first.');
    return;
  }
  const manager = users.get('sales.manager') ?? [...users.values()][0]!;

  // 2. Deals, invoices and payments.
  let dealsAdded = 0;
  for (const demo of DEALS) {
    const marker = `${DEMO} ${demo.key}`;
    if (await prisma.deal.findFirst({ where: { notes: { startsWith: marker } }, select: { id: true } }))
      continue;
    const ownerId = users.get(demo.owner) ?? manager;
    const lead = demo.lead
      ? await prisma.lead.findFirst({
          where: { companyName: demo.lead, deletedAt: null },
          select: { id: true, convertedBusinessId: true },
        })
      : null;
    if (demo.lead && !lead) {
      console.log(`  skipped ${demo.key}: lead "${demo.lead}" not found`);
      continue;
    }
    const customer = demo.customer
      ? await prisma.business.findFirst({
          where: { name: demo.customer, deletedAt: null, internal: false },
          select: { id: true },
        })
      : null;
    if (demo.customer && !customer) {
      console.log(`  skipped ${demo.key}: customer "${demo.customer}" not found`);
      continue;
    }
    const items = demo.lines.map(([name, quantity, discountPct = 0], position) => {
      const s = services.get(name);
      if (!s) throw new Error(`Unknown service ${name}`);
      const unitPrice = Number(s.price);
      return {
        serviceId: s.id,
        name: s.name,
        quantity,
        unitPrice,
        discountPct,
        billing: s.billing,
        total: round2(quantity * unitPrice * (1 - discountPct / 100)),
        position,
      };
    });
    const amount = round2(items.reduce((sum, i) => sum + i.total, 0));
    const businessId = customer?.id ?? lead?.convertedBusinessId ?? null;
    const createdAt = demo.closedAt
      ? new Date(demo.closedAt.getTime() - 12 * 86_400_000)
      : daysAgo(8);
    const deal = await prisma.deal.create({
      data: {
        title: demo.title,
        type: demo.type,
        status: demo.status,
        leadId: lead?.id ?? null,
        businessId,
        ownerId,
        amount,
        currency: CURRENCY,
        closedAt: demo.closedAt ?? null,
        expectedCloseAt: demo.expectedCloseAt ?? null,
        lostReason: demo.lostReason ?? null,
        notes: `${marker} — demo data`,
        createdById: ownerId,
        createdAt,
        items: { create: items },
      },
      select: { id: true },
    });
    dealsAdded += 1;

    if (demo.invoice) {
      const party = businessId
        ? await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, email: true, phone: true },
          })
        : null;
      const leadParty = lead
        ? await prisma.lead.findUnique({
            where: { id: lead.id },
            select: { companyName: true, email: true, phone: true },
          })
        : null;
      const issued = demo.invoice.issued;
      const seq = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
      const n = seq[0]!.n;
      const total = amount;
      const paidAmounts = (demo.invoice.payments ?? []).map((p) => round2(total * p.fraction));
      const paid = round2(paidAmounts.reduce((a, b) => a + b, 0));
      const status = demo.invoice.draft
        ? 'DRAFT'
        : paid <= 0
          ? 'ISSUED'
          : paid + 0.004 >= total
            ? 'PAID'
            : 'PARTIALLY_PAID';
      const invoice = await prisma.invoice.create({
        data: {
          number: `INV-${issued.getFullYear()}-${String(n).padStart(5, '0')}`,
          dealId: deal.id,
          businessId,
          leadId: lead?.id ?? null,
          billToName: party?.name ?? leadParty?.companyName ?? demo.title,
          billToEmail: party?.email ?? leadParty?.email ?? null,
          billToPhone: party?.phone ?? leadParty?.phone ?? null,
          issueDate: dateOnly(issued),
          dueDate: dateOnly(new Date(issued.getTime() + demo.invoice.dueDays * 86_400_000)),
          currency: CURRENCY,
          subtotal: total,
          total,
          amountPaid: paid,
          status,
          issuedAt: demo.invoice.draft ? null : issued,
          paidAt: status === 'PAID' ? (demo.invoice.payments?.at(-1)?.at ?? null) : null,
          createdById: manager,
          createdAt: issued,
          items: {
            create: items.map((i) => ({
              serviceId: i.serviceId,
              name: i.name,
              description:
                [
                  i.billing === 'MONTHLY' ? 'Monthly' : i.billing === 'YEARLY' ? 'Yearly' : null,
                  i.discountPct > 0 ? `${i.discountPct}% discount` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || null,
              quantity: i.quantity,
              unitPrice: round2(i.total / i.quantity),
              total: i.total,
              position: i.position,
            })),
          },
          payments: {
            create: (demo.invoice.payments ?? []).map((p, idx) => ({
              amount: paidAmounts[idx]!,
              paidAt: p.at,
              method: p.method,
              reference: p.reference ?? null,
              recordedById: manager,
              createdAt: p.at,
            })),
          },
        },
        select: { number: true },
      });
      console.log(`  ${demo.key}: invoice ${invoice.number} (${status.toLowerCase()})`);
    }
  }
  console.log(`Deals: added ${dealsAdded}.`);

  // 3. Targets for the last six months.
  let targets = 0;
  for (const [username, amounts] of Object.entries(TARGETS)) {
    const userId = users.get(username);
    if (!userId) continue;
    for (let i = 0; i < amounts.length; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (amounts.length - 1 - i), 1);
      const month = new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
      const exists = await prisma.salesTarget.findUnique({
        where: { userId_month: { userId, month } },
        select: { id: true },
      });
      if (exists) continue;
      await prisma.salesTarget.create({
        data: { userId, month, amount: amounts[i]!, currency: CURRENCY, setById: manager },
      });
      targets += 1;
    }
  }
  console.log(`Targets: added ${targets}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
