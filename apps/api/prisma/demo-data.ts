/**
 * Rich demo data for manual testing, added on top of the seed (run `npm run db:seed` first):
 * more staff in every store, groups with realistic history, direct chats, reactions and
 * replies, unread messages, emergency history, a completed and a draft campaign.
 *
 *   npm run db:demo -w @storeline/api
 *
 * Idempotent: does nothing if it already ran. New people share the demo accounts' password
 * (their password hash is copied from `alice`). All names, emails and phone numbers are
 * fictitious (example.com, 555 numbers).
 */
import '../src/load-env';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { SystemEventDto, SystemRoleKey } from '@storeline/shared';

const prisma = new PrismaClient();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo);

interface Person {
  username: string;
  displayName: string;
  role: SystemRoleKey;
  stores: string[];
  kind?: 'INTERNAL' | 'EXTERNAL';
  email?: string;
  phone?: string;
}

const NEW_PEOPLE: Person[] = [
  { username: 'emma.wilson', displayName: 'Emma Wilson', role: 'EMPLOYEE', stores: ['A'] },
  { username: 'frank.lee', displayName: 'Frank Lee', role: 'EMPLOYEE', stores: ['A'] },
  { username: 'helen.park', displayName: 'Helen Park', role: 'EMPLOYEE', stores: ['B'] },
  { username: 'ivan.ross', displayName: 'Ivan Ross', role: 'EMPLOYEE', stores: ['B'] },
  { username: 'security.b', displayName: 'Sophie Guard', role: 'SECURITY', stores: ['B'] },
  {
    username: 'manager.c',
    displayName: 'Carlos Mendes',
    role: 'STORE_MANAGER',
    stores: ['C'],
    email: 'carlos.mendes@example.com',
    phone: '+15555550103',
  },
  { username: 'liam.ortiz', displayName: 'Liam Ortiz', role: 'EMPLOYEE', stores: ['C'] },
  { username: 'mia.chen', displayName: 'Mia Chen', role: 'EMPLOYEE', stores: ['C'] },
  { username: 'nina.patel', displayName: 'Nina Patel', role: 'EMPLOYEE', stores: ['A', 'B'] },
  {
    username: 'customer.olivia',
    displayName: 'Olivia Brooks (customer)',
    role: 'CUSTOMER',
    stores: [],
    kind: 'EXTERNAL',
  },
];

type Line = [sender: string, body: string, minutesAgo: number];

/** Group history (oldest first). Times are minutes before now. */
const GROUP_HISTORY: Record<string, Line[]> = {
  'Store A Operations': [
    ['manager.a', 'Good morning team! Delivery truck arrives at 7:30 today.', 2 * 24 * 60 + 90],
    ['alice', 'I can take the cold storage check after unloading.', 2 * 24 * 60 + 80],
    ['bob', 'I will handle the front shelves and price labels.', 2 * 24 * 60 + 75],
    ['emma.wilson', 'Register 2 printer is low on paper, replacing it now.', 2 * 24 * 60 + 40],
    ['manager.a', 'Thanks Emma. Reminder: weekly stock count tomorrow at 6 pm.', 24 * 60 + 300],
    ['frank.lee', 'Can someone cover my 2–4 pm slot tomorrow? Doctor appointment.', 24 * 60 + 200],
    ['alice', 'I can cover it, Frank.', 24 * 60 + 190],
    ['manager.a', 'Approved, thanks both 👍', 24 * 60 + 185],
    ['security.a', 'Back entrance door is sticking again, logged a maintenance ticket.', 300],
    ['bob', 'Promo display for the weekend sale is up near the entrance.', 95],
    ['manager.a', 'Looks great Bob! Please send a photo to the Regional Managers group.', 60],
    ['emma.wilson', 'Customer asked if we will restock oat milk before Friday?', 12],
    ['frank.lee', 'Supplier says Thursday morning.', 5],
  ],
  'Store A Security': [
    ['security.a', 'Night shift handover: all doors checked, alarm set at 22:05.', 26 * 60],
    ['manager.a', 'Thanks Sam. Any incidents?', 25 * 60],
    ['security.a', 'None. One delivery van parked in the fire lane, driver moved it.', 25 * 60 - 5],
    ['security.a', 'CCTV camera 4 is flickering, technician booked for Thursday.', 180],
    ['manager.a', 'Noted, please keep an eye on the loading bay meanwhile.', 170],
  ],
  'Store B Operations': [
    ['manager.b', 'Welcome Helen and Ivan to Store B! 🎉', 3 * 24 * 60],
    ['helen.park', 'Thanks Ben, happy to be here!', 3 * 24 * 60 - 10],
    ['ivan.ross', 'Thank you! Ready for my first shift.', 3 * 24 * 60 - 15],
    ['carol', 'Fresh produce delivery was short 4 crates of apples.', 24 * 60 + 120],
    [
      'manager.b',
      'I will raise it with the supplier. Please note it on the delivery slip.',
      24 * 60 + 100,
    ],
    ['nina.patel', 'Covering Store B this afternoon, where do you need me?', 400],
    ['manager.b', 'Checkout 3 please, thanks Nina.', 395],
    ['security.b', 'Parking lot lights are out near row C, reported to the landlord.', 90],
    ['helen.park', 'Self-checkout 1 is frozen again 😩', 15],
    ['ivan.ross', 'Restarting it now.', 13],
  ],
  'Regional Managers': [
    ['bizadmin', 'Q4 sales targets are in the shared drive. Let us review on Monday.', 4 * 24 * 60],
    ['manager.a', 'Store A is at 92% of target this month.', 4 * 24 * 60 - 30],
    ['manager.b', 'Store B at 88%, the produce shortage hurt us a bit.', 4 * 24 * 60 - 40],
    ['manager.c', 'Store C at 104% thanks to airport traffic ✈️', 4 * 24 * 60 - 50],
    [
      'bizadmin',
      'Great work everyone. Carlos, can you share what is working at C?',
      4 * 24 * 60 - 55,
    ],
    [
      'manager.c',
      'Extended opening hours and the grab-and-go section. Will write it up.',
      3 * 24 * 60,
    ],
    ['bizadmin', 'Reminder: holiday rota due by Friday.', 120],
  ],
  'Business Announcements': [
    [
      'bizadmin',
      'New uniform policy starts next month. Details in the staff handbook.',
      5 * 24 * 60,
    ],
    ['bizadmin', 'Thank you all for a record-breaking weekend! 🙌', 2 * 24 * 60],
    ['bizadmin', 'Fire drill in all stores on Wednesday at 10:00. Please review exit routes.', 240],
  ],
};

const NEW_GROUPS: Array<{
  title: string;
  store: string | null;
  category: 'OPERATIONS' | 'SECURITY' | 'GENERAL';
  admins: string[];
  members: string[];
  history: Line[];
}> = [
  {
    title: 'Store C Team',
    store: 'C',
    category: 'OPERATIONS',
    admins: ['manager.c'],
    members: ['dave', 'liam.ortiz', 'mia.chen'],
    history: [
      ['manager.c', 'Hi team, flight delays today so expect a late evening rush.', 8 * 60],
      ['mia.chen', 'Got it, I will restock the snack wall before 6.', 7 * 60],
      ['liam.ortiz', 'Coffee machine descaling done ☕', 5 * 60],
      ['dave', 'Gate 12 kiosk needs more water bottles.', 3 * 60],
      ['manager.c', 'Liam, can you run a pallet over after lunch?', 170],
      ['liam.ortiz', 'On it.', 165],
    ],
  },
  {
    title: 'Store B Security',
    store: 'B',
    category: 'SECURITY',
    admins: ['manager.b'],
    members: ['security.b'],
    history: [
      ['security.b', 'Shift started, all clear.', 9 * 60],
      [
        'manager.b',
        'Thanks Sophie. Please check the stockroom lock, it was loose yesterday.',
        8 * 60,
      ],
      ['security.b', 'Lock tightened, works fine now.', 7 * 60],
    ],
  },
  {
    title: 'Weekend Social Club',
    store: null,
    category: 'GENERAL',
    admins: ['alice'],
    members: ['bob', 'emma.wilson', 'carol', 'helen.park', 'nina.patel', 'mia.chen'],
    history: [
      ['alice', 'Bowling on Saturday after closing? 🎳', 2 * 24 * 60],
      ['emma.wilson', 'Count me in!', 2 * 24 * 60 - 20],
      ['carol', 'Yes! Can we invite the Store B crew?', 2 * 24 * 60 - 25],
      ['helen.park', 'I am in 🙋‍♀️', 2 * 24 * 60 - 40],
      ['mia.chen', 'Airport shift until 9 but I will join after.', 30 * 60],
      ['alice', 'Booked lane 4 for 9:30 pm 🎉', 45],
    ],
  },
];

const DIRECTS: Array<{ between: [string, string]; history: Line[] }> = [
  {
    between: ['alice', 'bob'],
    history: [
      ['alice', 'Did you see the new rota?', 26 * 60],
      ['bob', 'Yes, I am on Saturday morning again 😅', 26 * 60 - 3],
      ['alice', 'Swap with me? I prefer mornings.', 26 * 60 - 5],
      ['bob', 'Deal! I will tell Maria.', 26 * 60 - 7],
    ],
  },
  {
    between: ['carol', 'manager.b'],
    history: [
      ['carol', 'Ben, can I leave 30 minutes early on Friday?', 6 * 60],
      ['manager.b', 'Sure, ask Helen to cover the till.', 5 * 60],
      ['carol', 'Thanks!', 5 * 60 - 2],
    ],
  },
  {
    between: ['manager.a', 'security.a'],
    history: [
      ['manager.a', 'Please walk the car park once more before closing tonight.', 100],
      ['security.a', 'Will do.', 95],
    ],
  },
  {
    between: ['bizadmin', 'manager.c'],
    history: [
      [
        'bizadmin',
        'Carlos, great results this month. Can you mentor Ben on the grab-and-go setup?',
        2 * 24 * 60,
      ],
      ['manager.c', 'Happy to. I will visit Store B on Tuesday.', 2 * 24 * 60 - 60],
      ['bizadmin', 'Perfect, thank you.', 2 * 24 * 60 - 65],
    ],
  },
  {
    between: ['nina.patel', 'alice'],
    history: [
      ['nina.patel', 'Hi Alice, where are the spare price guns kept?', 30],
      ['alice', 'Top shelf in the stockroom, left side.', 25],
      ['nina.patel', 'Found them, thanks!', 3],
    ],
  },
];

async function main(): Promise<void> {
  const business = await prisma.business.findUnique({ where: { slug: 'abc-retail' } });
  if (!business) throw new Error('Demo business not found. Run `npm run db:seed` first.');
  if (await prisma.user.findUnique({ where: { username: 'emma.wilson' } })) {
    console.log('• Demo data already present — nothing to do.');
    return;
  }
  const template = await prisma.user.findUniqueOrThrow({
    where: { username: 'alice' },
    select: { passwordHash: true },
  });
  const roles = Object.fromEntries(
    (
      await prisma.role.findMany({ where: { businessId: null }, select: { id: true, key: true } })
    ).map((r) => [r.key, r.id]),
  ) as Record<SystemRoleKey, string>;
  const stores = Object.fromEntries(
    (await prisma.store.findMany({ where: { businessId: business.id } })).map((s) => [s.code, s]),
  );

  await prisma.$transaction(
    async (tx) => {
      // ── People ──
      for (const p of NEW_PEOPLE) {
        const user = await tx.user.create({
          data: {
            username: p.username,
            displayName: p.displayName,
            kind: p.kind ?? 'INTERNAL',
            passwordHash: template.passwordHash,
            createdAt: at(10 * DAY),
            ...(p.email || p.phone
              ? { contact: { create: { email: p.email ?? null, phone: p.phone ?? null } } }
              : {}),
          },
        });
        await tx.businessMembership.create({ data: { businessId: business.id, userId: user.id } });
        for (const code of p.stores)
          await tx.storeMembership.create({
            data: { businessId: business.id, storeId: stores[code]!.id, userId: user.id },
          });
        if (p.role === 'CUSTOMER' || p.role === 'BUSINESS_ADMIN') {
          await tx.roleAssignment.create({
            data: {
              userId: user.id,
              roleId: roles[p.role],
              scopeType: 'BUSINESS',
              businessId: business.id,
            },
          });
        } else {
          for (const code of p.stores)
            await tx.roleAssignment.create({
              data: {
                userId: user.id,
                roleId: roles[p.role],
                scopeType: 'STORE',
                businessId: business.id,
                storeId: stores[code]!.id,
              },
            });
        }
      }
      const users = Object.fromEntries(
        (
          await tx.user.findMany({
            where: { businessMemberships: { some: { businessId: business.id } } },
            select: { id: true, username: true },
          })
        ).map((u) => [u.username, u.id]),
      );
      const id = (username: string) => {
        const value = users[username];
        if (!value) throw new Error(`Unknown demo user ${username}`);
        return value;
      };

      // ── Helpers ──
      const addMembers = async (conversationId: string, usernames: string[], joinedAt: Date) => {
        let added = 0;
        for (const u of usernames) {
          const exists = await tx.conversationMember.findUnique({
            where: { conversationId_userId: { conversationId, userId: id(u) } },
          });
          if (exists) continue;
          await tx.conversationMember.create({
            data: { conversationId, userId: id(u), joinedAt },
          });
          added += 1;
        }
        if (added)
          await tx.conversation.update({
            where: { id: conversationId },
            data: { memberCount: { increment: added } },
          });
      };

      const writeHistory = async (
        conversationId: string,
        lines: Line[],
        options: { systemFirst?: SystemEventDto; unreadFor?: Record<string, number> } = {},
      ) => {
        const conversation = await tx.conversation.findUniqueOrThrow({
          where: { id: conversationId },
          select: { lastSeq: true },
        });
        let seq = conversation.lastSeq;
        let last: { id: string; createdAt: Date } | null = null;
        const ids: string[] = [];
        for (const [sender, body, minutesAgo] of lines) {
          seq += 1;
          const message = await tx.message.create({
            data: {
              conversationId,
              seq,
              senderId: id(sender),
              clientMessageId: randomUUID(),
              kind: 'TEXT',
              body,
              state: 'DISPATCHED',
              createdAt: at(minutesAgo * MIN),
            },
            select: { id: true, createdAt: true },
          });
          ids.push(message.id);
          last = message;
        }
        if (!last) return ids;
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastSeq: seq, lastMessageId: last.id, lastActivityAt: last.createdAt },
        });
        // Everyone has received everything; most have read it, a few have unread messages.
        const members = await tx.conversationMember.findMany({
          where: { conversationId, leftAt: null },
          select: { id: true, userId: true },
        });
        for (const m of members) {
          const unread =
            Object.entries(options.unreadFor ?? {}).find(([u]) => users[u] === m.userId)?.[1] ?? 0;
          await tx.conversationMember.update({
            where: { id: m.id },
            data: { lastDeliveredSeq: seq, lastReadSeq: Math.max(0, seq - unread) },
          });
        }
        return ids;
      };

      const react = async (messageId: string, username: string, emoji: string) =>
        tx.messageReaction.create({ data: { messageId, userId: id(username), emoji } });

      // ── Existing groups: new members and history ──
      const groups = Object.fromEntries(
        (
          await tx.conversation.findMany({
            where: { businessId: business.id, type: 'GROUP' },
            select: { id: true, title: true },
          })
        ).map((g) => [g.title!, g.id]),
      );
      await addMembers(
        groups['Store A Operations']!,
        ['emma.wilson', 'frank.lee', 'nina.patel'],
        at(10 * DAY),
      );
      await addMembers(
        groups['Store B Operations']!,
        ['helen.park', 'ivan.ross', 'security.b', 'nina.patel'],
        at(10 * DAY),
      );
      await addMembers(groups['Regional Managers']!, ['manager.c'], at(10 * DAY));
      await addMembers(
        groups['Business Announcements']!,
        NEW_PEOPLE.filter((p) => p.kind !== 'EXTERNAL').map((p) => p.username),
        at(10 * DAY),
      );

      const opsA = await writeHistory(
        groups['Store A Operations']!,
        GROUP_HISTORY['Store A Operations']!,
        {
          unreadFor: { alice: 3, bob: 1, 'manager.a': 2 },
        },
      );
      await react(opsA[7]!, 'alice', '👍');
      await react(opsA[7]!, 'frank.lee', '❤️');
      await react(opsA[9]!, 'manager.a', '🔥');
      await writeHistory(groups['Store A Security']!, GROUP_HISTORY['Store A Security']!);
      const opsB = await writeHistory(
        groups['Store B Operations']!,
        GROUP_HISTORY['Store B Operations']!,
        {
          unreadFor: { carol: 2, 'manager.b': 1 },
        },
      );
      await react(opsB[0]!, 'carol', '🎉');
      await react(opsB[0]!, 'nina.patel', '🎉');
      await writeHistory(groups['Regional Managers']!, GROUP_HISTORY['Regional Managers']!, {
        unreadFor: { 'manager.b': 1 },
      });
      await writeHistory(
        groups['Business Announcements']!,
        GROUP_HISTORY['Business Announcements']!,
        {
          unreadFor: { dave: 2, 'liam.ortiz': 1 },
        },
      );
      await tx.pinnedMessage.create({
        data: {
          conversationId: groups['Store A Operations']!,
          messageId: opsA[4]!,
          pinnedById: id('manager.a'),
        },
      });

      // ── New groups ──
      for (const g of NEW_GROUPS) {
        const members = [...new Set([...g.admins, ...g.members])];
        const conversation = await tx.conversation.create({
          data: {
            businessId: business.id,
            storeId: g.store ? stores[g.store]!.id : null,
            type: 'GROUP',
            title: g.title,
            category: g.category,
            createdById: id(g.admins[0]!),
            createdAt: at(4 * DAY),
            memberCount: members.length,
            members: {
              create: members.map((u) => ({
                userId: id(u),
                role: g.admins.includes(u) ? ('ADMIN' as const) : ('MEMBER' as const),
                addedById: id(g.admins[0]!),
                joinedAt: at(4 * DAY),
              })),
            },
          },
        });
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            seq: 1,
            senderId: id(g.admins[0]!),
            clientMessageId: randomUUID(),
            kind: 'SYSTEM',
            systemEvent: { type: 'group_created', actorId: id(g.admins[0]!), title: g.title },
            state: 'DISPATCHED',
            createdAt: at(4 * DAY),
          },
        });
        await tx.conversation.update({ where: { id: conversation.id }, data: { lastSeq: 1 } });
        const lines = await writeHistory(conversation.id, g.history, {
          unreadFor: g.title === 'Weekend Social Club' ? { bob: 2, carol: 1 } : {},
        });
        if (g.title === 'Weekend Social Club') {
          await react(lines[0]!, 'bob', '🎳');
          await react(lines[5]!, 'emma.wilson', '🎉');
          await react(lines[5]!, 'helen.park', '❤️');
        }
      }

      // ── Direct chats ──
      for (const d of DIRECTS) {
        const ids = d.between.map(id);
        const directKey = `${business.id}:${[...ids].sort().join(':')}`;
        let conversation = await tx.conversation.findUnique({ where: { directKey } });
        conversation ??= await tx.conversation.create({
          data: {
            businessId: business.id,
            type: 'DIRECT',
            directKey,
            createdById: ids[0],
            createdAt: at(3 * DAY),
            memberCount: 2,
            members: {
              create: ids.map((userId) => ({ userId, addedById: ids[0], joinedAt: at(3 * DAY) })),
            },
          },
        });
        // Alice has not yet read Nina's last message.
        await writeHistory(conversation.id, d.history, {
          unreadFor: d.between.includes('nina.patel') ? { alice: 1 } : {},
        });
      }

      // ── Emergency contacts for Store B ──
      const hasContacts = await tx.emergencyContact.count({ where: { storeId: stores.B!.id } });
      if (!hasContacts)
        await tx.emergencyContact.createMany({
          data: [
            {
              businessId: business.id,
              storeId: stores.B!.id,
              userId: id('manager.b'),
              priority: 1,
            },
            {
              businessId: business.id,
              storeId: stores.B!.id,
              userId: id('security.b'),
              priority: 2,
            },
          ],
        });

      // ── Emergency history: one resolved (Store B), one cancelled (Store C) ──
      const incident = async (o: {
        store: 'B' | 'C';
        reporter: string;
        responder: string;
        category: 'MEDICAL' | 'SECURITY' | 'FIRE' | 'OTHER';
        description: string;
        minutesAgo: number;
        outcome: 'RESOLVED' | 'CANCELLED';
        note?: string;
      }) => {
        const store = stores[o.store]!;
        const raised = at(o.minutesAgo * MIN);
        const ackAt = new Date(raised.getTime() + 2 * MIN);
        const closedAt = new Date(raised.getTime() + 25 * MIN);
        const members = [o.reporter, o.responder];
        const conversation = await tx.conversation.create({
          data: {
            businessId: business.id,
            storeId: store.id,
            type: 'EMERGENCY',
            title: `Emergency · ${store.name}`,
            createdById: id(o.reporter),
            createdAt: raised,
            memberCount: members.length,
            members: {
              create: members.map((u) => ({
                userId: id(u),
                addedById: id(o.reporter),
                joinedAt: raised,
              })),
            },
          },
        });
        const timeline: Array<[string, string | null, SystemEventDto | null, Date]> = [
          [
            o.reporter,
            null,
            {
              type: 'emergency_raised',
              actorId: id(o.reporter),
              category: o.category,
              storeName: store.name,
            },
            raised,
          ],
          [o.reporter, o.description, null, new Date(raised.getTime() + 10_000)],
        ];
        if (o.outcome === 'RESOLVED') {
          timeline.push(
            [
              o.responder,
              null,
              { type: 'emergency_acknowledged', actorId: id(o.responder) },
              ackAt,
            ],
            [
              o.responder,
              'On my way, stay with the customer.',
              null,
              new Date(ackAt.getTime() + 20_000),
            ],
            [o.responder, null, { type: 'emergency_resolved', actorId: id(o.responder) }, closedAt],
          );
        } else {
          timeline.push([
            o.reporter,
            null,
            { type: 'emergency_cancelled', actorId: id(o.reporter) },
            new Date(raised.getTime() + MIN),
          ]);
        }
        let seq = 0;
        let lastId = '';
        for (const [sender, body, systemEvent, createdAt] of timeline) {
          seq += 1;
          const m = await tx.message.create({
            data: {
              conversationId: conversation.id,
              seq,
              senderId: id(sender),
              clientMessageId: randomUUID(),
              kind: systemEvent ? 'SYSTEM' : 'TEXT',
              body,
              systemEvent: systemEvent ? (systemEvent as Prisma.InputJsonValue) : Prisma.JsonNull,
              state: 'DISPATCHED',
              createdAt,
            },
          });
          lastId = m.id;
        }
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastSeq: seq, lastMessageId: lastId, lastActivityAt: timeline.at(-1)![3] },
        });
        await tx.conversationMember.updateMany({
          where: { conversationId: conversation.id },
          data: { lastDeliveredSeq: seq, lastReadSeq: seq },
        });
        const created = await tx.emergencyIncident.create({
          data: {
            businessId: business.id,
            storeId: store.id,
            reporterId: id(o.reporter),
            clientIncidentId: randomUUID(),
            conversationId: conversation.id,
            category: o.category,
            description: o.description,
            status: o.outcome,
            level: 1,
            maxLevel: 2,
            ackTimeoutSeconds: 120,
            acknowledgedAt: o.outcome === 'RESOLVED' ? ackAt : null,
            acknowledgedById: o.outcome === 'RESOLVED' ? id(o.responder) : null,
            resolvedAt: o.outcome === 'RESOLVED' ? closedAt : null,
            resolvedById: o.outcome === 'RESOLVED' ? id(o.responder) : null,
            resolutionNote: o.note ?? null,
            cancelledAt: o.outcome === 'CANCELLED' ? new Date(raised.getTime() + MIN) : null,
            createdAt: raised,
          },
        });
        await tx.emergencyIncidentRecipient.create({
          data: {
            incidentId: created.id,
            userId: id(o.responder),
            level: 1,
            source: 'CONTACT',
            state: o.outcome === 'RESOLVED' ? 'ACKNOWLEDGED' : 'READ',
            notifiedAt: raised,
            sentAt: raised,
            deliveredAt: new Date(raised.getTime() + 2_000),
            readAt: new Date(raised.getTime() + 40_000),
            acknowledgedAt: o.outcome === 'RESOLVED' ? ackAt : null,
          },
        });
        const events: Array<[string, string | null, number | null, string[], Date]> = [
          ['CREATED', id(o.reporter), null, [], raised],
          ['NOTIFIED', null, 1, [id(o.responder)], raised],
        ];
        if (o.outcome === 'RESOLVED')
          events.push(
            ['ACKNOWLEDGED', id(o.responder), 1, [], ackAt],
            ['RESOLVED', id(o.responder), 1, [], closedAt],
          );
        else events.push(['CANCELLED', id(o.reporter), 1, [], new Date(raised.getTime() + MIN)]);
        for (const [type, actorId, level, userIds, createdAt] of events)
          await tx.emergencyIncidentEvent.create({
            data: {
              incidentId: created.id,
              type: type as 'CREATED',
              actorId,
              level,
              userIds,
              createdAt,
            },
          });
      };
      await incident({
        store: 'B',
        reporter: 'helen.park',
        responder: 'manager.b',
        category: 'MEDICAL',
        description: 'Customer slipped near aisle 5 and hurt their ankle.',
        minutesAgo: 2 * 24 * 60 + 200,
        outcome: 'RESOLVED',
        note: 'First aid given, customer collected by family. Wet-floor sign added.',
      });
      await incident({
        store: 'C',
        reporter: 'mia.chen',
        responder: 'manager.c',
        category: 'SECURITY',
        description: 'Suspicious bag left at the entrance.',
        minutesAgo: 20 * 60,
        outcome: 'CANCELLED',
      });

      // ── Campaigns: one completed (with Announcements channels), one draft ──
      const admin = id('bizadmin');
      const recipients = await tx.user.findMany({
        where: {
          id: { not: admin },
          kind: 'INTERNAL',
          status: 'ACTIVE',
          businessMemberships: { some: { businessId: business.id, status: 'ACTIVE' } },
        },
        select: { id: true },
      });
      const sentAt = at(26 * HOUR);
      const body =
        'Weekend opening hours: all stores open 8 am – 10 pm on Saturday and Sunday. Thank you for your flexibility!';
      const completed = await tx.bulkCampaign.create({
        data: {
          businessId: business.id,
          createdById: admin,
          clientCampaignId: randomUUID(),
          name: 'Weekend opening hours',
          description: 'Sent to every staff member',
          body,
          audience: {
            everyone: true,
            storeIds: [],
            groupIds: [],
            roleKeys: [],
            includeCustomers: false,
          },
          status: 'COMPLETED',
          createdAt: new Date(sentAt.getTime() - 10 * MIN),
          startedAt: sentAt,
          materializedAt: sentAt,
          completedAt: new Date(sentAt.getTime() + MIN),
          totalRecipients: recipients.length,
          lastDispatchAt: sentAt,
        },
      });
      for (const [i, r] of recipients.entries()) {
        const channelKey = `${business.id}:${r.id}`;
        let channel = await tx.conversation.findUnique({ where: { channelKey } });
        channel ??= await tx.conversation.create({
          data: {
            businessId: business.id,
            type: 'BROADCAST',
            channelKey,
            title: `Announcements · ${business.name}`,
            description: 'Announcements from your organisation. Replies are turned off.',
            postingPolicy: 'ADMINS_ONLY',
            fileSharingPolicy: 'ADMINS_ONLY',
            createdById: admin,
            memberCount: 1,
            createdAt: sentAt,
            members: { create: [{ userId: r.id, addedById: admin, joinedAt: sentAt }] },
          },
        });
        const seq = channel.lastSeq + 1;
        const message = await tx.message.create({
          data: {
            conversationId: channel.id,
            seq,
            senderId: admin,
            clientMessageId: randomUUID(),
            kind: 'TEXT',
            body,
            state: 'DISPATCHED',
            createdAt: sentAt,
          },
        });
        await tx.conversation.update({
          where: { id: channel.id },
          data: { lastSeq: seq, lastMessageId: message.id, lastActivityAt: sentAt },
        });
        // Realistic report: most read it, some only received it, two have not opened the app.
        const read = i % 5 !== 0;
        const delivered = i % 7 !== 3;
        await tx.conversationMember.updateMany({
          where: { conversationId: channel.id, userId: r.id },
          data: { lastDeliveredSeq: delivered ? seq : 0, lastReadSeq: delivered && read ? seq : 0 },
        });
        await tx.bulkCampaignRecipient.create({
          data: {
            campaignId: completed.id,
            userId: r.id,
            state: 'SENT',
            messageId: message.id,
            processedAt: sentAt,
          },
        });
      }
      await tx.bulkCampaign.create({
        data: {
          businessId: business.id,
          createdById: admin,
          clientCampaignId: randomUUID(),
          name: 'Holiday schedule reminder',
          description: 'Draft — review and send',
          body: 'Reminder: please submit your holiday availability in the rota app by Friday 5 pm.',
          audience: {
            everyone: false,
            storeIds: [stores.A!.id, stores.B!.id],
            groupIds: [],
            roleKeys: [],
            includeCustomers: false,
          },
          status: 'DRAFT',
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'demo.data_loaded',
          businessId: business.id,
          metadata: { people: NEW_PEOPLE.length },
        },
      });
    },
    { timeout: 120_000 },
  );
  console.log(
    `✔ Demo data added to ABC Retail Group: ${NEW_PEOPLE.length} people, ${NEW_GROUPS.length} new groups, ${DIRECTS.length} direct chats, emergency history and campaigns.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
