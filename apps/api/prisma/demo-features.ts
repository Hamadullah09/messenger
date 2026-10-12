/**
 * Demo data for store tasks, shifts, status updates, and a poll and an event in group chats
 * (development only). Uses the ABC Retail Group demo business.
 *
 *   npm run db:demo-features -w @storeline/api
 *
 * Idempotent: each part is skipped when it already exists. Text is made up.
 */
import '../src/load-env';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type TaskPriority } from '@prisma/client';

const prisma = new PrismaClient();
const now = new Date();
const at = (dayOffset: number, hour: number, minute = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute);

async function main(): Promise<void> {
  const business = await prisma.business.findFirst({
    where: { name: 'ABC Retail Group', deletedAt: null },
    select: { id: true },
  });
  if (!business) {
    console.log('ABC Retail Group not found; run the demo seed first.');
    return;
  }
  const stores = await prisma.store.findMany({
    where: { businessId: business.id, deletedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      memberships: {
        where: { status: 'ACTIVE' },
        select: { user: { select: { id: true, displayName: true } } },
      },
    },
  });
  const managerAssignment = await prisma.roleAssignment.findFirst({
    where: { businessId: business.id, revokedAt: null, role: { key: 'STORE_MANAGER' } },
    select: { userId: true },
  });
  const manager = managerAssignment?.userId ?? stores[0]?.memberships[0]?.user.id;
  if (!manager) {
    console.log('No staff found.');
    return;
  }

  // 1. Tasks
  if ((await prisma.storeTask.count({ where: { businessId: business.id } })) === 0) {
    const plan: Array<[number, string, TaskPriority, number | null, boolean, string?]> = [
      [0, 'Restock the drinks fridge before lunch', 'HIGH', 0.2, false],
      [0, 'Check fire extinguisher dates', 'NORMAL', 2, false, 'Write the dates on the checklist by the door.'],
      [0, 'Count the cash float for the evening shift', 'URGENT', -0.1, false],
      [1, 'Put up the new weekend offer posters', 'NORMAL', 1, false],
      [1, 'Clean the stock room shelves', 'LOW', 4, true],
      [2, 'Return the damaged delivery to the supplier', 'HIGH', -1, false, 'Invoice 4471 — 3 boxes.'],
      [2, 'Train the new cashier on returns', 'NORMAL', 3, true],
    ];
    for (const [s, title, priority, dueDays, done, notes] of plan) {
      const store = stores[s % stores.length]!;
      const assignee = store.memberships[(title.length % Math.max(1, store.memberships.length))]?.user.id ?? null;
      await prisma.storeTask.create({
        data: {
          businessId: business.id,
          storeId: store.id,
          title,
          notes: notes ?? null,
          priority,
          dueAt: dueDays === null ? null : new Date(now.getTime() + dueDays * 86_400_000),
          assigneeId: assignee,
          createdById: manager,
          status: done ? 'DONE' : 'OPEN',
          completedAt: done ? new Date(now.getTime() - 3_600_000) : null,
          completedById: done ? assignee : null,
        },
      });
    }
    console.log(`Tasks: added ${plan.length}.`);
  } else console.log('Tasks: already present, skipped.');

  // 2. Shifts for this week
  if ((await prisma.shift.count({ where: { businessId: business.id } })) === 0) {
    let count = 0;
    const monday = (now.getDay() + 6) % 7;
    for (const store of stores) {
      const people = store.memberships.slice(0, 4).map((m) => m.user.id);
      for (let d = 0; d < 7; d++) {
        for (const [i, userId] of people.entries()) {
          if ((d + i) % 3 === 2) continue; // days off
          const morning = i % 2 === 0;
          await prisma.shift.create({
            data: {
              businessId: business.id,
              storeId: store.id,
              userId,
              startsAt: at(d - monday, morning ? 8 : 15),
              endsAt: at(d - monday, morning ? 16 : 23),
              title: morning ? 'Morning' : 'Evening',
              createdById: manager,
            },
          });
          count += 1;
        }
      }
    }
    console.log(`Shifts: added ${count}.`);
  } else console.log('Shifts: already present, skipped.');

  // 3. Status updates
  if ((await prisma.statusPost.count({ where: { businessId: business.id, deletedAt: null } })) === 0) {
    const expiresAt = new Date(now.getTime() + 20 * 3_600_000);
    await prisma.statusPost.createMany({
      data: [
        {
          businessId: business.id,
          authorId: manager,
          text: 'Team meeting today at 5 pm in the Downtown store. Snacks on us! 🍕',
          background: '#ea580c',
          expiresAt,
          createdAt: new Date(now.getTime() - 2 * 3_600_000),
        },
        {
          businessId: business.id,
          storeId: stores[1]?.id ?? null,
          authorId: manager,
          text: 'Riverside: new stock arrives at 9 am tomorrow. Please be on time.',
          background: '#0f766e',
          expiresAt,
          createdAt: new Date(now.getTime() - 3_600_000),
        },
        {
          businessId: business.id,
          authorId: stores[0]?.memberships[1]?.user.id ?? manager,
          text: 'Best sales day this month — thank you everyone! 🎉',
          background: '#7c3aed',
          expiresAt,
          createdAt: new Date(now.getTime() - 30 * 60_000),
        },
      ],
    });
    console.log('Status: added 3 updates.');
  } else console.log('Status: already present, skipped.');

  // 4. A poll and an event in "Regional Managers"
  const group = await prisma.conversation.findFirst({
    where: { businessId: business.id, type: 'GROUP', title: 'Regional Managers' },
    select: { id: true, members: { where: { leftAt: null }, select: { userId: true } } },
  });
  if (group && !(await prisma.message.findFirst({ where: { conversationId: group.id, kind: 'POLL' } }))) {
    const sender = group.members[0]?.userId ?? manager;
    const write = async (kind: 'POLL' | 'EVENT', body: string, meta: Prisma.InputJsonValue) => {
      const { lastSeq } = await prisma.conversation.update({
        where: { id: group.id },
        data: { lastSeq: { increment: 1 }, lastActivityAt: new Date() },
        select: { lastSeq: true },
      });
      const message = await prisma.message.create({
        data: {
          conversationId: group.id,
          seq: lastSeq,
          senderId: sender,
          clientMessageId: randomUUID(),
          kind,
          body,
          meta,
          state: 'DISPATCHED',
        },
        select: { id: true },
      });
      await prisma.conversation.update({ where: { id: group.id }, data: { lastMessageId: message.id } });
      return message.id;
    };
    const poll = await write('POLL', 'Which day works for the quarterly review?', {
      type: 'poll',
      options: ['Monday', 'Wednesday', 'Friday'],
      multiple: false,
    });
    for (const [i, m] of group.members.entries()) {
      if (i === 0) continue;
      await prisma.pollVote.create({ data: { messageId: poll, userId: m.userId, option: i % 3 } });
    }
    const event = await write('EVENT', 'Quarterly review', {
      type: 'event',
      startsAt: at(3, 15).toISOString(),
      endsAt: at(3, 17).toISOString(),
      location: 'Head office, meeting room 2',
      description: 'Sales, staffing and the new store openings.',
    });
    for (const [i, m] of group.members.entries()) {
      await prisma.eventResponse.create({
        data: { messageId: event, userId: m.userId, response: i % 3 === 2 ? 'MAYBE' : 'GOING' },
      });
    }
    console.log('Group chat: added a poll and an event in "Regional Managers".');
  } else console.log('Poll/event: already present or group missing, skipped.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
