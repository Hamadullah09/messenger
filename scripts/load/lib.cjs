/**
 * Shared helpers for the load tests (scripts/load). They run against an ISOLATED stack:
 * database `storeline_load`, Redis DB 2, API on :4200 — see docs/operations/load-testing.md.
 * Test accounts get a random password generated in this process; it is never printed.
 */
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const { Redis } = require('ioredis');
const { TOTP } = require('otpauth');

const API = process.env.LOAD_API_URL ?? 'http://127.0.0.1:4200/api/v1';
const REALTIME = process.env.LOAD_REALTIME_URL ?? 'http://127.0.0.1:4200';
const DATABASE_URL = process.env.LOAD_DATABASE_URL;
const REDIS_URL = process.env.LOAD_REDIS_URL ?? 'redis://127.0.0.1:16379/2';
if (!DATABASE_URL || !/storeline_load/.test(DATABASE_URL)) {
  throw new Error('Set LOAD_DATABASE_URL to the isolated storeline_load database');
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const redis = new Redis(REDIS_URL);
const password = randomBytes(18).toString('base64url');

async function call(token, method, url, body) {
  const started = performance.now();
  const res = await fetch(API + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A hung request is a failure, not a stuck test.
    signal: AbortSignal.timeout(30_000),
  });
  const ms = performance.now() - started;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(`${method} ${url} → ${res.status} ${data?.error?.code ?? ''}`);
    error.status = res.status;
    error.ms = ms;
    throw error;
  }
  return { data, ms };
}

/** Creates a business with `users` employees in one store, a business admin, and roles. */
async function createTenant({ users, quota = {} }) {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const roles = Object.fromEntries(
    (
      await prisma.role.findMany({ where: { businessId: null }, select: { id: true, key: true } })
    ).map((r) => [r.key, r.id]),
  );
  const tag = randomUUID().slice(0, 8);
  const business = await prisma.business.create({
    data: {
      name: `Load test ${tag}`,
      slug: `load-${tag}`,
      policy: {},
      quota: { create: { messagesPerMinute: 1_000_000, maxCampaignSize: 1_000_000, ...quota } },
    },
  });
  const store = await prisma.store.create({
    data: { businessId: business.id, code: 'L1', name: 'Load store' },
  });
  const people = Array.from({ length: users }, (_, i) => ({
    id: randomUUID(),
    username: `load.${tag}.${i}`,
    displayName: `Load User ${i}`,
    passwordHash: hash,
  }));
  for (let i = 0; i < people.length; i += 5000) {
    const chunk = people.slice(i, i + 5000);
    await prisma.user.createMany({ data: chunk });
    await prisma.businessMembership.createMany({
      data: chunk.map((u) => ({ businessId: business.id, userId: u.id })),
    });
    await prisma.storeMembership.createMany({
      data: chunk.map((u) => ({ businessId: business.id, storeId: store.id, userId: u.id })),
    });
    await prisma.roleAssignment.createMany({
      data: chunk.map((u) => ({
        userId: u.id,
        roleId: roles.EMPLOYEE,
        scopeType: 'STORE',
        businessId: business.id,
        storeId: store.id,
      })),
    });
  }
  const admin = await prisma.user.create({
    data: { username: `load.${tag}.admin`, displayName: 'Load Admin', passwordHash: hash },
  });
  await prisma.businessMembership.create({ data: { businessId: business.id, userId: admin.id } });
  await prisma.roleAssignment.create({
    data: {
      userId: admin.id,
      roleId: roles.BUSINESS_ADMIN,
      scopeType: 'BUSINESS',
      businessId: business.id,
    },
  });
  return { business, store, people, admin };
}

/** Signs in (clearing the local per-IP login budget: every virtual user shares 127.0.0.1). */
async function login(username) {
  await clearLoginLimits();
  const { data } = await call(null, 'POST', '/auth/login', { username, password });
  return { token: data.accessToken, userId: data.me.user.id };
}

async function clearLoginLimits() {
  const keys = await redis.keys('rl:login:*');
  if (keys.length) await redis.del(...keys);
}

/** Signs in and enables TOTP so privileged actions (campaigns) are allowed. */
async function loginWithMfa(username) {
  const session = await login(username);
  const { data } = await call(session.token, 'POST', '/auth/mfa/setup');
  const code = new TOTP({ secret: data.secret, digits: 6, period: 30 }).generate();
  await call(session.token, 'POST', '/auth/mfa/enable', { code });
  return session;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summary(values) {
  const fmt = (v) => (v === null ? '-' : `${v.toFixed(1)} ms`);
  return `n=${values.length} p50=${fmt(percentile(values, 50))} p95=${fmt(percentile(values, 95))} p99=${fmt(percentile(values, 99))} max=${fmt(values.length ? Math.max(...values) : null)}`;
}

async function close() {
  await prisma.$disconnect();
  redis.disconnect();
}

module.exports = {
  API,
  REALTIME,
  prisma,
  redis,
  call,
  createTenant,
  login,
  loginWithMfa,
  clearLoginLimits,
  percentile,
  summary,
  close,
  root: path.join(__dirname, '..', '..'),
};
