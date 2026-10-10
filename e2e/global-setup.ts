import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { Redis } from 'ioredis';
import { TOTP } from 'otpauth';

const ROOT = join(__dirname, '..');
const API = process.env.ALPHA_API_URL ?? 'http://localhost:4000/api/v1';

function devEnv(): Record<string, string> {
  const text = readFileSync(join(ROOT, 'apps', 'api', '.env'), 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
  );
}

/**
 * Creates an isolated "Alpha QA" tenant for this run: two stores, admin (with MFA), store
 * manager (with private contact details, for privacy checks), security, two employees and a
 * customer. The password is random, kept in process.env for the test workers, never printed.
 */
export default async function globalSetup(): Promise<void> {
  const env = devEnv();
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const redis = new Redis(env.REDIS_URL);
  const password = randomBytes(18).toString('base64url');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const tag = randomUUID().slice(0, 6);
  const roles = Object.fromEntries(
    (
      await prisma.role.findMany({ where: { businessId: null }, select: { id: true, key: true } })
    ).map((r) => [r.key, r.id]),
  );
  const business = await prisma.business.create({
    data: { name: `Alpha QA ${tag}`, slug: `alpha-${tag}`, policy: {}, quota: { create: {} } },
  });
  const storeA = await prisma.store.create({
    data: { businessId: business.id, code: 'QA1', name: 'QA Store North' },
  });
  const storeB = await prisma.store.create({
    data: { businessId: business.id, code: 'QA2', name: 'QA Store South' },
  });

  const people = {
    admin: { name: 'Alpha Admin', role: 'BUSINESS_ADMIN', stores: [] as string[] },
    manager: { name: 'Alpha Manager', role: 'STORE_MANAGER', stores: [storeA.id] },
    security: { name: 'Alpha Security', role: 'SECURITY', stores: [storeA.id] },
    employee: { name: 'Alpha Employee', role: 'EMPLOYEE', stores: [storeA.id] },
    colleague: { name: 'Alpha Colleague', role: 'EMPLOYEE', stores: [storeA.id] },
    south: { name: 'Alpha South', role: 'EMPLOYEE', stores: [storeB.id] },
  } as const;
  const users: Record<string, { id: string; username: string; name: string }> = {};
  for (const [key, p] of Object.entries(people)) {
    const username = `alpha.${tag}.${key}`;
    const user = await prisma.user.create({
      data: {
        username,
        displayName: p.name,
        passwordHash: hash,
        ...(key === 'manager'
          ? {
              contact: {
                create: { email: `alpha.manager.${tag}@example.com`, phone: '+15555550142' },
              },
            }
          : {}),
      },
    });
    await prisma.businessMembership.create({ data: { businessId: business.id, userId: user.id } });
    for (const storeId of p.stores) {
      await prisma.storeMembership.create({
        data: { businessId: business.id, storeId, userId: user.id },
      });
      await prisma.roleAssignment.create({
        data: {
          userId: user.id,
          roleId: roles[p.role]!,
          scopeType: 'STORE',
          businessId: business.id,
          storeId,
        },
      });
    }
    if (p.stores.length === 0)
      await prisma.roleAssignment.create({
        data: {
          userId: user.id,
          roleId: roles[p.role]!,
          scopeType: 'BUSINESS',
          businessId: business.id,
        },
      });
    users[key] = { id: user.id, username, name: p.name };
  }

  // A platform administrator (no business membership), like the seeded superadmin.
  const platform = await prisma.user.create({
    data: { username: `alpha.${tag}.platform`, displayName: 'Alpha Platform', passwordHash: hash },
  });
  await prisma.roleAssignment.create({
    data: { userId: platform.id, roleId: roles.SUPER_ADMIN!, scopeType: 'PLATFORM' },
  });
  users.platform = { id: platform.id, username: platform.username, name: 'Alpha Platform' };

  // Admin enrols in two-step verification through the real API (privileged features need it).
  const keys = await redis.keys('rl:login:*');
  if (keys.length) await redis.del(...keys);
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SMA-Client': 'native' },
    body: JSON.stringify({ username: users.admin!.username, password }),
  }).then((r) => r.json() as Promise<{ accessToken: string }>);
  const auth = { Authorization: `Bearer ${login.accessToken}`, 'Content-Type': 'application/json' };
  const setup = (await fetch(`${API}/auth/mfa/setup`, { method: 'POST', headers: auth }).then((r) =>
    r.json(),
  )) as {
    secret: string;
  };
  const totp = new TOTP({ secret: setup.secret, digits: 6, period: 30 });
  const enabled = await fetch(`${API}/auth/mfa/enable`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: totp.generate() }),
  });
  if (enabled.status !== 204) throw new Error(`MFA enrolment failed: ${enabled.status}`);

  process.env.ALPHA_PASSWORD = password;
  process.env.ALPHA_ADMIN_TOTP = setup.secret;
  process.env.ALPHA_MFA_LAST_STEP = String(Math.floor(Date.now() / 30_000));
  process.env.ALPHA_USERS = JSON.stringify(users);
  process.env.ALPHA_BUSINESS = JSON.stringify({
    id: business.id,
    name: business.name,
    storeA: storeA.id,
  });
  process.env.ALPHA_REDIS_URL = env.REDIS_URL;
  await prisma.$disconnect();
  redis.disconnect();
}
