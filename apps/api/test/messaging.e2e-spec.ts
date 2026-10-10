import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, uuid, type Session } from './harness';

describe('Conversations and messages', () => {
  let h: Harness;
  let businessId: string;
  let storeA: string;
  let storeB: string;
  let manager: Session; // store manager, store A
  let alice: Session; // employee, store A
  let bob: Session; // employee, store A
  let carol: Session; // employee, store B
  let outsider: Session; // employee of another business
  let ids: Record<'manager' | 'alice' | 'bob' | 'carol' | 'outsider', string>;

  beforeAll(async () => {
    h = await Harness.start();
    businessId = (await h.createBusiness()).id;
    storeA = (await h.createStore(businessId, 'A')).id;
    storeB = (await h.createStore(businessId, 'B')).id;
    const other = (await h.createBusiness()).id;
    const otherStore = (await h.createStore(other, 'Z')).id;
    const m = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeA] });
    const a = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const b = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const c = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeB] });
    const o = await h.createUser({ role: 'EMPLOYEE', businessId: other, storeIds: [otherStore] });
    ids = { manager: m.id, alice: a.id, bob: b.id, carol: c.id, outsider: o.id };
    manager = await h.login(m.username);
    alice = await h.login(a.username);
    bob = await h.login(b.username);
    carol = await h.login(c.username);
    outsider = await h.login(o.username);
  });
  afterAll(() => h.stop());

  const send = (
    s: Session,
    conversationId: string,
    body: string,
    extra: Record<string, unknown> = {},
  ) =>
    s
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .send({ clientMessageId: uuid(), body, ...extra });

  describe('direct messages', () => {
    it('allows colleagues who share a store and returns the same conversation twice', async () => {
      const first = await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.bob })
        .expect(201);
      const second = await bob
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.alice })
        .expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(first.body.counterpart.id).toBe(ids.bob);
      expect(first.body.title).toBe(first.body.counterpart.displayName);
    });

    it('blocks direct messages across stores for employees and across businesses for everyone', async () => {
      await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.carol })
        .expect(404);
      await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.outsider })
        .expect(404);
      const dir = await alice.get(`/api/v1/directory?businessId=${businessId}`).expect(200);
      const visible = dir.body.map((u: { id: string }) => u.id);
      expect(visible).toEqual(expect.arrayContaining([ids.bob, ids.manager]));
      expect(visible).not.toContain(ids.carol);
      expect(visible).not.toContain(ids.alice);
    });
  });

  describe('groups', () => {
    let groupId: string;

    it('store manager creates a group in their store with eligible members only', async () => {
      await manager
        .post('/api/v1/conversations/groups')
        .send({
          businessId,
          storeId: storeA,
          title: 'Store A Ops',
          memberIds: [ids.alice, ids.carol],
        })
        .expect(400); // carol works at store B
      await manager
        .post('/api/v1/conversations/groups')
        .send({ businessId, storeId: storeB, title: 'Not my store', memberIds: [] })
        .expect(403);
      await alice
        .post('/api/v1/conversations/groups')
        .send({ businessId, storeId: storeA, title: 'Employee group', memberIds: [] })
        .expect(403);
      const res = await manager
        .post('/api/v1/conversations/groups')
        .send({
          businessId,
          storeId: storeA,
          title: 'Store A Ops',
          memberIds: [ids.alice, ids.bob],
          category: 'OPERATIONS',
        })
        .expect(201);
      groupId = res.body.id;
      expect(res.body).toMatchObject({ type: 'GROUP', memberCount: 3, lastSeq: 1 });
      expect(res.body.members).toHaveLength(3);
      expect(res.body.lastMessage.systemEvent.type).toBe('group_created');
    });

    it('hides the group from non-members (404, not 403)', async () => {
      await carol.get(`/api/v1/conversations/${groupId}`).expect(404);
      await carol.get(`/api/v1/conversations/${groupId}/messages`).expect(404);
      await send(carol, groupId, 'let me in').expect(404);
      await outsider.get(`/api/v1/conversations/${groupId}`).expect(404);
      const list = await carol.get('/api/v1/conversations').expect(200);
      expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(groupId);
    });

    it('sends messages idempotently with gap-free sequence numbers', async () => {
      const clientMessageId = uuid();
      const a = await alice
        .post(`/api/v1/conversations/${groupId}/messages`)
        .send({ clientMessageId, body: 'Hello' })
        .expect(201);
      const retry = await alice
        .post(`/api/v1/conversations/${groupId}/messages`)
        .send({ clientMessageId, body: 'Hello' })
        .expect(200);
      expect(retry.body.id).toBe(a.body.id);

      const concurrent = await Promise.all(
        Array.from({ length: 10 }, (_, i) => send(bob, groupId, `msg ${i}`)),
      );
      expect(concurrent.every((r) => r.status === 201)).toBe(true);
      const seqs = [a.body.seq, ...concurrent.map((r) => r.body.seq)].sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: 11 }, (_, i) => i + 2));

      const page = await alice
        .get(`/api/v1/conversations/${groupId}/messages?limit=100`)
        .expect(200);
      expect(page.body.items.map((m: { seq: number }) => m.seq)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      const after = await alice
        .get(`/api/v1/conversations/${groupId}/messages?afterSeq=10`)
        .expect(200);
      expect(after.body.items.map((m: { seq: number }) => m.seq)).toEqual([11, 12]);
    });

    it('validates input: empty bodies, oversized bodies, foreign reply targets', async () => {
      await send(alice, groupId, '   ').expect(400);
      await send(alice, groupId, 'x'.repeat(4097)).expect(400);
      const dm = await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.bob })
        .expect(201);
      const dmMessage = await send(alice, dm.body.id, 'private').expect(201);
      await send(alice, groupId, 'reply', { replyToId: dmMessage.body.id }).expect(400);
    });

    it('supports replies, reactions, edits, stars and pins', async () => {
      const original = await send(alice, groupId, 'Truck arrives at 9').expect(201);
      const reply = await send(bob, groupId, 'Got it', { replyToId: original.body.id }).expect(201);
      expect(reply.body.replyTo).toMatchObject({
        id: original.body.id,
        bodyPreview: 'Truck arrives at 9',
      });

      const reacted = await bob
        .put(`/api/v1/messages/${original.body.id}/reaction`)
        .send({ emoji: '👍' })
        .expect(200);
      expect(reacted.body.reactions).toEqual([{ emoji: '👍', userId: ids.bob }]);
      await bob
        .put(`/api/v1/messages/${original.body.id}/reaction`)
        .send({ emoji: 'hello' })
        .expect(400);

      await bob.patch(`/api/v1/messages/${original.body.id}`).send({ body: 'hijack' }).expect(403);
      const edited = await alice
        .patch(`/api/v1/messages/${original.body.id}`)
        .send({ body: 'Truck arrives at 10' })
        .expect(200);
      expect(edited.body).toMatchObject({
        body: 'Truck arrives at 10',
        editedAt: expect.any(String),
      });
      expect(
        await h.prisma.messageRevision.count({
          where: { messageId: original.body.id, reason: 'EDIT' },
        }),
      ).toBe(1);

      await alice.put(`/api/v1/messages/${original.body.id}/star`).expect(204);
      const starred = await alice.get('/api/v1/messages/starred').expect(200);
      expect(starred.body.items.map((m: { id: string }) => m.id)).toContain(original.body.id);

      await alice.put(`/api/v1/messages/${original.body.id}/pin`).expect(200);
      const pins = await bob.get(`/api/v1/conversations/${groupId}/pins`).expect(200);
      expect(pins.body.map((m: { id: string }) => m.id)).toEqual([original.body.id]);
    });

    it('enforces edit windows and delete permissions', async () => {
      const msg = await send(bob, groupId, 'old message').expect(201);
      await h.prisma.message.update({
        where: { id: msg.body.id },
        data: { createdAt: new Date(Date.now() - 2 * 3600_000) },
      });
      await bob.patch(`/api/v1/messages/${msg.body.id}`).send({ body: 'too late' }).expect(409);
      await bob.delete(`/api/v1/messages/${msg.body.id}`).expect(403);
      await alice.delete(`/api/v1/messages/${msg.body.id}`).expect(403);
      // The manager is a group admin and a moderator for store A.
      const deleted = await manager.delete(`/api/v1/messages/${msg.body.id}`).expect(200);
      expect(deleted.body).toMatchObject({ deleted: true, body: null });
      const audit = await h.prisma.auditLog.findFirst({
        where: { action: 'message.moderated_delete', targetId: msg.body.id },
      });
      expect(audit?.metadata).not.toHaveProperty('body');
    });

    it('admins-only groups reject posts from regular members', async () => {
      const res = await manager
        .post('/api/v1/conversations/groups')
        .send({
          businessId,
          storeId: storeA,
          title: 'Announcements',
          memberIds: [ids.alice],
          postingPolicy: 'ADMINS_ONLY',
        })
        .expect(201);
      expect(res.body.me.canPost).toBe(true);
      await send(alice, res.body.id, 'can I post?').expect(403);
      await send(manager, res.body.id, 'Store opens at 8').expect(201);
    });

    it('removed members lose access; re-added members only see new messages', async () => {
      await send(bob, groupId, 'before removal').expect(201);
      await bob.delete(`/api/v1/conversations/${groupId}/members/${ids.alice}`).expect(403); // not an admin
      await manager.delete(`/api/v1/conversations/${groupId}/members/${ids.bob}`).expect(204);
      await bob.get(`/api/v1/conversations/${groupId}/messages`).expect(404);
      await send(bob, groupId, 'still here?').expect(404);

      const secret = await send(alice, groupId, 'said while bob was away').expect(201);
      await manager
        .post(`/api/v1/conversations/${groupId}/members`)
        .send({ userIds: [ids.bob] })
        .expect(201);
      const page = await bob.get(`/api/v1/conversations/${groupId}/messages?limit=100`).expect(200);
      const seqs = page.body.items.map((m: { seq: number }) => m.seq);
      expect(Math.min(...seqs)).toBeGreaterThan(secret.body.seq);
      expect(page.body.items[0].systemEvent).toMatchObject({
        type: 'members_added',
        userIds: [ids.bob],
      });
      await bob.get(`/api/v1/messages/${secret.body.id}/info`).expect(404);
    });

    it('keeps at least one admin and lets members leave', async () => {
      const res = await manager
        .post('/api/v1/conversations/groups')
        .send({ businessId, storeId: storeA, title: 'Temp', memberIds: [ids.alice] })
        .expect(201);
      await manager
        .patch(`/api/v1/conversations/${res.body.id}/members/${ids.manager}`)
        .send({ role: 'MEMBER' })
        .expect(409);
      await manager
        .delete(`/api/v1/conversations/${res.body.id}/members/${ids.manager}`)
        .expect(204);
      const detail = await alice.get(`/api/v1/conversations/${res.body.id}`).expect(200);
      expect(detail.body.me.role).toBe('ADMIN');
    });

    it('message info reports per-recipient state from watermarks (sender only)', async () => {
      const msg = await send(alice, groupId, 'did you see this?').expect(201);
      await bob
        .post(`/api/v1/conversations/${groupId}/read`)
        .send({ seq: msg.body.seq })
        .expect(204);
      const info = await alice.get(`/api/v1/messages/${msg.body.id}/info`).expect(200);
      const byUser = Object.fromEntries(
        info.body.recipients.map((r: { user: { id: string }; status: string }) => [
          r.user.id,
          r.status,
        ]),
      );
      expect(byUser[ids.bob]).toBe('READ');
      expect(['PENDING', 'SENT']).toContain(byUser[ids.manager]);
      await bob.get(`/api/v1/messages/${msg.body.id}/info`).expect(403);
    });

    it('unread counts follow read watermarks and the manual unread mark', async () => {
      await send(alice, groupId, 'unread 1').expect(201);
      const last = await send(alice, groupId, 'unread 2').expect(201);
      const before = await manager.get(`/api/v1/conversations/${groupId}`).expect(200);
      expect(before.body.unreadCount).toBeGreaterThanOrEqual(2);
      await manager
        .post(`/api/v1/conversations/${groupId}/read`)
        .send({ seq: last.body.seq })
        .expect(204);
      const after = await manager.get(`/api/v1/conversations/${groupId}`).expect(200);
      expect(after.body.unreadCount).toBe(0);
      const marked = await manager
        .patch(`/api/v1/conversations/${groupId}/me`)
        .send({ markedUnread: true, pinned: true })
        .expect(200);
      expect(marked.body).toMatchObject({
        unreadCount: 1,
        me: { markedUnread: true, pinnedAt: expect.any(String) },
      });
    });

    it('search only returns messages the user can read', async () => {
      await send(alice, groupId, 'inventory audit tomorrow').expect(201);
      const own = await alice.get('/api/v1/search/messages?q=invent').expect(200);
      expect(own.body.items.map((r: { message: { body: string } }) => r.message.body)).toContain(
        'inventory audit tomorrow',
      );
      const other = await carol.get('/api/v1/search/messages?q=inventory').expect(200);
      expect(other.body.items).toHaveLength(0);
      // tsquery operators in user input are neutralised.
      await alice
        .get(`/api/v1/search/messages?q=${encodeURIComponent("inv:* & !') |")}`)
        .expect(200);
    });

    it('forwards only into conversations the user belongs to', async () => {
      const msg = await send(alice, groupId, 'forward me').expect(201);
      const dm = await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.manager })
        .expect(201);
      const forwarded = await alice
        .post(`/api/v1/messages/${msg.body.id}/forward`)
        .send({ targets: [{ conversationId: dm.body.id, clientMessageId: uuid() }] })
        .expect(201);
      expect(forwarded.body[0]).toMatchObject({
        forwarded: true,
        body: 'forward me',
        conversationId: dm.body.id,
      });

      const notMine = await manager
        .post('/api/v1/conversations/groups')
        .send({ businessId, storeId: storeA, title: 'Managers only', memberIds: [] })
        .expect(201);
      await alice
        .post(`/api/v1/messages/${msg.body.id}/forward`)
        .send({ targets: [{ conversationId: notMine.body.id, clientMessageId: uuid() }] })
        .expect(404);
    });
  });

  it('removing an employee from a store removes them from that store’s groups', async () => {
    const admin = await h.loginWithMfa(
      (await h.createUser({ role: 'BUSINESS_ADMIN', businessId })).username,
    );
    const user = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA, storeB] });
    const session = await h.login(user.username);
    const group = await manager
      .post('/api/v1/conversations/groups')
      .send({ businessId, storeId: storeA, title: 'Store A only', memberIds: [user.id] })
      .expect(201);
    await session.get(`/api/v1/conversations/${group.body.id}`).expect(200);
    await admin
      .put(`/api/v1/businesses/${businessId}/users/${user.id}/stores`)
      .send({ storeIds: [storeB] })
      .expect(200);
    await session.get(`/api/v1/conversations/${group.body.id}`).expect(404);
  });

  it('the chat list shows delivered/read status for my last message, respecting read-receipt policy', async () => {
    const dm = await alice
      .post('/api/v1/conversations/direct')
      .send({ businessId, userId: ids.bob })
      .expect(201);
    const msg = await send(alice, dm.body.id, 'status check').expect(201);
    const statusOf = async () =>
      (await alice.get('/api/v1/conversations').expect(200)).body.items.find(
        (c: { id: string }) => c.id === dm.body.id,
      ).lastMessageStatus;
    expect([null, 'SENT']).toContain(await statusOf());
    await h.prisma.conversationMember.updateMany({
      where: { conversationId: dm.body.id, userId: ids.bob },
      data: { lastDeliveredSeq: msg.body.seq },
    });
    expect(await statusOf()).toBe('DELIVERED');
    await bob
      .post(`/api/v1/conversations/${dm.body.id}/read`)
      .send({ seq: msg.body.seq })
      .expect(204);
    expect(await statusOf()).toBe('READ');
    // Bob's view: the last message is not his, so no status is shown.
    const bobView = (await bob.get('/api/v1/conversations').expect(200)).body.items.find(
      (c: { id: string }) => c.id === dm.body.id,
    );
    expect(bobView.lastMessageStatus).toBeNull();
    // With read receipts disabled the strongest status is DELIVERED.
    await h.prisma.business.update({
      where: { id: businessId },
      data: { policy: { readReceiptsEnabled: false } },
    });
    expect(await statusOf()).toBe('DELIVERED');
    await h.prisma.business.update({ where: { id: businessId }, data: { policy: {} } });
  });
});
