/**
 * Development/test seed. Synchronises system roles (always) and creates demo tenants
 * (once). All people, emails and phone numbers are fictitious (example.com, 555 numbers).
 *
 * Demo accounts share the password in SEED_PASSWORD (apps/api/.env). If it is not set, a
 * random password is generated and printed once.
 */
import '../src/load-env';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_BUSINESS_POLICY,
  SYSTEM_ROLES,
  type SystemEventDto,
  type SystemRoleKey,
} from '@storeline/shared';
import { syncSystemRoles } from '../src/modules/authorization/system-roles';
import { PasswordService } from '../src/modules/auth/password.service';

const prisma = new PrismaClient();
const passwords = new PasswordService();

interface DemoUser {
  username: string;
  displayName: string;
  role: SystemRoleKey;
  stores?: string[];
  email?: string;
  phone?: string;
}

async function main(): Promise<void> {
  const roles = await syncSystemRoles(prisma);
  console.log('✔ System roles synchronised');

  let password = process.env.SEED_PASSWORD;
  if (!password) {
    password = randomBytes(12).toString('base64url');
    console.log(`ℹ SEED_PASSWORD not set. Generated demo password: ${password}`);
  }
  if (password.length < 12) throw new Error('SEED_PASSWORD must be at least 12 characters');
  const passwordHash = await passwords.hash(password);

  if (!(await prisma.user.findUnique({ where: { username: 'superadmin' } }))) {
    const admin = await prisma.user.create({
      data: { username: 'superadmin', displayName: 'Platform Admin', passwordHash },
    });
    await prisma.roleAssignment.create({
      data: { userId: admin.id, roleId: roles.SUPER_ADMIN, scopeType: 'PLATFORM' },
    });
    console.log('✔ Created superadmin (two-step verification is set up at first sign-in)');
  }

  await seedBusiness(
    {
      slug: 'abc-retail',
      name: 'ABC Retail Group',
      timeZone: 'America/New_York',
      stores: [
        { code: 'A', name: 'Store A — Downtown' },
        { code: 'B', name: 'Store B — Riverside' },
        { code: 'C', name: 'Store C — Airport' },
      ],
      users: [
        { username: 'bizadmin', displayName: 'Grace Admin', role: 'BUSINESS_ADMIN' },
        {
          username: 'manager.a',
          displayName: 'Maria Manager',
          role: 'STORE_MANAGER',
          stores: ['A'],
          email: 'maria.manager@example.com',
          phone: '+15555550101',
        },
        {
          username: 'manager.b',
          displayName: 'Ben Manager',
          role: 'STORE_MANAGER',
          stores: ['B'],
          email: 'ben.manager@example.com',
          phone: '+15555550102',
        },
        { username: 'security.a', displayName: 'Sam Security', role: 'SECURITY', stores: ['A'] },
        { username: 'alice', displayName: 'Alice Anders', role: 'EMPLOYEE', stores: ['A'] },
        { username: 'bob', displayName: 'Bob Brown', role: 'EMPLOYEE', stores: ['A'] },
        { username: 'carol', displayName: 'Carol Chen', role: 'EMPLOYEE', stores: ['B'] },
        { username: 'dave', displayName: 'Dave Diaz', role: 'EMPLOYEE', stores: ['C'] },
      ],
      groups: [
        {
          title: 'Store A Operations',
          store: 'A',
          category: 'OPERATIONS',
          members: ['manager.a', 'alice', 'bob', 'security.a'],
          admins: ['manager.a'],
        },
        {
          title: 'Store A Security',
          store: 'A',
          category: 'SECURITY',
          members: ['manager.a', 'security.a'],
          admins: ['manager.a'],
        },
        {
          title: 'Store B Operations',
          store: 'B',
          category: 'OPERATIONS',
          members: ['manager.b', 'carol'],
          admins: ['manager.b'],
        },
        {
          title: 'Regional Managers',
          category: 'MANAGEMENT',
          members: ['bizadmin', 'manager.a', 'manager.b'],
          admins: ['bizadmin'],
        },
        {
          title: 'Business Announcements',
          category: 'ANNOUNCEMENTS',
          members: [
            'bizadmin',
            'manager.a',
            'manager.b',
            'security.a',
            'alice',
            'bob',
            'carol',
            'dave',
          ],
          admins: ['bizadmin'],
          adminsOnly: true,
        },
      ],
      directs: [
        {
          between: ['alice', 'manager.a'],
          messages: [
            'Hi Maria, the delivery for today arrived early.',
            'Thanks Alice! Please check the cold storage first.',
          ],
        },
      ],
    },
    roles,
    passwordHash,
  );

  await seedBusiness(
    {
      slug: 'northwind-pharmacy',
      name: 'Northwind Pharmacy',
      timeZone: 'Europe/London',
      stores: [{ code: 'NW1', name: 'Northwind High Street' }],
      users: [
        { username: 'nw.admin', displayName: 'Nadia Northwind', role: 'BUSINESS_ADMIN' },
        { username: 'nw.staff', displayName: 'Noah Staff', role: 'EMPLOYEE', stores: ['NW1'] },
      ],
      groups: [
        {
          title: 'High Street Team',
          store: 'NW1',
          category: 'OPERATIONS',
          members: ['nw.admin', 'nw.staff'],
          admins: ['nw.admin'],
        },
      ],
      directs: [],
    },
    roles,
    passwordHash,
  );

  // Store A: Maria is the primary emergency contact, Sam (security) the backup. Other stores
  // use the fallback (store managers, then business admins).
  await seedEmergencyContacts('abc-retail', 'A', ['manager.a', 'security.a']);
}

/** Idempotent: only sets contacts for a store that has none (safe to re-run on existing data). */
async function seedEmergencyContacts(
  slug: string,
  code: string,
  usernames: string[],
): Promise<void> {
  const store = await prisma.store.findFirst({
    where: { code, business: { slug } },
    select: { id: true, businessId: true, _count: { select: { emergencyContacts: true } } },
  });
  if (!store || store._count.emergencyContacts > 0) return;
  const users = await prisma.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true, username: true },
  });
  const ids = usernames.map((u) => users.find((row) => row.username === u)?.id);
  if (ids.some((id) => !id)) return;
  await prisma.emergencyContact.createMany({
    data: ids.map((userId, i) => ({
      businessId: store.businessId,
      storeId: store.id,
      userId: userId!,
      priority: i + 1,
    })),
  });
  console.log(`✔ Emergency contacts set for store ${code}`);
}

interface BusinessSeed {
  slug: string;
  name: string;
  timeZone: string;
  stores: Array<{ code: string; name: string }>;
  users: DemoUser[];
  groups: Array<{
    title: string;
    store?: string;
    category: 'OPERATIONS' | 'SECURITY' | 'MANAGEMENT' | 'ANNOUNCEMENTS';
    members: string[];
    admins: string[];
    adminsOnly?: boolean;
  }>;
  directs: Array<{ between: [string, string]; messages: string[] }>;
}

async function seedBusiness(
  seed: BusinessSeed,
  roles: Record<SystemRoleKey, string>,
  passwordHash: string,
): Promise<void> {
  if (await prisma.business.findUnique({ where: { slug: seed.slug } })) {
    console.log(`• ${seed.name} already exists — skipped`);
    return;
  }
  await prisma.$transaction(
    async (tx) => {
      const business = await tx.business.create({
        data: {
          slug: seed.slug,
          name: seed.name,
          timeZone: seed.timeZone,
          policy: DEFAULT_BUSINESS_POLICY,
          quota: { create: {} },
        },
      });
      const stores = new Map<string, string>();
      for (const store of seed.stores) {
        const row = await tx.store.create({
          data: { businessId: business.id, code: store.code, name: store.name },
        });
        stores.set(store.code, row.id);
      }
      const users = new Map<string, string>();
      for (const user of seed.users) {
        const row = await tx.user.create({
          data: {
            username: user.username,
            displayName: user.displayName,
            passwordHash,
            ...(user.email || user.phone
              ? {
                  contact: {
                    create: {
                      email: user.email ?? null,
                      phone: user.phone ?? null,
                      emailVerifiedAt: user.email ? new Date() : null,
                      phoneVerifiedAt: user.phone ? new Date() : null,
                    },
                  },
                }
              : {}),
          },
        });
        users.set(user.username, row.id);
        await tx.businessMembership.create({ data: { businessId: business.id, userId: row.id } });
        for (const code of user.stores ?? []) {
          await tx.storeMembership.create({
            data: { businessId: business.id, storeId: stores.get(code)!, userId: row.id },
          });
        }
        const scopes = SYSTEM_ROLES[user.role].allowedScopes.includes('STORE')
          ? (user.stores ?? []).map((code) => ({
              scopeType: 'STORE' as const,
              storeId: stores.get(code)!,
            }))
          : [{ scopeType: 'BUSINESS' as const, storeId: null }];
        for (const scope of scopes) {
          await tx.roleAssignment.create({
            data: { userId: row.id, roleId: roles[user.role], businessId: business.id, ...scope },
          });
        }
      }

      const addMessage = async (
        conversationId: string,
        senderId: string,
        body: string | null,
        systemEvent?: SystemEventDto,
      ): Promise<void> => {
        const { lastSeq } = await tx.conversation.update({
          where: { id: conversationId },
          data: { lastSeq: { increment: 1 }, lastActivityAt: new Date() },
          select: { lastSeq: true },
        });
        const message = await tx.message.create({
          data: {
            conversationId,
            seq: lastSeq,
            senderId,
            clientMessageId: randomUUID(),
            kind: systemEvent ? 'SYSTEM' : 'TEXT',
            body,
            systemEvent: systemEvent ?? undefined,
            state: 'DISPATCHED',
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageId: message.id },
        });
        await tx.conversationMember.updateMany({
          where: { conversationId, userId: senderId },
          data: { lastReadSeq: lastSeq, lastDeliveredSeq: lastSeq },
        });
      };

      for (const group of seed.groups) {
        const creator = users.get(group.admins[0]!)!;
        const conversation = await tx.conversation.create({
          data: {
            businessId: business.id,
            storeId: group.store ? stores.get(group.store)! : null,
            type: 'GROUP',
            title: group.title,
            category: group.category,
            postingPolicy: group.adminsOnly ? 'ADMINS_ONLY' : 'ALL_MEMBERS',
            createdById: creator,
            memberCount: group.members.length,
            members: {
              create: group.members.map((username) => ({
                userId: users.get(username)!,
                role: group.admins.includes(username) ? 'ADMIN' : 'MEMBER',
                addedById: creator,
              })),
            },
          },
        });
        await addMessage(conversation.id, creator, null, {
          type: 'group_created',
          actorId: creator,
          title: group.title,
        });
      }

      for (const direct of seed.directs) {
        const ids = direct.between.map((u) => users.get(u)!);
        const conversation = await tx.conversation.create({
          data: {
            businessId: business.id,
            type: 'DIRECT',
            directKey: `${business.id}:${[...ids].sort().join(':')}`,
            createdById: ids[0],
            memberCount: 2,
            members: { create: ids.map((userId) => ({ userId, addedById: ids[0] })) },
          },
        });
        for (const [index, body] of direct.messages.entries()) {
          await addMessage(conversation.id, ids[index % 2]!, body);
        }
      }
    },
    { timeout: 60_000 },
  );
  console.log(
    `✔ Seeded ${seed.name} (${seed.stores.length} stores, ${seed.users.length} users, ${seed.groups.length} groups)`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
