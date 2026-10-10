/**
 * Messaging load test: N virtual users connected over Socket.IO send messages into groups at a
 * steady rate; measures HTTP acceptance latency and end-to-end delivery latency (send → every
 * other member's `message.created`), plus losses. Usage (isolated stack, see
 * docs/operations/load-testing.md):
 *
 *   LOAD_DATABASE_URL=... node scripts/load/message-load.cjs --users 100 --group 10 --rate 40 --seconds 60
 */
const { randomUUID } = require('node:crypto');
const { io } = require('socket.io-client');
const lib = require('./lib.cjs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const USERS = arg('users', 100);
const GROUP = arg('group', 10);
const RATE = arg('rate', 40); // messages per second across all users
const SECONDS = arg('seconds', 60);

async function main() {
  console.log(`setup: ${USERS} users, groups of ${GROUP}, ${RATE} msg/s for ${SECONDS} s`);
  const { business, people } = await lib.createTenant({ users: USERS });
  // Group creators need group.create: make the first member of every group a store manager.
  const manager = await lib.prisma.role.findFirstOrThrow({
    where: { key: 'STORE_MANAGER', businessId: null },
  });
  const store = await lib.prisma.store.findFirstOrThrow({ where: { businessId: business.id } });
  await lib.prisma.roleAssignment.createMany({
    data: people
      .filter((_, i) => i % GROUP === 0)
      .map((p) => ({
        userId: p.id,
        roleId: manager.id,
        scopeType: 'STORE',
        businessId: business.id,
        storeId: store.id,
      })),
  });
  const sessions = [];
  for (const p of people) sessions.push({ ...(await lib.login(p.username)), username: p.username });

  // Groups: each created by its first member through the API (normal path).
  const groups = [];
  for (let i = 0; i < sessions.length; i += GROUP) {
    const members = sessions.slice(i, i + GROUP);
    if (members.length < 2) break;
    const { data } = await lib.call(members[0].token, 'POST', '/conversations/groups', {
      businessId: business.id,
      storeId: store.id,
      title: `Load group ${i / GROUP}`,
      memberIds: members.slice(1).map((m) => m.userId),
    });
    groups.push({ id: data.id, members });
  }

  // Connect every user and record delivery latency from the timestamp embedded in the body.
  const deliveries = [];
  const expected = new Map(); // clientMessageId -> remaining recipients
  const sockets = await Promise.all(
    sessions.map(
      (s) =>
        new Promise((resolve, reject) => {
          const socket = io(`${lib.REALTIME}/v1`, {
            path: '/socket.io',
            transports: ['websocket'],
            auth: { token: s.token },
            reconnection: false,
          });
          socket.on('message.created', (m) => {
            if (m.sender.id === s.userId || !m.body?.startsWith('lt:')) return;
            const sentAt = Number(m.body.split(':')[1]);
            deliveries.push(Date.now() - sentAt);
            const left = expected.get(m.clientMessageId);
            if (left !== undefined) expected.set(m.clientMessageId, left - 1);
          });
          socket.once('connect', () => resolve(socket));
          socket.once('connect_error', reject);
        }),
    ),
  );
  console.log(`connected ${sockets.length} sockets, ${groups.length} groups`);

  const accept = [];
  const errors = {};
  const total = RATE * SECONDS;
  const started = Date.now();
  const inflight = [];
  for (let i = 0; i < total; i++) {
    const due = started + (i * 1000) / RATE;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const group = groups[i % groups.length];
    const sender = group.members[Math.floor(i / groups.length) % group.members.length];
    const clientMessageId = randomUUID();
    expected.set(clientMessageId, group.members.length - 1);
    inflight.push(
      lib
        .call(sender.token, 'POST', `/conversations/${group.id}/messages`, {
          clientMessageId,
          body: `lt:${Date.now()}:${i}`,
        })
        .then(({ ms }) => accept.push(ms))
        .catch((e) => {
          errors[e.message] = (errors[e.message] ?? 0) + 1;
          expected.delete(clientMessageId);
        }),
    );
  }
  await Promise.all(inflight);
  const sendSeconds = (Date.now() - started) / 1000;
  // Allow in-flight deliveries to land.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && [...expected.values()].some((n) => n > 0))
    await new Promise((r) => setTimeout(r, 250));
  const missing = [...expected.values()].reduce((sum, n) => sum + Math.max(0, n), 0);

  console.log('');
  console.log(
    `sent ${accept.length}/${total} in ${sendSeconds.toFixed(1)} s (${(accept.length / sendSeconds).toFixed(1)} msg/s)`,
  );
  console.log(`HTTP accept latency:   ${lib.summary(accept)}`);
  console.log(`end-to-end delivery:   ${lib.summary(deliveries)}`);
  console.log(`deliveries ${deliveries.length}, missing after 30 s: ${missing}`);
  console.log(`errors: ${JSON.stringify(errors)}`);
  sockets.forEach((s) => s.disconnect());
  await lib.close();
  process.exit(missing > 0 || Object.keys(errors).length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await lib.close();
  process.exit(1);
});
