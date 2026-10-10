/**
 * Local smoke test of the emergency flow against a running API + worker (seeded demo data).
 * Reads SEED_PASSWORD from apps/api/.env inside the process; never prints credentials.
 *
 *   node scripts/emergency-smoke.cjs            # raise as alice, acknowledge + resolve as manager.a
 *   node scripts/emergency-smoke.cjs --raise    # only raise (leave it active for UI checks)
 *   node scripts/emergency-smoke.cjs --cancel <incidentId>   # alice withdraws her alert
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const env = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', '.env'), 'utf8');
const password = env.match(/^SEED_PASSWORD=(.+)$/m)?.[1]?.trim();
if (!password) throw new Error('SEED_PASSWORD is not set in apps/api/.env');

async function call(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return data;
}

const login = async (username) =>
  (await call(null, 'POST', '/auth/login', { username, password })).accessToken;

async function main() {
  const alice = await login('alice');
  const cancel = process.argv.indexOf('--cancel');
  if (cancel > 0) {
    const id = process.argv[cancel + 1];
    const done = await call(alice, 'POST', `/emergency/incidents/${id}/cancel`);
    console.log(`cancelled ${id}: ${done.status}`);
    return;
  }
  const raised = await call(alice, 'POST', '/emergency/incidents', {
    clientIncidentId: randomUUID(),
    category: 'MEDICAL',
    description: 'Customer fainted at checkout 3 (smoke test)',
  });
  const { incident } = raised;
  console.log(`raised ${incident.id} existing=${raised.existing} status=${incident.status}`);
  console.log(
    `alerted: ${incident.recipients.map((r) => `${r.user.displayName}=${r.state}`).join(', ')}`,
  );
  for (const word of ['@example.com', '+1555']) {
    if (JSON.stringify(raised).includes(word)) throw new Error(`contact data leaked: ${word}`);
  }
  if (process.argv.includes('--raise')) return;

  await new Promise((r) => setTimeout(r, 1000));
  const manager = await login('manager.a');
  const before = await call(manager, 'GET', `/emergency/incidents/${incident.id}`);
  console.log(`manager sees: ${before.me.alertState}, canRespond=${before.me.canRespond}`);
  const acked = await call(manager, 'POST', `/emergency/incidents/${incident.id}/acknowledge`);
  console.log(`acknowledged by ${acked.acknowledgedBy.displayName}: ${acked.status}`);
  const resolved = await call(manager, 'POST', `/emergency/incidents/${incident.id}/resolve`, {
    note: 'Smoke test complete',
  });
  console.log(
    `resolved: ${resolved.status}; timeline: ${resolved.events.map((e) => e.type).join(' → ')}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
