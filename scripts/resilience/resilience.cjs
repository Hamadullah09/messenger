/**
 * Resilience tests against the isolated load database (storeline_load). This script starts its
 * own API (:4200) and worker so it can crash and restart them, and stops/starts the shared
 * Redis and PostgreSQL containers. Do not run while others use the local stack.
 *
 *   LOAD_DATABASE_URL="$(scripts/load/stack.sh url)" node scripts/resilience/resilience.cjs
 *
 * Scenarios (each must end with no lost messages and no duplicates):
 *   1. Worker crash: messages accepted while no worker runs are delivered after restart.
 *   2. Redis outage: sends are still accepted (durable in PostgreSQL); delivery resumes after.
 *   3. Emergency escalation while the worker is down happens as soon as it is back.
 *   4. PostgreSQL restart: readiness fails during the outage and recovers; no 5xx afterwards.
 */
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const lib = require('../load/lib.cjs');

const API_DIR = path.join(lib.root, 'apps', 'api');
const env = {
  ...process.env,
  DATABASE_URL: process.env.LOAD_DATABASE_URL,
  REDIS_URL: 'redis://127.0.0.1:16379/2',
  PORT: '4200',
  METRICS_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  EMERGENCY_SWEEP_INTERVAL_MS: '1000',
};
const procs = {};
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name) {
  const child = spawn(process.execPath, [`dist/${name === 'api' ? 'main' : 'worker'}.js`], {
    cwd: API_DIR,
    env,
    stdio: 'ignore',
  });
  procs[name] = child;
}
function crash(name) {
  procs[name]?.kill('SIGKILL'); // a crash, not a graceful shutdown
  procs[name] = null;
}
const docker = (args) => execSync(`docker ${args}`, { stdio: 'ignore' });

async function waitFor(what, check, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return Date.now();
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const ready = () =>
  fetch(`${lib.API}/health/ready`)
    .then((r) => r.ok)
    .catch(() => false);
const messageState = async (id) =>
  (await lib.prisma.message.findUnique({ where: { id }, select: { state: true } }))?.state;

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, s: ((Date.now() - started) / 1000).toFixed(1) });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error.message,
      s: ((Date.now() - started) / 1000).toFixed(1),
    });
  }
}

async function main() {
  start('api');
  start('worker');
  await waitFor('API ready', ready);
  const { business, people } = await lib.createTenant({ users: 3 });
  const [a, b] = await Promise.all(people.slice(0, 2).map((p) => lib.login(p.username)));
  const { data: dm } = await lib.call(a.token, 'POST', '/conversations/direct', {
    businessId: business.id,
    userId: b.userId,
  });
  const send = (body) =>
    lib.call(a.token, 'POST', `/conversations/${dm.id}/messages`, {
      clientMessageId: randomUUID(),
      body,
    });

  await scenario('Worker crash: accepted messages are delivered after restart', async () => {
    crash('worker');
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await send(`while worker down ${i}`)).data.id);
    await sleep(2000);
    const stuck = (await Promise.all(ids.map(messageState))).filter((s) => s === 'ACCEPTED').length;
    if (stuck !== ids.length) throw new Error(`expected 20 waiting, got ${stuck}`);
    const t = Date.now();
    start('worker');
    await waitFor('all dispatched', async () =>
      (await Promise.all(ids.map(messageState))).every((s) => s === 'DISPATCHED'),
    );
    const count = await lib.prisma.message.count({
      where: { conversationId: dm.id, body: { startsWith: 'while worker down' } },
    });
    if (count !== 20) throw new Error(`expected 20 messages, found ${count}`);
    return `20/20 accepted while down; delivered ${((Date.now() - t) / 1000).toFixed(1)} s after restart; no duplicates`;
  });

  await scenario('Redis outage: sends accepted, delivery resumes', async () => {
    docker('stop storeline-redis-1');
    try {
      const ids = [];
      let failures = 0;
      for (let i = 0; i < 10; i++) {
        try {
          ids.push((await send(`during redis outage ${i}`)).data.id);
        } catch {
          failures += 1;
        }
      }
      if (failures > 0) throw new Error(`${failures}/10 sends rejected during the outage`);
      docker('start storeline-redis-1');
      const t = Date.now();
      await waitFor(
        'dispatched after Redis returns',
        async () => (await Promise.all(ids.map(messageState))).every((s) => s === 'DISPATCHED'),
        120_000,
      );
      return `10/10 accepted during outage; delivered ${((Date.now() - t) / 1000).toFixed(1)} s after Redis returned`;
    } finally {
      docker('start storeline-redis-1');
    }
  });

  await scenario('Emergency escalation resumes after a worker outage', async () => {
    const store = await lib.prisma.store.findFirstOrThrow({ where: { businessId: business.id } });
    const managerRole = await lib.prisma.role.findFirstOrThrow({
      where: { key: 'STORE_MANAGER', businessId: null },
    });
    const adminRole = await lib.prisma.role.findFirstOrThrow({
      where: { key: 'BUSINESS_ADMIN', businessId: null },
    });
    await lib.prisma.roleAssignment.create({
      data: {
        userId: people[1].id,
        roleId: managerRole.id,
        scopeType: 'STORE',
        businessId: business.id,
        storeId: store.id,
      },
    });
    await lib.prisma.roleAssignment.create({
      data: {
        userId: people[2].id,
        roleId: adminRole.id,
        scopeType: 'BUSINESS',
        businessId: business.id,
      },
    });
    const { data } = await lib.call(a.token, 'POST', '/emergency/incidents', {
      clientIncidentId: randomUUID(),
    });
    crash('worker');
    await lib.prisma.emergencyIncident.update({
      where: { id: data.incident.id },
      data: { ackDeadlineAt: new Date(Date.now() - 1000) },
    });
    await sleep(3000);
    const before = await lib.prisma.emergencyIncident.findUniqueOrThrow({
      where: { id: data.incident.id },
    });
    if (before.level !== 1) throw new Error('escalated without a worker?');
    const t = Date.now();
    start('worker');
    await waitFor(
      'escalated',
      async () =>
        (await lib.prisma.emergencyIncident.findUniqueOrThrow({ where: { id: data.incident.id } }))
          .level === 2,
    );
    return `escalated to level 2 ${((Date.now() - t) / 1000).toFixed(1)} s after the worker restarted`;
  });

  await scenario('PostgreSQL restart: readiness reflects it and the API recovers', async () => {
    docker('stop storeline-postgres-1');
    const sawNotReady = await waitFor('readiness false', async () => !(await ready()), 30_000).then(
      () => true,
    );
    docker('start storeline-postgres-1');
    const t = Date.now();
    await waitFor('readiness true', ready, 120_000);
    const recovered = ((Date.now() - t) / 1000).toFixed(1);
    let errors = 0;
    for (let i = 0; i < 10; i++) await send(`after db restart ${i}`).catch(() => (errors += 1));
    if (errors) throw new Error(`${errors}/10 sends failed after recovery`);
    return `readiness went false (${sawNotReady}); ready again ${recovered} s after PostgreSQL started; 10/10 sends OK`;
  });

  crash('api');
  crash('worker');
  console.log('\n| Scenario | Result | Detail | Duration |\n| --- | --- | --- | --- |');
  for (const r of results)
    console.log(`| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail} | ${r.s} s |`);
  await lib.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  crash('api');
  crash('worker');
  try {
    docker('start storeline-redis-1');
    docker('start storeline-postgres-1');
  } catch {
    /* best effort */
  }
  await lib.close().catch(() => undefined);
  process.exit(1);
});
