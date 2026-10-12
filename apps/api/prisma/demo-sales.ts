/**
 * Demo data for Sales & Marketing, store customers and customer campaigns (development only).
 *
 *   npm run db:demo-sales -w @storeline/api
 *
 * Needs the seed (and ideally db:demo + accounts:apply) first. Idempotent: each part is skipped
 * when it already exists. Sales users' passwords come from the git-ignored
 * demo-accounts.local.json ("salesUsers") and are never printed. People, companies, emails and
 * phone numbers are fictitious (example.com, 555 numbers).
 */
import '../src/load-env';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ActivityOutcome,
  type LeadDirection,
  type LeadSource,
  type LeadStage,
  PrismaClient,
} from '@prisma/client';
import { DEFAULT_BUSINESS_POLICY } from '@storeline/shared';
import { PasswordService } from '../src/modules/auth/password.service';
import { syncSystemRoles } from '../src/modules/authorization/system-roles';

const prisma = new PrismaClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

interface SalesUser {
  username: string;
  displayName: string;
  email: string;
  roleKey: 'SALES_MANAGER' | 'SALES_AGENT';
  password: string;
}

const TEAM_SLUG = 'sma-sales-team';
const TEAM_GROUP_TITLE = 'Sales & Marketing team';

async function salesTeam(): Promise<{ businessId: string; groupId: string }> {
  let business = await prisma.business.findFirst({
    where: { internal: true, deletedAt: null },
    select: { id: true },
  });
  business ??= await prisma.business.create({
    data: {
      name: 'SMA Sales & Marketing',
      slug: TEAM_SLUG,
      internal: true,
      timeZone: 'Asia/Karachi',
      policy: DEFAULT_BUSINESS_POLICY,
      quota: { create: {} },
    },
    select: { id: true },
  });
  let group = await prisma.conversation.findFirst({
    where: { businessId: business.id, type: 'GROUP', title: TEAM_GROUP_TITLE },
    select: { id: true },
  });
  group ??= await prisma.conversation.create({
    data: { businessId: business.id, type: 'GROUP', title: TEAM_GROUP_TITLE },
    select: { id: true },
  });
  return { businessId: business.id, groupId: group.id };
}

async function addSalesUsers(
  team: { businessId: string; groupId: string },
  users: SalesUser[],
  roles: Record<string, string>,
): Promise<Map<string, string>> {
  const passwords = new PasswordService();
  const ids = new Map<string, string>();
  for (const u of users) {
    const existing = await prisma.user.findUnique({
      where: { username: u.username },
      select: { id: true },
    });
    if (existing) {
      ids.set(u.username, existing.id);
      continue;
    }
    const passwordHash = await passwords.hash(u.password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: u.username,
          displayName: u.displayName,
          passwordHash,
          contact: { create: { email: u.email, emailVerifiedAt: new Date() } },
        },
        select: { id: true },
      });
      await tx.businessMembership.create({
        data: { businessId: team.businessId, userId: created.id },
      });
      await tx.roleAssignment.create({
        data: {
          userId: created.id,
          roleId: roles[u.roleKey]!,
          scopeType: 'BUSINESS',
          businessId: team.businessId,
        },
      });
      await tx.conversationMember.create({
        data: {
          conversationId: team.groupId,
          userId: created.id,
          role: u.roleKey === 'SALES_MANAGER' ? 'ADMIN' : 'MEMBER',
        },
      });
      await tx.conversation.update({
        where: { id: team.groupId },
        data: { memberCount: { increment: 1 } },
      });
      return created;
    });
    ids.set(u.username, user.id);
    console.log(
      `✔ sales user ${u.username} (${u.roleKey === 'SALES_MANAGER' ? 'manager' : 'agent'})`,
    );
  }
  return ids;
}

/** A few messages in the sales team chat (only when the chat is still empty). */
async function teamChat(groupId: string, ids: Map<string, string>): Promise<void> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: groupId },
    select: { lastSeq: true },
  });
  if (conversation.lastSeq > 0) return;
  const lines: Array<[string, string, number]> = [
    [
      'sales.manager',
      'Assalam o Alaikum team! Weekly target: 5 demos booked and 2 proposals out.',
      3 * DAY,
    ],
    [
      'sales.bilal',
      'Called Al-Fatah and Imtiaz today. Imtiaz wants a demo for 12 stores next week.',
      2 * DAY,
    ],
    [
      'sales.hira',
      'Website leads from the Eid campaign are coming in, I picked up three of them.',
      2 * DAY - 2 * HOUR,
    ],
    [
      'sales.manager',
      'Great work. Please log every call with the response so the funnel stays accurate.',
      DAY,
    ],
    [
      'sales.bilal',
      'Green Valley Pharmacy signed! Converting them to an SMA customer now.',
      5 * HOUR,
    ],
    ['sales.hira', 'Mubarak ho 🎉', 4 * HOUR],
  ];
  let seq = 0;
  let lastId: string | null = null;
  let lastAt = new Date();
  for (const [username, body, msAgo] of lines) {
    const senderId = ids.get(username);
    if (!senderId) continue;
    seq += 1;
    lastAt = ago(msAgo);
    const message = await prisma.message.create({
      data: {
        conversationId: groupId,
        seq,
        senderId,
        clientMessageId: randomUUID(),
        body,
        state: 'DISPATCHED',
        createdAt: lastAt,
      },
      select: { id: true },
    });
    lastId = message.id;
  }
  await prisma.conversation.update({
    where: { id: groupId },
    data: { lastSeq: seq, lastMessageId: lastId, lastActivityAt: lastAt },
  });
  await prisma.conversationMember.updateMany({
    where: { conversationId: groupId },
    data: { lastDeliveredSeq: seq, lastReadSeq: seq - 2 },
  });
  console.log(`✔ ${seq} messages in the sales team chat`);
}

type Act = [
  type: 'CALL' | 'EMAIL' | 'WHATSAPP' | 'MEETING' | 'NOTE',
  body: string,
  outcome: ActivityOutcome | null,
  daysAgo: number,
  by?: string,
];

interface DemoLead {
  company: string;
  contact: string;
  title?: string;
  phone?: string;
  email?: string;
  city: string;
  industry: string;
  stores: number;
  value: number;
  source: LeadSource;
  direction?: LeadDirection;
  detail?: string;
  stage: LeadStage;
  owner: string | null;
  createdDaysAgo: number;
  stageDaysAgo: number;
  followUp?: number; // days from now (negative = overdue)
  lostReason?: string;
  convertedSlug?: string;
  acts: Act[];
}

const LEADS: DemoLead[] = [
  {
    company: 'Imtiaz Super Market',
    contact: 'Kashif Imtiaz',
    title: 'Operations Director',
    phone: '+923005550101',
    email: 'kashif@imtiaz.example.com',
    city: 'Karachi',
    industry: 'Retail',
    stores: 12,
    value: 180000,
    source: 'COLD_CALL',
    stage: 'PROPOSAL',
    owner: 'sales.bilal',
    createdDaysAgo: 18,
    stageDaysAgo: 3,
    followUp: 2,
    acts: [
      ['CALL', 'Intro call, interested in emergency alerts for all branches.', 'INTERESTED', 17],
      ['MEETING', 'Demo at head office with IT and operations.', 'MEETING_BOOKED', 9],
      ['EMAIL', 'Sent proposal for 12 stores with onboarding plan.', null, 3],
    ],
  },
  {
    company: 'Al-Fatah Stores',
    contact: 'Sadia Rehman',
    title: 'Head of IT',
    phone: '+923005550102',
    email: 'sadia@alfatah.example.com',
    city: 'Lahore',
    industry: 'Retail',
    stores: 9,
    value: 140000,
    source: 'COLD_CALL',
    stage: 'CONTACTED',
    owner: 'sales.bilal',
    createdDaysAgo: 6,
    stageDaysAgo: 5,
    followUp: -1,
    acts: [
      ['CALL', 'No answer at the main number.', 'NO_ANSWER', 6],
      ['CALL', 'Spoke to Sadia, asked to call back after month-end closing.', 'CALL_BACK_LATER', 5],
    ],
  },
  {
    company: 'Green Valley Pharmacy',
    contact: 'Dr. Usman Tariq',
    title: 'Owner',
    phone: '+923005550103',
    email: 'usman@greenvalley.example.com',
    city: 'Islamabad',
    industry: 'Pharmacy',
    stores: 6,
    value: 90000,
    source: 'REFERRAL',
    detail: 'Referred by Khadi',
    stage: 'WON',
    owner: 'sales.bilal',
    createdDaysAgo: 40,
    stageDaysAgo: 1,
    acts: [
      ['CALL', 'Referral call, wants staff chat and SOS for night shifts.', 'INTERESTED', 38],
      ['MEETING', 'On-site demo at Blue Area branch.', 'MEETING_BOOKED', 25],
      ['EMAIL', 'Final pricing sent.', null, 8],
      ['CALL', 'Confirmed: signing for 6 stores.', 'INTERESTED', 1],
    ],
  },
  {
    company: 'Khadi',
    contact: 'Ayesha Malik',
    title: 'COO',
    phone: '+923005550104',
    email: 'ayesha@khadi.example.com',
    city: 'Karachi',
    industry: 'Fashion',
    stores: 3,
    value: 60000,
    source: 'EVENT',
    detail: 'Retail Expo Karachi',
    stage: 'WON',
    owner: 'sales.hira',
    createdDaysAgo: 60,
    stageDaysAgo: 30,
    convertedSlug: 'khadi',
    acts: [
      ['MEETING', 'Met at Retail Expo stall.', 'INTERESTED', 59],
      ['WHATSAPP', 'Shared brochure and pricing on WhatsApp.', 'NEEDS_MORE_INFO', 50],
      ['MEETING', 'Contract signed.', 'MEETING_BOOKED', 30],
    ],
  },
  {
    company: 'SMA Business',
    contact: 'Hamad Ali',
    title: 'Owner',
    phone: '+923005550105',
    email: 'hamad@smabusiness.example.com',
    city: 'Lahore',
    industry: 'Services',
    stores: 2,
    value: 30000,
    source: 'WEBSITE',
    detail: 'Request a demo form',
    stage: 'WON',
    owner: 'sales.hira',
    createdDaysAgo: 45,
    stageDaysAgo: 20,
    convertedSlug: 'sma-business',
    acts: [
      ['CALL', 'Returned the website enquiry.', 'INTERESTED', 44],
      ['MEETING', 'Online demo.', 'MEETING_BOOKED', 35],
    ],
  },
  {
    company: 'Chase Up',
    contact: 'Rizwan Siddiqui',
    title: 'GM Stores',
    phone: '+923005550106',
    city: 'Karachi',
    industry: 'Retail',
    stores: 15,
    value: 220000,
    source: 'COLD_CALL',
    stage: 'QUALIFIED',
    owner: 'sales.manager',
    createdDaysAgo: 30,
    stageDaysAgo: 22,
    followUp: -6,
    acts: [
      ['CALL', 'Strong interest, budget approval pending from board.', 'INTERESTED', 28],
      ['CALL', 'Board meeting postponed.', 'CALL_BACK_LATER', 22],
    ],
  },
  {
    company: 'Metro Bakers',
    contact: 'Faisal Butt',
    phone: '+923005550107',
    city: 'Lahore',
    industry: 'Food',
    stores: 4,
    value: 45000,
    source: 'SOCIAL_MEDIA',
    detail: 'Facebook ad',
    stage: 'NEW',
    owner: null,
    createdDaysAgo: 1,
    stageDaysAgo: 1,
    acts: [],
  },
  {
    company: 'Saeed Ghani Cosmetics',
    contact: 'Maryam Saeed',
    title: 'Marketing Manager',
    email: 'maryam@saeedghani.example.com',
    city: 'Karachi',
    industry: 'Beauty',
    stores: 8,
    value: 110000,
    source: 'WEBSITE',
    detail: 'Request a demo form',
    stage: 'NEW',
    owner: null,
    createdDaysAgo: 0,
    stageDaysAgo: 0,
    acts: [],
  },
  {
    company: 'Hyperstar Express',
    contact: 'Junaid Iqbal',
    phone: '+923005550109',
    city: 'Lahore',
    industry: 'Retail',
    stores: 5,
    value: 75000,
    source: 'PARTNER',
    detail: 'Via TechServe Pvt',
    stage: 'NEGOTIATION',
    owner: 'sales.manager',
    createdDaysAgo: 25,
    stageDaysAgo: 4,
    followUp: 1,
    acts: [
      ['MEETING', 'Partner-led demo.', 'MEETING_BOOKED', 20],
      ['EMAIL', 'Asked for a 10% discount for annual billing.', 'NEEDS_MORE_INFO', 4],
    ],
  },
  {
    company: 'Kitchen Cuisine',
    contact: 'Ali Raza',
    phone: '+923005550110',
    city: 'Lahore',
    industry: 'Food',
    stores: 3,
    value: 40000,
    source: 'WALK_IN',
    stage: 'CONTACTED',
    owner: 'sales.hira',
    createdDaysAgo: 12,
    stageDaysAgo: 11,
    followUp: 3,
    acts: [['CALL', 'Visited office, wants a call next week.', 'CALL_BACK_LATER', 11]],
  },
  {
    company: 'Naheed Supermarket',
    contact: 'Shazia Naheed',
    phone: '+923005550111',
    city: 'Karachi',
    industry: 'Retail',
    stores: 2,
    value: 35000,
    source: 'EMAIL_CAMPAIGN',
    detail: 'October newsletter',
    stage: 'LOST',
    owner: 'sales.bilal',
    createdDaysAgo: 35,
    stageDaysAgo: 10,
    lostReason: 'Chose a cheaper local tool',
    acts: [
      ['EMAIL', 'Replied to newsletter, asked for pricing.', 'INTERESTED', 34],
      ['CALL', 'Price too high for 2 stores.', 'NOT_INTERESTED', 10],
    ],
  },
  {
    company: 'Dawood Pharmacy',
    contact: 'Hamza Dawood',
    phone: '+923005550112',
    city: 'Peshawar',
    industry: 'Pharmacy',
    stores: 4,
    value: 50000,
    source: 'COLD_CALL',
    stage: 'CONTACTED',
    owner: 'sales.bilal',
    createdDaysAgo: 20,
    stageDaysAgo: 19,
    followUp: -9,
    acts: [
      ['CALL', 'Wrong number on the listing.', 'WRONG_CONTACT', 19],
      ['CALL', 'Found the right number, asked to WhatsApp details.', 'NEEDS_MORE_INFO', 16],
      ['WHATSAPP', 'Sent brochure, no reply yet.', null, 15],
    ],
  },
  {
    company: 'Bundu Khan Restaurants',
    contact: 'Omer Khan',
    phone: '+923005550113',
    city: 'Lahore',
    industry: 'Restaurants',
    stores: 7,
    value: 95000,
    source: 'REFERRAL',
    detail: 'Referred by Green Valley',
    stage: 'QUALIFIED',
    owner: 'sales.hira',
    createdDaysAgo: 9,
    stageDaysAgo: 2,
    followUp: 4,
    acts: [
      ['CALL', 'Wants emergency alerts for kitchen fires.', 'INTERESTED', 8],
      ['MEETING', 'Demo booked for Thursday.', 'MEETING_BOOKED', 2],
    ],
  },
  {
    company: 'Sapphire Outlets',
    contact: 'Nida Hassan',
    email: 'nida@sapphire.example.com',
    city: 'Lahore',
    industry: 'Fashion',
    stores: 20,
    value: 300000,
    source: 'ADVERTISEMENT',
    detail: 'Dawn newspaper ad',
    stage: 'PROPOSAL',
    owner: 'sales.manager',
    createdDaysAgo: 28,
    stageDaysAgo: 16,
    followUp: -2,
    acts: [
      ['MEETING', 'Requirements workshop with 4 store managers.', 'MEETING_BOOKED', 24],
      ['EMAIL', 'Proposal sent for 20 outlets.', null, 16],
    ],
  },
  {
    company: 'Utility Plus',
    contact: 'Kamran Shah',
    phone: '+923005550115',
    city: 'Rawalpindi',
    industry: 'Retail',
    stores: 3,
    value: 38000,
    source: 'OTHER',
    detail: 'Trade association list',
    stage: 'NEW',
    owner: 'sales.hira',
    createdDaysAgo: 2,
    stageDaysAgo: 2,
    followUp: 0,
    acts: [],
  },
  {
    company: 'Gourmet Foods',
    contact: 'Tariq Mehmood',
    phone: '+923005550116',
    city: 'Lahore',
    industry: 'Food',
    stores: 25,
    value: 350000,
    source: 'EVENT',
    detail: 'Food Asia expo',
    stage: 'NEGOTIATION',
    owner: 'sales.manager',
    createdDaysAgo: 50,
    stageDaysAgo: 25,
    followUp: -4,
    acts: [
      ['MEETING', 'Met at Food Asia.', 'INTERESTED', 49],
      ['MEETING', 'Pilot proposal for 5 stores.', 'MEETING_BOOKED', 30],
      ['CALL', 'Legal review of contract still pending.', 'CALL_BACK_LATER', 25],
    ],
  },
  {
    company: 'Euro Store',
    contact: 'Sana Javed',
    phone: '+923005550117',
    city: 'Multan',
    industry: 'Retail',
    stores: 4,
    value: 52000,
    source: 'SOCIAL_MEDIA',
    detail: 'Instagram',
    stage: 'LOST',
    owner: 'sales.hira',
    createdDaysAgo: 22,
    stageDaysAgo: 7,
    lostReason: 'Not ready this year',
    acts: [['CALL', 'Will revisit next year.', 'NOT_INTERESTED', 7]],
  },
  {
    company: 'Pak Mobile Zone',
    contact: 'Adeel Akhtar',
    phone: '+923005550118',
    city: 'Faisalabad',
    industry: 'Electronics',
    stores: 6,
    value: 70000,
    source: 'COLD_CALL',
    stage: 'NEW',
    owner: null,
    createdDaysAgo: 4,
    stageDaysAgo: 4,
    acts: [],
  },
];

async function addLeads(ids: Map<string, string>): Promise<void> {
  if ((await prisma.lead.count()) > 0) {
    console.log('• leads already exist, skipped');
    return;
  }
  for (const l of LEADS) {
    const ownerId = l.owner ? (ids.get(l.owner) ?? null) : null;
    const actorId = ownerId ?? ids.get('sales.manager') ?? null;
    const converted = l.convertedSlug
      ? await prisma.business.findUnique({ where: { slug: l.convertedSlug }, select: { id: true } })
      : null;
    const calls = l.acts.filter((a) => a[0] === 'CALL').length;
    const messages = l.acts.filter((a) => a[0] === 'EMAIL' || a[0] === 'WHATSAPP').length;
    const meetings = l.acts.filter((a) => a[0] === 'MEETING').length;
    const lastOutcome = [...l.acts].reverse().find((a) => a[2])?.[2] ?? null;
    const lastAct = l.acts.length ? Math.min(...l.acts.map((a) => a[3])) : l.createdDaysAgo;
    const lead = await prisma.lead.create({
      data: {
        companyName: l.company,
        contactName: l.contact,
        contactTitle: l.title ?? null,
        phone: l.phone ?? null,
        email: l.email ?? null,
        city: l.city,
        country: 'PK',
        industry: l.industry,
        storeCount: l.stores,
        estimatedValue: l.value,
        currency: 'PKR',
        source: l.source,
        direction:
          l.direction ??
          (l.source === 'COLD_CALL' || l.source === 'EMAIL_CAMPAIGN' ? 'OUTBOUND' : 'INBOUND'),
        sourceDetail: l.detail ?? null,
        stage: l.stage,
        stageChangedAt: ago(l.stageDaysAgo * DAY),
        closedAt: l.stage === 'WON' || l.stage === 'LOST' ? ago(l.stageDaysAgo * DAY) : null,
        lostReason: l.lostReason ?? null,
        ownerId,
        createdById: actorId,
        nextFollowUpAt:
          l.followUp === undefined ? null : new Date(Date.now() + l.followUp * DAY + 2 * HOUR),
        lastActivityAt: ago(lastAct * DAY),
        callCount: calls,
        messageCount: messages,
        meetingCount: meetings,
        lastOutcome,
        convertedBusinessId: converted?.id ?? null,
        convertedAt: converted ? ago(l.stageDaysAgo * DAY) : null,
        createdAt: ago(l.createdDaysAgo * DAY),
      },
      select: { id: true },
    });
    await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: 'CREATED',
        toStage: 'NEW',
        actorId: l.source === 'WEBSITE' ? null : actorId,
        body: l.source === 'WEBSITE' ? 'From the website form' : null,
        createdAt: ago(l.createdDaysAgo * DAY),
      },
    });
    for (const [type, body, outcome, daysAgo] of l.acts) {
      await prisma.leadActivity.create({
        data: { leadId: lead.id, type, body, outcome, actorId, createdAt: ago(daysAgo * DAY) },
      });
    }
    if (l.stage !== 'NEW') {
      await prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          type: converted ? 'CONVERTED' : 'STAGE_CHANGED',
          fromStage: 'NEW',
          toStage: l.stage,
          body:
            l.stage === 'LOST'
              ? l.lostReason
              : converted
                ? `Became the SMA customer “${l.company}”`
                : null,
          actorId,
          createdAt: ago(l.stageDaysAgo * DAY),
        },
      });
    }
  }
  console.log(`✔ ${LEADS.length} sample leads`);
}

const FIRST = [
  'Ayesha',
  'Ahmed',
  'Fatima',
  'Usman',
  'Zainab',
  'Hassan',
  'Mariam',
  'Bilal',
  'Sara',
  'Imran',
  'Hina',
  'Asad',
  'Noor',
  'Kamran',
  'Rabia',
  'Fahad',
  'Sana',
  'Waqas',
  'Amna',
  'Danish',
];
const LAST = [
  'Khan',
  'Malik',
  'Butt',
  'Sheikh',
  'Qureshi',
  'Chaudhry',
  'Raza',
  'Abbasi',
  'Siddiqui',
  'Mirza',
];

async function addStoreCustomers(): Promise<void> {
  for (const slug of ['abc-retail', 'khadi']) {
    const business = await prisma.business.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        stores: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (!business) continue;
    if ((await prisma.storeCustomer.count({ where: { businessId: business.id } })) > 0) {
      console.log(`• ${business.name} already has store customers, skipped`);
      continue;
    }
    const count = slug === 'abc-retail' ? 24 : 16;
    const cities =
      slug === 'abc-retail'
        ? ['Lahore', 'Lahore', 'Islamabad']
        : ['Karachi', 'Lahore', 'Islamabad'];
    for (let i = 0; i < count; i += 1) {
      const first = FIRST[(i * 7 + slug.length) % FIRST.length]!;
      const last = LAST[(i * 3) % LAST.length]!;
      const optIn = i % 3 !== 2;
      const tags = [
        ...(i % 5 === 0 ? ['vip'] : []),
        ...(i % 4 === 1 ? ['wholesale'] : []),
        ...(i % 6 === 3 ? ['eid-2026'] : []),
      ];
      await prisma.storeCustomer.create({
        data: {
          businessId: business.id,
          storeId: business.stores.length ? business.stores[i % business.stores.length]!.id : null,
          name: `${first} ${last}`,
          phone:
            i % 7 === 6
              ? null
              : `+92300555${String(2000 + i + (slug === 'khadi' ? 100 : 0)).padStart(4, '0')}`,
          email:
            i % 4 === 3 ? null : `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
          city: cities[i % cities.length]!,
          tags,
          notes: i % 5 === 0 ? 'Prefers WhatsApp updates about new arrivals.' : null,
          marketingOptIn: optIn,
          optInAt: optIn ? ago((i + 3) * DAY) : null,
          createdAt: ago((i + 3) * DAY),
        },
      });
    }
    // A draft campaign ready to try (email lands in the local Mailpit inbox in development).
    const author = await prisma.roleAssignment.findFirst({
      where: { businessId: business.id, scopeType: 'BUSINESS', revokedAt: null },
      select: { userId: true },
    });
    await prisma.customerCampaign.create({
      data: {
        businessId: business.id,
        name: 'Eid sale announcement',
        channel: 'EMAIL',
        subject: `{{name}}, our Eid sale starts this Friday`,
        body: `Hi {{name}},\n\nOur Eid sale starts this Friday at all ${business.name} stores: up to 30% off. Show this email at the counter for an extra gift.\n\nSee you soon!`,
        audience: { storeIds: [], tags: [] },
        createdById: author?.userId ?? null,
      },
    });
    console.log(`✔ ${count} store customers and a draft email campaign for ${business.name}`);
  }
}

async function main(): Promise<void> {
  const local = JSON.parse(
    readFileSync(join(__dirname, '..', 'demo-accounts.local.json'), 'utf8'),
  ) as { salesUsers?: SalesUser[] };
  if (!local.salesUsers?.length)
    throw new Error('Add "salesUsers" to apps/api/demo-accounts.local.json first.');
  const roles = await syncSystemRoles(prisma);
  const team = await salesTeam();
  const ids = await addSalesUsers(team, local.salesUsers, roles);
  await teamChat(team.groupId, ids);
  await addLeads(ids);
  await addStoreCustomers();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
