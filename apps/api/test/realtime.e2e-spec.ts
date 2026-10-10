import type {
  AckResponse,
  ConversationSummaryDto,
  MessageDto,
  ReceiptUpdatedEvent,
} from '@storeline/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelayService } from '../src/modules/outbox/outbox-relay.service';
import { collectEvents, Harness, nextEvent, uuid, type Session } from './harness';

/** Real-time delivery through the outbox → BullMQ → worker → Redis emitter → Socket.IO pipeline. */
describe('Real-time delivery', () => {
  let h: Harness;
  let businessId: string;
  let storeId: string;
  let alice: Session;
  let bob: Session;
  let manager: Session;
  let groupId: string;
  let ids: Record<'alice' | 'bob' | 'manager', string>;

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    businessId = (await h.createBusiness()).id;
    storeId = (await h.createStore(businessId)).id;
    const m = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeId] });
    const a = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const b = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    ids = { manager: m.id, alice: a.id, bob: b.id };
    manager = await h.login(m.username);
    alice = await h.login(a.username);
    bob = await h.login(b.username);
    groupId = (
      await manager
        .post('/api/v1/conversations/groups')
        .send({ businessId, storeId, title: 'Live group', memberIds: [ids.alice, ids.bob] })
        .expect(201)
    ).body.id;
  });
  afterAll(() => h.stop());

  it('rejects sockets without a valid token', async () => {
    await expect(h.socket({ token: 'bogus' } as Session)).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('delivers new messages to members, marks them dispatched, and relays receipts to the sender', async () => {
    const aliceSocket = await h.socket(alice);
    const bobSocket = await h.socket(bob);

    const bobReceives = nextEvent<MessageDto>(
      bobSocket,
      'message.created',
      8_000,
      (m) => m.body === 'live hello',
    );
    const aliceDispatched = nextEvent<{ messageId: string; state: string }>(
      aliceSocket,
      'message.status_changed',
      8_000,
    );
    const sent = await alice
      .post(`/api/v1/conversations/${groupId}/messages`)
      .send({ clientMessageId: uuid(), body: 'live hello' })
      .expect(201);
    expect(sent.body.state).toBe('ACCEPTED'); // accepted ≠ delivered

    const received = await bobReceives;
    expect(received).toMatchObject({
      id: sent.body.id,
      seq: sent.body.seq,
      conversationId: groupId,
    });
    expect(await aliceDispatched).toMatchObject({ messageId: sent.body.id, state: 'DISPATCHED' });

    const receipt = nextEvent<ReceiptUpdatedEvent>(
      aliceSocket,
      'receipt.updated',
      5_000,
      (r) => r.userId === ids.bob,
    );
    const ack = await bobSocket.emitWithAck('message.delivered', {
      conversationId: groupId,
      seq: received.seq,
    });
    expect(ack).toEqual({ ok: true });
    expect(await receipt).toMatchObject({ lastDeliveredSeq: received.seq });

    const read = nextEvent<ReceiptUpdatedEvent>(
      aliceSocket,
      'receipt.updated',
      5_000,
      (r) => (r.lastReadSeq ?? 0) >= received.seq,
    );
    await bobSocket.emitWithAck('message.read', { conversationId: groupId, seq: received.seq });
    expect(await read).toMatchObject({ userId: ids.bob, lastReadSeq: received.seq });
  });

  it('validates and authorizes socket events', async () => {
    const outsider = await h.login(
      (await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] })).username,
    );
    const socket = await h.socket(outsider);
    const bad = (await socket.emitWithAck('message.read', {
      conversationId: 'nope',
      seq: -1,
    })) as AckResponse;
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    const forbidden = (await socket.emitWithAck('message.read', {
      conversationId: groupId,
      seq: 1,
    })) as AckResponse;
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('forged future seqs are clamped to the conversation head', async () => {
    const bobSocket = await h.socket(bob);
    await bobSocket.emitWithAck('message.read', { conversationId: groupId, seq: 1_000_000 });
    const member = await h.prisma.conversationMember.findFirstOrThrow({
      where: { conversationId: groupId, userId: ids.bob },
    });
    const conversation = await h.prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    expect(member.lastReadSeq).toBe(conversation.lastSeq);
  });

  it('typing indicators reach other members only', async () => {
    const aliceSocket = await h.socket(alice);
    const bobSocket = await h.socket(bob);
    const typing = nextEvent<{ userId: string; typing: boolean }>(bobSocket, 'typing.changed');
    const echoed = collectEvents(aliceSocket, 'typing.changed', 800);
    await aliceSocket.emitWithAck('typing.start', { conversationId: groupId });
    expect(await typing).toMatchObject({ userId: ids.alice, typing: true });
    expect(await echoed).toHaveLength(0);
  });

  it('removed members stop receiving events immediately', async () => {
    const bobSocket = await h.socket(bob);
    const removed = nextEvent<{ conversationId: string }>(bobSocket, 'conversation.removed', 8_000);
    await manager.delete(`/api/v1/conversations/${groupId}/members/${ids.bob}`).expect(204);
    expect(await removed).toEqual({ conversationId: groupId });

    const leaked = collectEvents<MessageDto>(bobSocket, 'message.created', 2_500);
    await alice
      .post(`/api/v1/conversations/${groupId}/messages`)
      .send({ clientMessageId: uuid(), body: 'after removal' })
      .expect(201);
    expect((await leaked).filter((m) => m.conversationId === groupId)).toHaveLength(0);
    await manager
      .post(`/api/v1/conversations/${groupId}/members`)
      .send({ userIds: [ids.bob] })
      .expect(201);
  });

  it('pushes per-user conversation summaries when a group changes', async () => {
    const aliceSocket = await h.socket(alice);
    const update = nextEvent<ConversationSummaryDto>(
      aliceSocket,
      'conversation.updated',
      8_000,
      (c) => c.title === 'Renamed group',
    );
    await manager
      .patch(`/api/v1/conversations/${groupId}`)
      .send({ title: 'Renamed group' })
      .expect(200);
    const summary = await update;
    expect(summary.me.role).toBe('MEMBER');
    expect(summary.id).toBe(groupId);
  });

  it('revoking a session disconnects its sockets', async () => {
    const session = await h.login(
      (await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] })).username,
    );
    const socket = await h.socket(session);
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await session.post('/api/v1/auth/logout').expect(204);
    expect(await disconnected).toBe('io server disconnect');
  });

  it('missed messages are recovered by seq after reconnecting', async () => {
    const aliceSocket = await h.socket(alice);
    const known = (await alice.get(`/api/v1/conversations/${groupId}`).expect(200)).body
      .lastSeq as number;
    aliceSocket.disconnect();
    for (const body of ['missed 1', 'missed 2', 'missed 3']) {
      await bob
        .post(`/api/v1/conversations/${groupId}/messages`)
        .send({ clientMessageId: uuid(), body })
        .expect(201);
    }
    const list = await alice.get(`/api/v1/conversations?businessId=${businessId}`).expect(200);
    const head = list.body.items.find((c: { id: string }) => c.id === groupId).lastSeq as number;
    expect(head).toBe(known + 3);
    const page = await alice
      .get(`/api/v1/conversations/${groupId}/messages?afterSeq=${known}`)
      .expect(200);
    expect(page.body.items.map((m: MessageDto) => m.body)).toEqual([
      'missed 1',
      'missed 2',
      'missed 3',
    ]);
  });

  it('the relay publishes events left pending by a crash between commit and enqueue', async () => {
    const conversation = await h.prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    const bobSocket = await h.socket(bob);
    // Simulate the API crashing after COMMIT: the message and outbox row exist, but nothing was enqueued.
    const message = await h.prisma.$transaction(async (tx) => {
      const { lastSeq } = await tx.conversation.update({
        where: { id: groupId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      const created = await tx.message.create({
        data: {
          conversationId: groupId,
          seq: lastSeq,
          senderId: ids.alice,
          clientMessageId: uuid(),
          body: 'recovered by relay',
        },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'message.created',
          payload: { messageId: created.id },
          businessId: conversation.businessId,
        },
      });
      return created;
    });
    const delivered = nextEvent<MessageDto>(
      bobSocket,
      'message.created',
      8_000,
      (m) => m.id === message.id,
    );
    await h.worker!.get(OutboxRelayService).relayOnce();
    expect((await delivered).body).toBe('recovered by relay');
    const outbox = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { payload: { equals: { messageId: message.id } } },
    });
    expect(outbox.status).toBe('PUBLISHED');
  });
});
