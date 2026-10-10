/**
 * Campaign throughput benchmark: one campaign to N recipients through the real API and worker.
 * Reports time until every recipient's message is written (SENT) and until every message was
 * emitted by the delivery workers (SENT_TO_GATEWAY). Usage (isolated stack):
 *
 *   LOAD_DATABASE_URL=... node scripts/load/campaign-benchmark.cjs --recipients 30000
 */
const { randomUUID } = require('node:crypto');
const lib = require('./lib.cjs');

const i = process.argv.indexOf('--recipients');
const N = i > 0 ? Number(process.argv[i + 1]) : 30_000;

async function main() {
  console.log(`setup: ${N} recipients`);
  const setupStart = Date.now();
  const { business, admin } = await lib.createTenant({ users: N });
  console.log(`tenant created in ${((Date.now() - setupStart) / 1000).toFixed(1)} s`);
  const { token } = await lib.loginWithMfa(admin.username);

  const { data: campaign } = await lib.call(token, 'POST', '/campaigns', {
    clientCampaignId: randomUUID(),
    businessId: business.id,
    name: `Benchmark ${N}`,
    body: 'Benchmark announcement: stores close at 4pm on Friday.',
    audience: { everyone: true },
  });
  const { data: preview } = await lib.call(token, 'GET', `/campaigns/${campaign.id}/preview`);
  console.log(`preview: ${preview.recipients} recipients`);

  const started = Date.now();
  await lib.call(token, 'POST', `/campaigns/${campaign.id}/send`, {
    confirmRecipientCount: preview.recipients,
  });
  let written = null;
  let emitted = null;
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data } = await lib.call(token, 'GET', `/campaigns/${campaign.id}`);
    const c = data.counts;
    if (!c) continue;
    const line = `queued ${c.QUEUED} accepted ${c.ACCEPTED} sent ${c.SENT_TO_GATEWAY} failed ${c.FAILED}`;
    if (line !== last) {
      console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s  ${line}`);
      last = line;
    }
    if (written === null && data.status === 'COMPLETED') written = Date.now() - started;
    if (written !== null && c.QUEUED === 0 && c.ACCEPTED === 0) {
      emitted = Date.now() - started;
      if (c.FAILED > 0) console.log(`FAILED: ${c.FAILED}`);
      break;
    }
    if (Date.now() - started > 30 * 60_000) throw new Error('benchmark timed out after 30 minutes');
  }
  console.log('');
  console.log(`recipients:          ${preview.recipients}`);
  console.log(
    `all written (SENT):  ${(written / 1000).toFixed(1)} s → ${(preview.recipients / (written / 1000)).toFixed(0)} msg/s`,
  );
  console.log(
    `all emitted:         ${(emitted / 1000).toFixed(1)} s → ${(preview.recipients / (emitted / 1000)).toFixed(0)} msg/s`,
  );
  await lib.close();
}

main().catch(async (error) => {
  console.error(error);
  await lib.close();
  process.exit(1);
});
