/**
 * Demo Sales & Marketing data for three customer businesses (development only), so each
 * business's own CRM can be tried: its admin and a sales agent, services, leads at every stage,
 * today's meetings (one about 20 minutes away to see the reminder), deals, a quote, invoices with
 * payments and a payment to confirm, monthly billing, targets and commission.
 *
 *   npm run db:demo-business-crm -w @storeline/api
 *
 * Idempotent: a business that already has leads is skipped. The agents' passwords are generated
 * into the git-ignored demo-accounts.local.json ("businessSalesUsers") and never printed.
 * Companies, people, emails (example.com) and phone numbers (555) are fictitious.
 */
import '../src/load-env';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ActivityOutcome,
  type DealStatus,
  type FollowUpKind,
  type LeadSource,
  type LeadStage,
  PrismaClient,
  type ServiceBilling,
} from '@prisma/client';
import { PasswordService } from '../src/modules/auth/password.service';
import { syncSystemRoles } from '../src/modules/authorization/system-roles';

const prisma = new PrismaClient();
const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const dateOnly = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const round2 = (v: number) => Math.round(v * 100) / 100;
const token = () => randomBytes(24).toString('base64url');
/** Today (or `days` from today) at hh:mm, server time. */
const at = (days: number, hour: number, minute = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);

type Act = [type: 'CALL' | 'EMAIL' | 'MEETING' | 'WHATSAPP' | 'NOTE', body: string, outcome: ActivityOutcome | null, daysAgo: number];

interface LeadSpec {
  company: string;
  contact: string;
  title?: string;
  phone: string;
  email: string;
  city: string;
  industry: string;
  value: number;
  source: LeadSource;
  stage: LeadStage;
  stageDaysAgo: number;
  createdDaysAgo: number;
  owner: 'admin' | 'agent' | null;
  /** inMinutes: from now (reminder test); otherwise a day offset and an hour. */
  followUp?: { inMinutes?: number; days?: number; hour?: number; minute?: number; kind: FollowUpKind; note?: string };
  lostReason?: string;
  acts: Act[];
  deal?: {
    title: string;
    status: DealStatus;
    lines: Array<[service: string, qty: number]>;
    closedDaysAgo?: number;
    invoice?: { issuedDaysAgo: number; dueDays: number; paid: number; claim?: boolean };
    quote?: boolean;
    upsell?: { title: string; lines: Array<[string, number]> };
    monthly?: Array<[string, number]>;
  };
}

interface BizSpec {
  slug: string;
  tax: number;
  agent: { username: string; displayName: string; email: string };
  services: Array<[name: string, category: string, price: number, billing: ServiceBilling, description: string]>;
  leads: LeadSpec[];
  targets: { admin: number; agent: number };
}

const BUSINESSES: BizSpec[] = [
  {
    slug: 'abc-retail',
    tax: 18,
    agent: { username: 'abc.sales', displayName: 'Hamza Tariq', email: 'abc.sales@example.com' },
    targets: { admin: 900_000, agent: 600_000 },
    services: [
      ['Wholesale rice (25 kg bag)', 'Wholesale', 7_800, 'ONE_TIME', 'Super basmati, delivered.'],
      ['Cooking oil (16 L tin)', 'Wholesale', 9_200, 'ONE_TIME', 'Delivered within 2 days.'],
      ['Monthly grocery supply (office)', 'Supply', 45_000, 'MONTHLY', 'Tea, sugar, snacks and cleaning items every month.'],
      ['Corporate gift hampers', 'Gifts', 3_500, 'ONE_TIME', 'Eid and year-end hampers, branded.'],
      ['Delivery and handling', 'Services', 2_500, 'ONE_TIME', 'Per drop in the city.'],
    ],
    leads: [
      {
        company: 'Gulberg Tech Park', contact: 'Sadia Noor', title: 'Admin Manager', phone: '+923005550101', email: 'sadia@gulbergtech.example.com',
        city: 'Lahore', industry: 'Offices', value: 45_000, source: 'REFERRAL', stage: 'PROPOSAL', stageDaysAgo: 3, createdDaysAgo: 12, owner: 'agent',
        followUp: { inMinutes: 20, kind: 'MEETING', note: 'At their office, 3rd floor. Bring the hamper samples.' },
        acts: [['CALL', 'Wants monthly supply for 120 staff', 'INTERESTED', 10], ['MEETING', 'Walked through the product list', 'MEETING_BOOKED', 4]],
        deal: { title: 'Gulberg Tech Park — monthly supply', status: 'OPEN', lines: [['Monthly grocery supply (office)', 1], ['Corporate gift hampers', 40]], quote: true },
      },
      {
        company: 'Sunrise Schools', contact: 'Imran Qureshi', title: 'Procurement', phone: '+923005550102', email: 'imran@sunrise.example.com',
        city: 'Lahore', industry: 'Education', value: 120_000, source: 'COLD_CALL', stage: 'QUALIFIED', stageDaysAgo: 2, createdDaysAgo: 9, owner: 'admin',
        followUp: { days: 0, hour: 16, minute: 0, kind: 'CALL', note: 'Confirm canteen quantities' },
        acts: [['CALL', 'Needs rice and oil for 4 canteens', 'CALL_BACK_LATER', 6]],
      },
      {
        company: 'Hotel Grand Lahore', contact: 'Faisal Butt', phone: '+923005550103', email: 'faisal@grandlhr.example.com',
        city: 'Lahore', industry: 'Hospitality', value: 300_000, source: 'WEBSITE', stage: 'WON', stageDaysAgo: 20, createdDaysAgo: 40, owner: 'agent',
        followUp: { days: 2, hour: 11, kind: 'VISIT', note: 'Quarterly review at the hotel' },
        acts: [['MEETING', 'Tasting and price agreed', 'INTERESTED', 22]],
        deal: {
          title: 'Hotel Grand — rice and oil, first order', status: 'WON', closedDaysAgo: 20, lines: [['Wholesale rice (25 kg bag)', 20], ['Cooking oil (16 L tin)', 10], ['Delivery and handling', 2]],
          invoice: { issuedDaysAgo: 19, dueDays: 14, paid: 1 },
          upsell: { title: 'Hotel Grand — Eid hampers', lines: [['Corporate gift hampers', 60]] },
          monthly: [['Monthly grocery supply (office)', 2]],
        },
      },
      {
        company: 'City Pharmacy Chain', contact: 'Amna Siddiqui', phone: '+923005550104', email: 'amna@citypharma.example.com',
        city: 'Lahore', industry: 'Pharmacy', value: 60_000, source: 'EVENT', stage: 'WON', stageDaysAgo: 8, createdDaysAgo: 25, owner: 'admin',
        acts: [['MEETING', 'Signed for staff hampers', 'INTERESTED', 9]],
        deal: { title: 'City Pharmacy — staff hampers', status: 'WON', closedDaysAgo: 8, lines: [['Corporate gift hampers', 25], ['Delivery and handling', 1]], invoice: { issuedDaysAgo: 30, dueDays: 7, paid: 0.4, claim: true } },
      },
      {
        company: 'Model Town Bakery', contact: 'Rizwan Ali', phone: '+923005550105', email: 'rizwan@mtbakery.example.com',
        city: 'Lahore', industry: 'Food', value: 25_000, source: 'SOCIAL_MEDIA', stage: 'CONTACTED', stageDaysAgo: 5, createdDaysAgo: 7, owner: 'agent',
        followUp: { days: -1, hour: 15, kind: 'WHATSAPP', note: 'Send the oil price list' },
        acts: [['WHATSAPP', 'Asked for oil prices', 'NO_ANSWER', 5]],
      },
      {
        company: 'Fresh Mart DHA', contact: 'Nadia Hussain', phone: '+923005550106', email: 'nadia@freshmart.example.com',
        city: 'Lahore', industry: 'Retail', value: 80_000, source: 'COLD_CALL', stage: 'NEGOTIATION', stageDaysAgo: 1, createdDaysAgo: 15, owner: 'agent',
        followUp: { days: 1, hour: 12, kind: 'MEETING', note: 'Final price discussion' },
        acts: [['CALL', 'Wants 5% off on rice', 'INTERESTED', 2]],
        deal: { title: 'Fresh Mart — rice supply', status: 'OPEN', lines: [['Wholesale rice (25 kg bag)', 10]] },
      },
      {
        company: 'Office Plus', contact: 'Kashif Mirza', phone: '+923005550107', email: 'kashif@officeplus.example.com',
        city: 'Lahore', industry: 'Offices', value: 30_000, source: 'EMAIL_CAMPAIGN', stage: 'LOST', stageDaysAgo: 6, createdDaysAgo: 20, owner: 'admin',
        lostReason: 'Went with a cheaper supplier', acts: [['EMAIL', 'Sent the catalogue', 'NOT_INTERESTED', 10]],
      },
      {
        company: 'Green Valley Café', contact: 'Hira Saleem', phone: '+923005550108', email: 'hira@gvcafe.example.com',
        city: 'Lahore', industry: 'Food', value: 15_000, source: 'WEBSITE', stage: 'NEW', stageDaysAgo: 0, createdDaysAgo: 0, owner: null, acts: [],
      },
    ],
  },
  {
    slug: 'khadi',
    tax: 17,
    agent: { username: 'khadi.sales', displayName: 'Mehwish Raza', email: 'khadi.sales@example.com' },
    targets: { admin: 1_500_000, agent: 1_000_000 },
    services: [
      ['Corporate uniform (per set)', 'Uniforms', 6_500, 'ONE_TIME', 'Stitched to size, logo embroidery.'],
      ['Bulk unstitched fabric (per suit)', 'Fabric', 3_200, 'ONE_TIME', 'Lawn and khaddar, 3-piece.'],
      ['Gift cards (PKR 5,000)', 'Gifts', 5_000, 'ONE_TIME', 'For staff and clients.'],
      ['Wedding collection styling', 'Services', 25_000, 'ONE_TIME', 'Personal styling session.'],
      ['Uniform care plan', 'Services', 18_000, 'MONTHLY', 'Repairs and replacements every month.'],
    ],
    leads: [
      {
        company: 'Meezan Corporate Office', contact: 'Usman Sheikh', title: 'HR Head', phone: '+923005550201', email: 'usman@meezancorp.example.com',
        city: 'Karachi', industry: 'Banking', value: 650_000, source: 'REFERRAL', stage: 'PROPOSAL', stageDaysAgo: 2, createdDaysAgo: 14, owner: 'agent',
        followUp: { inMinutes: 25, kind: 'MEETING', note: 'Fabric samples at their HR office' },
        acts: [['MEETING', 'Needs 100 uniforms for front desk staff', 'INTERESTED', 7]],
        deal: { title: 'Meezan Corporate — 100 uniforms', status: 'OPEN', lines: [['Corporate uniform (per set)', 100]], quote: true },
      },
      {
        company: 'Pearl Hotel Staff', contact: 'Saima Khan', phone: '+923005550202', email: 'saima@pearl.example.com',
        city: 'Karachi', industry: 'Hospitality', value: 400_000, source: 'COLD_CALL', stage: 'WON', stageDaysAgo: 15, createdDaysAgo: 35, owner: 'admin',
        followUp: { days: 3, hour: 10, kind: 'VISIT', note: 'Fitting check at the hotel' },
        acts: [['CALL', 'Approved the design', 'INTERESTED', 16]],
        deal: {
          title: 'Pearl Hotel — staff uniforms', status: 'WON', closedDaysAgo: 15, lines: [['Corporate uniform (per set)', 50]],
          invoice: { issuedDaysAgo: 14, dueDays: 30, paid: 0.5 },
          monthly: [['Uniform care plan', 1]],
        },
      },
      {
        company: 'Bridal Studio Clifton', contact: 'Zoya Malik', phone: '+923005550203', email: 'zoya@bridalclifton.example.com',
        city: 'Karachi', industry: 'Fashion', value: 75_000, source: 'SOCIAL_MEDIA', stage: 'QUALIFIED', stageDaysAgo: 3, createdDaysAgo: 6, owner: 'agent',
        followUp: { days: 0, hour: 17, kind: 'CALL', note: 'Confirm styling dates' },
        acts: [['WHATSAPP', 'Wants a styling session for 3 brides', 'INTERESTED', 3]],
      },
      {
        company: 'TechNova Events', contact: 'Ali Abbasi', phone: '+923005550204', email: 'ali@technova.example.com',
        city: 'Karachi', industry: 'Events', value: 150_000, source: 'EVENT', stage: 'WON', stageDaysAgo: 5, createdDaysAgo: 18, owner: 'agent',
        acts: [['MEETING', 'Gift cards for event speakers', 'INTERESTED', 6]],
        deal: { title: 'TechNova — speaker gift cards', status: 'WON', closedDaysAgo: 5, lines: [['Gift cards (PKR 5,000)', 30]], invoice: { issuedDaysAgo: 5, dueDays: 7, paid: 0, claim: true } },
      },
      {
        company: 'Sindh Textile Traders', contact: 'Junaid Memon', phone: '+923005550205', email: 'junaid@stt.example.com',
        city: 'Hyderabad', industry: 'Wholesale', value: 220_000, source: 'COLD_CALL', stage: 'CONTACTED', stageDaysAgo: 4, createdDaysAgo: 8, owner: 'admin',
        followUp: { days: -2, hour: 11, kind: 'CALL', note: 'Call back about bulk lawn' },
        acts: [['CALL', 'Busy, call back', 'CALL_BACK_LATER', 4]],
      },
      {
        company: 'Lyceum School Uniforms', contact: 'Farah Javed', phone: '+923005550206', email: 'farah@lyceum.example.com',
        city: 'Karachi', industry: 'Education', value: 500_000, source: 'WEBSITE', stage: 'LOST', stageDaysAgo: 10, createdDaysAgo: 30, owner: 'agent',
        lostReason: 'Budget moved to next year', acts: [['MEETING', 'Liked samples, no budget', 'NOT_INTERESTED', 11]],
      },
      {
        company: 'Rang Boutique', contact: 'Mahnoor Iqbal', phone: '+923005550207', email: 'mahnoor@rang.example.com',
        city: 'Karachi', industry: 'Fashion', value: 60_000, source: 'WEBSITE', stage: 'NEW', stageDaysAgo: 0, createdDaysAgo: 1, owner: null, acts: [],
      },
    ],
  },
  {
    slug: 'sma-business',
    tax: 16,
    agent: { username: 'smabiz.sales', displayName: 'Daniyal Shah', email: 'smabiz.sales@example.com' },
    targets: { admin: 700_000, agent: 450_000 },
    services: [
      ['POS system setup', 'Setup', 85_000, 'ONE_TIME', 'Hardware, software and training for one counter.'],
      ['Business website', 'Web', 120_000, 'ONE_TIME', 'Five pages, mobile friendly, hosting for a year.'],
      ['IT support plan', 'Support', 35_000, 'MONTHLY', 'Remote and on-site support, same-day response.'],
      ['Social media management', 'Marketing', 50_000, 'MONTHLY', 'Posts, ads and monthly report.'],
      ['Network cabling (per point)', 'Setup', 4_500, 'ONE_TIME', 'Cat6 cabling and testing.'],
    ],
    leads: [
      {
        company: 'Al-Noor Supermarket', contact: 'Tariq Mehmood', title: 'Owner', phone: '+923005550301', email: 'tariq@alnoor.example.com',
        city: 'Islamabad', industry: 'Retail', value: 170_000, source: 'REFERRAL', stage: 'NEGOTIATION', stageDaysAgo: 1, createdDaysAgo: 10, owner: 'admin',
        followUp: { inMinutes: 18, kind: 'MEETING', note: 'Demo of the POS at their store' },
        acts: [['CALL', 'Needs 2 POS counters', 'INTERESTED', 6], ['MEETING', 'Site survey done', 'INTERESTED', 3]],
        deal: { title: 'Al-Noor — 2 POS counters', status: 'OPEN', lines: [['POS system setup', 2], ['Network cabling (per point)', 6]], quote: true },
      },
      {
        company: 'Capital Dental Clinic', contact: 'Dr. Sana Riaz', phone: '+923005550302', email: 'sana@capitaldental.example.com',
        city: 'Islamabad', industry: 'Health', value: 120_000, source: 'WEBSITE', stage: 'WON', stageDaysAgo: 25, createdDaysAgo: 45, owner: 'agent',
        followUp: { days: 1, hour: 15, kind: 'CALL', note: 'Ask about Google ads' },
        acts: [['MEETING', 'Website signed', 'INTERESTED', 26]],
        deal: {
          title: 'Capital Dental — website', status: 'WON', closedDaysAgo: 25, lines: [['Business website', 1]],
          invoice: { issuedDaysAgo: 24, dueDays: 10, paid: 1 },
          upsell: { title: 'Capital Dental — social media', lines: [['Social media management', 1]] },
          monthly: [['IT support plan', 1]],
        },
      },
      {
        company: 'Blue Area Law Associates', contact: 'Haris Chaudhry', phone: '+923005550303', email: 'haris@bluearealaw.example.com',
        city: 'Islamabad', industry: 'Legal', value: 35_000, source: 'COLD_CALL', stage: 'PROPOSAL', stageDaysAgo: 4, createdDaysAgo: 12, owner: 'agent',
        followUp: { days: 0, hour: 18, kind: 'EMAIL', note: 'Send the support plan details' },
        acts: [['CALL', 'Interested in monthly IT support', 'INTERESTED', 4]],
        deal: { title: 'Blue Area Law — IT support', status: 'OPEN', lines: [['IT support plan', 1]] },
      },
      {
        company: 'Margalla Fitness', contact: 'Bilal Aslam', phone: '+923005550304', email: 'bilal@margallafit.example.com',
        city: 'Islamabad', industry: 'Fitness', value: 50_000, source: 'SOCIAL_MEDIA', stage: 'WON', stageDaysAgo: 4, createdDaysAgo: 14, owner: 'agent',
        acts: [['WHATSAPP', 'Agreed to social media plan', 'INTERESTED', 5]],
        deal: { title: 'Margalla Fitness — social media', status: 'WON', closedDaysAgo: 4, lines: [['Social media management', 1]], invoice: { issuedDaysAgo: 40, dueDays: 14, paid: 0, claim: true } },
      },
      {
        company: 'Rawal Logistics', contact: 'Shahid Iqbal', phone: '+923005550305', email: 'shahid@rawallog.example.com',
        city: 'Rawalpindi', industry: 'Logistics', value: 90_000, source: 'EMAIL_CAMPAIGN', stage: 'CONTACTED', stageDaysAgo: 6, createdDaysAgo: 9, owner: 'admin',
        followUp: { days: -1, hour: 10, kind: 'VISIT', note: 'Check the warehouse network' },
        acts: [['EMAIL', 'Sent cabling price list', 'NO_ANSWER', 6]],
      },
      {
        company: 'F-7 Coffee House', contact: 'Ayesha Zafar', phone: '+923005550306', email: 'ayesha@f7coffee.example.com',
        city: 'Islamabad', industry: 'Food', value: 40_000, source: 'WEBSITE', stage: 'LOST', stageDaysAgo: 7, createdDaysAgo: 20, owner: 'agent',
        lostReason: 'Built the website themselves', acts: [['CALL', 'Not needed any more', 'NOT_INTERESTED', 8]],
      },
      {
        company: 'Green Leaf School', contact: 'Rehana Akhtar', phone: '+923005550307', email: 'rehana@greenleaf.example.com',
        city: 'Islamabad', industry: 'Education', value: 150_000, source: 'WEBSITE', stage: 'NEW', stageDaysAgo: 0, createdDaysAgo: 0, owner: null, acts: [],
      },
    ],
  },
];

/** Agents' passwords live in the git-ignored local file (generated once, never printed). */
function agentPasswords(usernames: string[]): Record<string, string> {
  const file = join(__dirname, '..', 'demo-accounts.local.json');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    json = {};
  }
  const list = (json.businessSalesUsers ?? []) as Array<{ username: string; password: string }>;
  let changed = false;
  for (const username of usernames) {
    if (list.some((u) => u.username === username)) continue;
    list.push({ username, password: randomBytes(12).toString('base64url') });
    changed = true;
  }
  if (changed) {
    json.businessSalesUsers = list;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  return Object.fromEntries(list.map((u) => [u.username, u.password]));
}

async function nextNumber(tenantId: string, kind: 'invoice' | 'quote'): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "CrmCounter" ("businessId", "kind", "value") VALUES (${tenantId}::uuid, ${kind}, 1)
    ON CONFLICT ("businessId", "kind") DO UPDATE SET "value" = "CrmCounter"."value" + 1
    RETURNING "value"`;
  return Number(rows[0]!.value);
}

async function main(): Promise<void> {
  const roles = await syncSystemRoles(prisma);
  const passwords = agentPasswords(BUSINESSES.map((b) => b.agent.username));
  const hasher = new PasswordService();

  for (const spec of BUSINESSES) {
    const business = await prisma.business.findFirst({
      where: { slug: spec.slug, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!business) {
      console.log(`• ${spec.slug}: business not found, skipped`);
      continue;
    }
    const tenantId = business.id;
    if ((await prisma.lead.count({ where: { tenantId } })) > 0) {
      console.log(`• ${business.name}: already has leads, skipped`);
      continue;
    }
    const adminRow = await prisma.roleAssignment.findFirst({
      where: {
        businessId: tenantId,
        revokedAt: null,
        role: { key: { in: ['BUSINESS_OWNER', 'BUSINESS_ADMIN'] }, isSystem: true },
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    if (!adminRow) {
      console.log(`• ${business.name}: no admin found, skipped`);
      continue;
    }
    const adminId = adminRow.userId;

    // ── Sales agent and the team chat ──
    let agent = await prisma.user.findUnique({ where: { username: spec.agent.username }, select: { id: true } });
    if (!agent) {
      const passwordHash = await hasher.hash(passwords[spec.agent.username]!);
      agent = await prisma.user.create({
        data: {
          username: spec.agent.username,
          displayName: spec.agent.displayName,
          passwordHash,
          contact: { create: { email: spec.agent.email, emailVerifiedAt: new Date() } },
          businessMemberships: { create: { businessId: tenantId } },
        },
        select: { id: true },
      });
      await prisma.roleAssignment.create({
        data: { userId: agent.id, roleId: roles.SALES_AGENT, scopeType: 'BUSINESS', businessId: tenantId, grantedById: adminId },
      });
    }
    const agentId = agent.id;
    let group = await prisma.conversation.findFirst({
      where: { businessId: tenantId, type: 'GROUP', title: 'Sales & Marketing team' },
      select: { id: true },
    });
    if (!group) {
      group = await prisma.conversation.create({
        data: {
          businessId: tenantId,
          type: 'GROUP',
          title: 'Sales & Marketing team',
          memberCount: 2,
          members: {
            create: [
              { userId: adminId, role: 'ADMIN' },
              { userId: agentId, role: 'MEMBER' },
            ],
          },
        },
        select: { id: true },
      });
    }

    // ── Settings, commission, services ──
    const settings: Record<string, string> = {
      CRM_DEFAULT_CURRENCY: 'PKR',
      CRM_USD_PKR_RATE: '280',
      CRM_TAX_NAME: 'GST',
      CRM_TAX_RATE: String(spec.tax),
      INVOICE_COMPANY_NAME: business.name,
      PAY_JAZZCASH_ACCOUNT: 'DEMO — set the real JazzCash number in Sales → CRM settings',
      PAY_BANK_ACCOUNT: 'DEMO — set the real bank account in Sales → CRM settings',
      REMINDER_DAYS: '1,7,14',
      REMINDER_CHANNELS: 'EMAIL',
    };
    for (const [key, value] of Object.entries(settings)) {
      await prisma.crmSetting.upsert({
        where: { businessId_key: { businessId: tenantId, key } },
        create: { businessId: tenantId, key, value, updatedById: adminId },
        update: {},
      });
    }
    await prisma.commissionPlan.upsert({
      where: { tenantId_scope: { tenantId, scope: 'team' } },
      create: { tenantId, scope: 'team', baseRate: 2, bonusRate: 5, basis: 'WON', updatedById: adminId },
      update: {},
    });
    await prisma.crmService.createMany({
      data: spec.services.map(([name, category, price, billing, description]) => ({
        tenantId,
        name,
        category,
        price,
        billing,
        description,
        currency: 'PKR',
      })),
    });
    const services = new Map(
      (await prisma.crmService.findMany({ where: { tenantId } })).map((s) => [s.name, s] as const),
    );
    const lineItems = (lines: Array<[string, number]>) =>
      lines.map(([name, quantity], position) => {
        const svc = services.get(name);
        if (!svc) throw new Error(`Unknown service ${name}`);
        const unitPrice = Number(svc.price);
        return { serviceId: svc.id, name, quantity, unitPrice, total: round2(unitPrice * quantity), billing: svc.billing, position };
      });

    // ── Leads, deals, quotes, invoices ──
    let leads = 0;
    let invoices = 0;
    for (const l of spec.leads) {
      const ownerId = l.owner === 'admin' ? adminId : l.owner === 'agent' ? agentId : null;
      const actorId = ownerId ?? adminId;
      const followUpAt = l.followUp
        ? l.followUp.inMinutes !== undefined
          ? new Date(now.getTime() + l.followUp.inMinutes * 60_000)
          : at(l.followUp.days ?? 0, l.followUp.hour ?? 11, l.followUp.minute ?? 0)
        : null;
      const count = (t: Act[0]) => l.acts.filter((a) => a[0] === t).length;
      const closed = l.stage === 'WON' || l.stage === 'LOST';
      const lead = await prisma.lead.create({
        data: {
          tenantId,
          companyName: l.company,
          contactName: l.contact,
          contactTitle: l.title ?? null,
          phone: l.phone,
          email: l.email,
          city: l.city,
          country: 'PK',
          industry: l.industry,
          estimatedValue: l.value,
          currency: 'PKR',
          source: l.source,
          direction: l.source === 'COLD_CALL' || l.source === 'EMAIL_CAMPAIGN' ? 'OUTBOUND' : 'INBOUND',
          stage: l.stage,
          stageChangedAt: ago(l.stageDaysAgo),
          closedAt: closed ? ago(l.stageDaysAgo) : null,
          lostReason: l.lostReason ?? null,
          ownerId,
          createdById: actorId,
          nextFollowUpAt: followUpAt,
          nextFollowUpKind: followUpAt ? l.followUp!.kind : null,
          nextFollowUpNote: followUpAt ? (l.followUp!.note ?? null) : null,
          lastActivityAt: l.acts.length ? ago(Math.min(...l.acts.map((a) => a[3]))) : ago(l.createdDaysAgo),
          callCount: count('CALL'),
          messageCount: count('EMAIL') + count('WHATSAPP'),
          meetingCount: count('MEETING'),
          lastOutcome: [...l.acts].sort((a, b) => a[3] - b[3])[0]?.[2] ?? null,
          createdAt: ago(l.createdDaysAgo),
        },
        select: { id: true },
      });
      leads += 1;
      await prisma.leadActivity.create({
        data: { leadId: lead.id, type: 'CREATED', toStage: 'NEW', actorId: l.source === 'WEBSITE' ? null : actorId, body: l.source === 'WEBSITE' ? 'From the website form' : null, createdAt: ago(l.createdDaysAgo) },
      });
      for (const [type, body, outcome, daysAgo] of l.acts)
        await prisma.leadActivity.create({ data: { leadId: lead.id, type, body, outcome, actorId, createdAt: ago(daysAgo) } });
      if (l.stage !== 'NEW')
        await prisma.leadActivity.create({
          data: { leadId: lead.id, type: 'STAGE_CHANGED', fromStage: 'NEW', toStage: l.stage, body: l.lostReason ?? null, actorId, createdAt: ago(l.stageDaysAgo) },
        });

      if (!l.deal) continue;
      const d = l.deal;
      const items = lineItems(d.lines);
      const amount = round2(items.reduce((s, i) => s + i.total, 0));
      const deal = await prisma.deal.create({
        data: {
          tenantId,
          title: d.title,
          type: 'NEW_BUSINESS',
          status: d.status,
          leadId: lead.id,
          ownerId,
          amount,
          currency: 'PKR',
          closedAt: d.closedDaysAgo !== undefined ? ago(d.closedDaysAgo) : null,
          expectedCloseAt: d.status === 'OPEN' ? at(10, 12) : null,
          createdById: actorId,
          createdAt: ago(l.createdDaysAgo - 1),
          items: { create: items.map((i) => ({ ...i, discountPct: 0 })) },
        },
        select: { id: true },
      });

      if (d.quote) {
        const sub = amount;
        const tax = round2((sub * spec.tax) / 100);
        const n = await nextNumber(tenantId, 'quote');
        await prisma.quote.create({
          data: {
            tenantId,
            number: `QT-${now.getFullYear()}-${String(n).padStart(5, '0')}`,
            dealId: deal.id,
            leadId: lead.id,
            billToName: l.company,
            billToEmail: l.email,
            billToPhone: l.phone,
            status: 'SENT',
            issueDate: dateOnly(ago(2)),
            validUntil: dateOnly(at(12, 12)),
            currency: 'PKR',
            subtotal: sub,
            taxRate: spec.tax,
            taxAmount: tax,
            total: round2(sub + tax),
            terms: 'Prices valid until the date above. 50% advance, balance on delivery.',
            publicToken: token(),
            sentAt: ago(2),
            createdById: actorId,
            items: { create: items.map((i) => ({ serviceId: i.serviceId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, total: i.total, billing: i.billing, position: i.position })) },
          },
        });
      }

      if (d.invoice) {
        const inv = d.invoice;
        const sub = amount;
        const tax = round2((sub * spec.tax) / 100);
        const total = round2(sub + tax);
        const paid = round2(total * inv.paid);
        const n = await nextNumber(tenantId, 'invoice');
        const issued = ago(inv.issuedDaysAgo);
        const status = paid <= 0 ? 'ISSUED' : paid + 0.004 >= total ? 'PAID' : 'PARTIALLY_PAID';
        const invoice = await prisma.invoice.create({
          data: {
            tenantId,
            number: `INV-${issued.getFullYear()}-${String(n).padStart(5, '0')}`,
            dealId: deal.id,
            leadId: lead.id,
            billToName: l.company,
            billToEmail: l.email,
            billToPhone: l.phone,
            billToAddress: `${l.city}, Pakistan`,
            issueDate: dateOnly(issued),
            dueDate: dateOnly(new Date(issued.getTime() + inv.dueDays * DAY)),
            currency: 'PKR',
            subtotal: sub,
            taxRate: spec.tax,
            taxAmount: tax,
            total,
            amountPaid: paid,
            status,
            issuedAt: issued,
            paidAt: status === 'PAID' ? new Date(issued.getTime() + 3 * DAY) : null,
            payToken: token(),
            createdById: adminId,
            createdAt: issued,
            items: { create: items.map((i) => ({ serviceId: i.serviceId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, total: i.total, position: i.position })) },
            ...(paid > 0
              ? {
                  payments: {
                    create: {
                      amount: paid,
                      paidAt: new Date(issued.getTime() + 3 * DAY),
                      method: 'BANK_TRANSFER',
                      reference: `TRX-${n}${String(paid).slice(0, 4)}`,
                      recordedById: adminId,
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        invoices += 1;
        if (inv.claim) {
          await prisma.paymentClaim.create({
            data: {
              invoiceId: invoice.id,
              amount: round2(total - paid),
              method: 'ONLINE',
              reference: `JC${String(Date.now()).slice(-8)}`,
              payerName: l.contact,
              note: 'Paid by JazzCash',
            },
          });
        }
      }

      if (d.upsell) {
        const up = lineItems(d.upsell.lines);
        await prisma.deal.create({
          data: {
            tenantId,
            title: d.upsell.title,
            type: 'UPSELL',
            status: 'OPEN',
            leadId: lead.id,
            ownerId,
            amount: round2(up.reduce((s, i) => s + i.total, 0)),
            currency: 'PKR',
            expectedCloseAt: at(14, 12),
            createdById: actorId,
            items: { create: up.map((i) => ({ ...i, discountPct: 0 })) },
          },
        });
      }

      if (d.monthly) {
        const lines = lineItems(d.monthly);
        await prisma.subscription.create({
          data: {
            tenantId,
            leadId: lead.id,
            dealId: deal.id,
            name: `${l.company} — monthly`,
            currency: 'PKR',
            interval: 'MONTHLY',
            nextInvoiceAt: dateOnly(new Date(now.getFullYear(), now.getMonth() + 1, 1)),
            dueDays: 10,
            taxRate: spec.tax,
            autoEmail: false,
            createdById: adminId,
            items: { create: lines.map((i) => ({ serviceId: i.serviceId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, position: i.position })) },
          },
        });
      }
    }

    // ── Targets: this month and the two before ──
    for (let m = 0; m < 3; m++) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const month = new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
      for (const [userId, amount] of [
        [adminId, spec.targets.admin],
        [agentId, spec.targets.agent],
      ] as const) {
        await prisma.salesTarget.upsert({
          where: { tenantId_userId_month: { tenantId, userId, month } },
          create: { tenantId, userId, month, amount, currency: 'PKR', setById: adminId },
          update: {},
        });
      }
    }
    console.log(`✔ ${business.name}: ${leads} leads, ${invoices} invoices, agent ${spec.agent.username}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
