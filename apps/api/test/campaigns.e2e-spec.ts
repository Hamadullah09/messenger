import { randomUUID } from 'node:crypto';
import type {
  CampaignDto,
  CampaignPreviewDto,
  CampaignRecipientDto,
  ConversationSummaryDto,
  MessageDto,
  Page,
  UploadSessionDto,
} from '@storeline/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignDispatcher } from '../src/modules/campaigns/campaign-dispatcher.service';
import { Harness, nextEvent, uuid, type Session } from './harness';

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`Condition not met: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Bulk campaigns', () => {
  let h: Harness;
  let dispatcher: CampaignDispatcher;

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    dispatcher = h.worker!.get(CampaignDispatcher);
  });
  afterAll(() => h.stop());

  /** Business with two stores, staff, a customer, and an MFA-verified admin session. */
  async function tenant() {
    const businessId = (await h.createBusiness()).id;
    const storeA = (await h.createStore(businessId)).id;
    const storeB = (await h.createStore(businessId)).id;
    const admin = await h.createUser({
      role: 'BUSINESS_ADMIN',
      businessId,
      email: `admin.${uuid().slice(0, 6)}@example.com`,
    });
    const manager = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeA] });
    const alice = await h.createUser({
      role: 'EMPLOYEE',
      businessId,
      storeIds: [storeA],
      email: `alice.${uuid().slice(0, 6)}@example.com`,
      phone: '+15555550177',
    });
    const bob = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeB] });
    const customer = await h.createUser({ role: 'CUSTOMER', businessId });
    const session = await h.loginWithMfa(admin.username);
    return { businessId, storeA, storeB, admin, manager, alice, bob, customer, session };
  }

  const create = (s: Session, businessId: string, body: Record<string, unknown> = {}) =>
    s.post('/api/v1/campaigns').send({
      clientCampaignId: uuid(),
      businessId,
      name: 'Holiday hours',
      body: 'Stores close at 4pm on Friday.',
      audience: { everyone: true },
      ...body,
    });

  /** Runs dispatcher rounds until the campaign stops sending. */
  async function drain(campaignId: string) {
    for (let i = 0; i < 50; i++) {
      await dispatcher.runOnce();
      const row = await h.prisma.bulkCampaign.findUniqueOrThrow({ where: { id: campaignId } });
      if (row.status !== 'SENDING') return row;
    }
    throw new Error('campaign did not finish');
  }

  it('delivers to each recipient in a read-only announcements channel and reports honestly', async () => {
    const t = await tenant();
    const alice = await h.login(t.alice.username);
    const aliceSocket = await h.socket(alice);
    const created = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    expect(created).toMatchObject({ status: 'DRAFT', counts: null });

    const preview = (await t.session.get(`/api/v1/campaigns/${created.id}/preview`).expect(200))
      .body as CampaignPreviewDto;
    // Everyone internal except the sender: manager, alice, bob. The customer is excluded.
    expect(preview).toMatchObject({ recipients: 3, suppressed: 0, requiresConfirmation: false });
    expect(JSON.stringify(preview)).not.toContain(t.alice.id); // counts only, no enumeration

    const arrived = nextEvent<MessageDto>(aliceSocket, 'message.created');
    const sending = (
      await t.session.post(`/api/v1/campaigns/${created.id}/send`).send({}).expect(200)
    ).body as CampaignDto;
    expect(sending.status).toBe('SENDING');
    const done = await drain(created.id);
    expect(done).toMatchObject({ status: 'COMPLETED', totalRecipients: 3 });

    const message = await arrived;
    expect(message.body).toBe('Stores close at 4pm on Friday.');
    expect(message.sender.id).toBe(t.admin.id);
    const list = (await alice.get('/api/v1/conversations').expect(200)).body
      .items as ConversationSummaryDto[];
    const channel = list.find((c) => c.type === 'BROADCAST')!;
    expect(channel).toMatchObject({ id: message.conversationId, memberCount: 1 });
    expect(channel.title).toContain('Announcements');
    expect(channel.me.canPost).toBe(false);
    await alice
      .post(`/api/v1/conversations/${channel.id}/messages`)
      .send({ clientMessageId: uuid(), body: 'reply' })
      .expect(403);

    // Sent to the gateway, but only "delivered" once the device confirms it.
    const report = async () =>
      ((await t.session.get(`/api/v1/campaigns/${created.id}`).expect(200)).body as CampaignDto)
        .counts!;
    let counts = await waitFor(report, (c) => c.SENT_TO_GATEWAY === 3);
    expect(counts).toMatchObject({ total: 3, DELIVERED: 0, READ: 0, QUEUED: 0 });
    await new Promise<void>((resolve) =>
      aliceSocket.emit('message.read', { conversationId: channel.id, seq: message.seq }, () =>
        resolve(),
      ),
    );
    counts = await waitFor(report, (c) => c.READ === 1);
    expect(counts).toMatchObject({ SENT_TO_GATEWAY: 2, READ: 1 });

    // A second campaign reuses the same channel.
    const second = (
      await create(t.session, t.businessId, {
        audience: { everyone: false, storeIds: [t.storeA] },
      }).expect(201)
    ).body as CampaignDto;
    await t.session.post(`/api/v1/campaigns/${second.id}/send`).send({}).expect(200);
    await drain(second.id);
    const channels = await h.prisma.conversation.count({
      where: { businessId: t.businessId, type: 'BROADCAST' },
    });
    expect(channels).toBe(3);

    // Recipients and CSV: public profiles only, with formula injection neutralised.
    const recipients = (
      await t.session.get(`/api/v1/campaigns/${created.id}/recipients?status=READ`).expect(200)
    ).body as Page<CampaignRecipientDto>;
    expect(recipients.items.map((r) => r.user.id)).toEqual([t.alice.id]);
    await h.prisma.user.update({
      where: { id: t.bob.id },
      data: { displayName: '=HYPERLINK("x")' },
    });
    const csv = await t.session.get(`/api/v1/campaigns/${created.id}/report.csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('username,display_name,status,reason,processed_at');
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(4);
    const all = JSON.stringify([preview, sending, recipients, list]) + csv.text;
    expect(all).not.toContain('@example.com');
    expect(all).not.toContain('+1555');
    const audit = await h.prisma.auditLog.findMany({
      where: { targetId: created.id },
      select: { action: true },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'campaign.created',
        'campaign.started',
        'campaign.completed',
        'campaign.report.exported',
      ]),
    );
  });

  it('resolves segments, role filters, customers and suppression within the business', async () => {
    const t = await tenant();
    const other = await tenant();
    const preview = async (audience: Record<string, unknown>) => {
      const c = (await create(t.session, t.businessId, { audience }).expect(201))
        .body as CampaignDto;
      return (await t.session.get(`/api/v1/campaigns/${c.id}/preview`).expect(200))
        .body as CampaignPreviewDto;
    };
    expect((await preview({ storeIds: [t.storeA] })).recipients).toBe(2); // manager + alice
    expect((await preview({ everyone: true, roleKeys: ['STORE_MANAGER'] })).recipients).toBe(1);
    expect((await preview({ everyone: true, includeCustomers: true })).recipients).toBe(4);

    // Groups: members only (the creator is never a recipient).
    const group = await t.session
      .post('/api/v1/conversations/groups')
      .send({ businessId: t.businessId, title: 'Leads', memberIds: [t.bob.id] })
      .expect(201);
    expect((await preview({ groupIds: [group.body.id] })).recipients).toBe(1);

    // Other tenants' stores and groups are rejected, not silently included.
    await create(t.session, t.businessId, { audience: { storeIds: [other.storeA] } }).expect(400);
    await create(t.session, t.businessId, { audience: { everyone: false } }).expect(400);

    // Suppression: excluded from the count and recorded as SKIPPED when sending.
    await t.session
      .post(`/api/v1/businesses/${t.businessId}/campaign-suppressions`)
      .send({ userId: t.bob.id })
      .expect(204);
    expect(await preview({ everyone: true })).toMatchObject({ recipients: 2, suppressed: 1 });
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    await t.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(200);
    await drain(c.id);
    const counts = (
      (await t.session.get(`/api/v1/campaigns/${c.id}`).expect(200)).body as CampaignDto
    ).counts!;
    expect(counts).toMatchObject({ total: 3, SKIPPED: 1 });
    await t.session
      .delete(`/api/v1/businesses/${t.businessId}/campaign-suppressions/${t.bob.id}`)
      .expect(204);
  });

  it('lets customers opt out but not staff', async () => {
    const t = await tenant();
    const customer = await h.login(t.customer.username);
    const path = `/api/v1/businesses/${t.businessId}/announcements/opt-out`;
    expect((await customer.get(path).expect(200)).body).toEqual({
      optedOut: false,
      canOptOut: true,
    });
    await customer.put(path).send({ optOut: true }).expect(200);
    const c = (
      await create(t.session, t.businessId, {
        audience: { everyone: true, includeCustomers: true },
      }).expect(201)
    ).body as CampaignDto;
    expect(
      (await t.session.get(`/api/v1/campaigns/${c.id}/preview`).expect(200)).body,
    ).toMatchObject({
      recipients: 3,
      suppressed: 1,
    });
    // Admins cannot remove someone's own opt-out.
    await t.session
      .delete(`/api/v1/businesses/${t.businessId}/campaign-suppressions/${t.customer.id}`)
      .expect(404);
    const staff = await h.login(t.alice.username);
    await staff.put(path).send({ optOut: true }).expect(403);
  });

  it('requires confirmation for large broadcasts and enforces the tenant quota', async () => {
    const t = await tenant();
    const n = 1001;
    const users = Array.from({ length: n }, () => ({
      id: randomUUID(),
      username: `bulk.${randomUUID().slice(0, 12)}`,
      displayName: 'Bulk user',
      passwordHash: 'not-a-login',
    }));
    await h.prisma.user.createMany({ data: users });
    await h.prisma.businessMembership.createMany({
      data: users.map((u) => ({ businessId: t.businessId, userId: u.id })),
    });
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    const res = await t.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(409);
    const total = n + 3;
    expect(res.body.error.details[0]).toEqual({
      path: 'confirmRecipientCount',
      message: String(total),
    });
    await t.session
      .post(`/api/v1/campaigns/${c.id}/send`)
      .send({ confirmRecipientCount: 5 })
      .expect(409);

    await h.prisma.tenantQuota.update({
      where: { businessId: t.businessId },
      data: { maxCampaignSize: 1000 },
    });
    await t.session
      .post(`/api/v1/campaigns/${c.id}/send`)
      .send({ confirmRecipientCount: total })
      .expect(409);
    await h.prisma.tenantQuota.update({
      where: { businessId: t.businessId },
      data: { maxCampaignSize: 100_000, messagesPerMinute: 1_000_000 },
    });
    await t.session
      .post(`/api/v1/campaigns/${c.id}/send`)
      .send({ confirmRecipientCount: total })
      .expect(200);
    const done = await drain(c.id);
    expect(done).toMatchObject({ status: 'COMPLETED', totalRecipients: total });
    const sent = await h.prisma.bulkCampaignRecipient.count({
      where: { campaignId: c.id, state: 'SENT' },
    });
    expect(sent).toBe(total);
  });

  it('pauses, resumes and cancels; cancelled recipients are never sent', async () => {
    const t = await tenant();
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    await t.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(200);
    await dispatcher.dispatchBatch(c.id, 1); // materialise
    await dispatcher.dispatchBatch(c.id, 1); // one recipient
    await t.session.post(`/api/v1/campaigns/${c.id}/pause`).expect(200);
    await t.session.post(`/api/v1/campaigns/${c.id}/pause`).expect(409);
    expect(await dispatcher.dispatchBatch(c.id, 10)).toBeNull();
    await t.session.post(`/api/v1/campaigns/${c.id}/resume`).expect(200);
    await dispatcher.dispatchBatch(c.id, 1);
    const cancelled = (await t.session.post(`/api/v1/campaigns/${c.id}/cancel`).expect(200))
      .body as CampaignDto;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.counts).toMatchObject({ total: 3, CANCELLED: 1 });
    expect(await dispatcher.dispatchBatch(c.id, 10)).toBeNull();
    await t.session.post(`/api/v1/campaigns/${c.id}/resume`).expect(409);
    await t.session.patch(`/api/v1/campaigns/${c.id}`).send({ name: 'x' }).expect(409);
  });

  it('schedules, skips expired recipients and serves tenants fairly', async () => {
    const a = await tenant();
    const b = await tenant();
    const scheduled = (await create(a.session, a.businessId).expect(201)).body as CampaignDto;
    await a.session
      .post(`/api/v1/campaigns/${scheduled.id}/schedule`)
      .send({ scheduledAt: new Date(Date.now() + 10_000).toISOString() })
      .expect(400); // at least a minute ahead
    const at = new Date(Date.now() + 120_000);
    await a.session
      .post(`/api/v1/campaigns/${scheduled.id}/schedule`)
      .send({ scheduledAt: at.toISOString() })
      .expect(200);
    await dispatcher.runOnce();
    expect(
      (await h.prisma.bulkCampaign.findUniqueOrThrow({ where: { id: scheduled.id } })).status,
    ).toBe('SCHEDULED');
    await dispatcher.runOnce(new Date(at.getTime() + 1000));
    expect(
      (await h.prisma.bulkCampaign.findUniqueOrThrow({ where: { id: scheduled.id } })).status,
    ).not.toBe('SCHEDULED');

    const expiring = (await create(b.session, b.businessId).expect(201)).body as CampaignDto;
    await b.session.post(`/api/v1/campaigns/${expiring.id}/send`).send({}).expect(200);
    await dispatcher.dispatchBatch(expiring.id, 1); // materialise
    await h.prisma.bulkCampaign.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // One round serves both tenants.
    const results = await dispatcher.runOnce(new Date(at.getTime() + 2000));
    const served = results.map((r) => r.campaignId);
    expect(served).toEqual(expect.arrayContaining([scheduled.id, expiring.id]));
    const counts = (
      (await b.session.get(`/api/v1/campaigns/${expiring.id}`).expect(200)).body as CampaignDto
    ).counts!;
    expect(counts).toMatchObject({ total: 3, SKIPPED: 3 });
  });

  it('retries failures without duplicate messages', async () => {
    const t = await tenant();
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    await t.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(200);
    await drain(c.id);
    await t.session.post(`/api/v1/campaigns/${c.id}/retry-failed`).expect(409); // nothing failed

    // One write failure and one dead-lettered delivery.
    const [r1, r2] = await h.prisma.bulkCampaignRecipient.findMany({
      where: { campaignId: c.id },
      take: 2,
    });
    await h.prisma.bulkCampaignRecipient.update({
      where: { campaignId_userId: { campaignId: c.id, userId: r1!.userId } },
      data: { state: 'FAILED', reason: 'write_failed', messageId: null },
    });
    await h.prisma.message.update({ where: { id: r2!.messageId! }, data: { state: 'FAILED' } });
    await h.prisma
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'FAILED' WHERE "payload"->>'messageId' = ${r2!.messageId}`;
    expect(
      ((await t.session.get(`/api/v1/campaigns/${c.id}`).expect(200)).body as CampaignDto).counts!
        .FAILED,
    ).toBe(2);

    const retried = (await t.session.post(`/api/v1/campaigns/${c.id}/retry-failed`).expect(200))
      .body as CampaignDto;
    expect(retried.status).toBe('SENDING');
    await drain(c.id);
    const messages = await h.prisma.message.count({
      where: { conversation: { businessId: t.businessId, type: 'BROADCAST' } },
    });
    expect(messages).toBe(4); // 3 originals (one orphaned by the simulated failure) + 1 retry, no duplicates of r2
    const replayed = await waitFor(
      () => h.prisma.message.findUniqueOrThrow({ where: { id: r2!.messageId! } }),
      (m) => m.state === 'DISPATCHED',
    );
    expect(replayed.id).toBe(r2!.messageId);
  });

  it('accepts attachments uploaded to the draft and sends the same verified file to everyone', async () => {
    const t = await tenant();
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#c2410c' },
    })
      .png()
      .toBuffer();
    const start = await t.session
      .post('/api/v1/media/uploads')
      .send({
        campaignId: c.id,
        fileName: 'poster.png',
        mimeType: 'image/png',
        sizeBytes: png.length,
      })
      .expect(201);
    const session = start.body as UploadSessionDto;
    expect(session.media).toMatchObject({ campaignId: c.id, conversationId: null });
    if (session.upload.method !== 'PUT') throw new Error('expected single PUT');
    expect(
      (
        await fetch(session.upload.url, {
          method: 'PUT',
          body: png,
          headers: session.upload.headers,
        })
      ).status,
    ).toBe(200);
    await t.session.post(`/api/v1/media/uploads/${session.media.id}/complete`).expect(202);
    await t.session
      .patch(`/api/v1/campaigns/${c.id}`)
      .send({ mediaId: session.media.id })
      .expect(200);
    await waitFor(
      async () =>
        (await t.session.get(`/api/v1/media/${session.media.id}`).expect(200)).body.status,
      (s) => s === 'READY',
      30_000,
    );

    // Employees cannot upload to campaigns.
    const alice = await h.login(t.alice.username);
    await alice
      .post('/api/v1/media/uploads')
      .send({ campaignId: c.id, fileName: 'x.png', mimeType: 'image/png', sizeBytes: 10 })
      .expect(404);

    await t.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(200);
    await drain(c.id);
    const message = await h.prisma.message.findFirstOrThrow({
      where: { conversation: { type: 'BROADCAST', members: { some: { userId: t.alice.id } } } },
      include: { attachments: true },
    });
    expect(message.kind).toBe('IMAGE');
    expect(message.attachments[0]!.mediaId).toBe(session.media.id);
    // A recipient can download it; someone outside the campaign cannot.
    await alice.get(`/api/v1/media/${session.media.id}/url`).expect(200);
    const other = await tenant();
    const outsider = await h.login(other.alice.username);
    await outsider.get(`/api/v1/media/${session.media.id}/url`).expect(404);
    // Attachments are frozen once the campaign has started.
    await t.session
      .post('/api/v1/media/uploads')
      .send({ campaignId: c.id, fileName: 'y.png', mimeType: 'image/png', sizeBytes: 10 })
      .expect(409);
  });

  it('is limited to authorized campaign managers', async () => {
    const t = await tenant();
    const c = (await create(t.session, t.businessId).expect(201)).body as CampaignDto;
    const manager = await h.login(t.manager.username);
    await manager.get(`/api/v1/businesses/${t.businessId}/campaigns`).expect(404);
    await manager.get(`/api/v1/campaigns/${c.id}`).expect(404);
    await create(manager, t.businessId).expect(404);
    const other = await tenant();
    await other.session.get(`/api/v1/campaigns/${c.id}`).expect(404);
    await other.session.post(`/api/v1/campaigns/${c.id}/send`).send({}).expect(404);
    // Without two-step verification an admin cannot run campaigns.
    const second = await h.createUser({ role: 'BUSINESS_ADMIN', businessId: t.businessId });
    const noMfa = await h.login(second.username);
    const res = await noMfa.get(`/api/v1/businesses/${t.businessId}/campaigns`).expect(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    // Idempotent create.
    const key = uuid();
    const one = await create(t.session, t.businessId, { clientCampaignId: key }).expect(201);
    const two = await create(t.session, t.businessId, { clientCampaignId: key }).expect(201);
    expect(two.body.id).toBe(one.body.id);
  });
});
