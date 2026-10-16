import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, type Session } from './harness';

/**
 * Calls left behind (tab closed, page reloaded, phone off the network) end by themselves and
 * never keep anyone "already in a call".
 */
describe('Abandoned calls', () => {
  let h: Harness;
  let redis: Redis;
  let a: Session;
  let b: Session;
  let aId: string;
  let conversationId: string;

  /** Makes a call look older than the "still here" window, with that person's beat missing. */
  async function abandon(callId: string, userId: string) {
    const raw = await redis.get(`call:${callId}`);
    const call = JSON.parse(raw!) as { startedAt: string };
    call.startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await redis.set(`call:${callId}`, JSON.stringify(call), 'KEEPTTL');
    await redis.del(`call-alive:${callId}:${userId}`);
  }

  beforeAll(async () => {
    h = await Harness.start();
    redis = new Redis(process.env.REDIS_URL!);
    const businessId = (await h.createBusiness()).id;
    const storeId = (await h.createStore(businessId)).id;
    const ua = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const ub = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeId] });
    aId = ua.id;
    a = await h.login(ua.username);
    b = await h.login(ub.username);
    conversationId = (
      await b.post('/api/v1/conversations/direct').send({ businessId, userId: ua.id }).expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await redis.quit();
    await h.stop();
  });

  const call = (s: Session) =>
    s.post('/api/v1/calls').send({ conversationId, media: 'audio' }).expect(201);

  it('shows a ringing call again after a reload, and frees a caller who left', async () => {
    const first = (await call(b)).body as { id: string };
    // The person called reloads: the ringing call is still there for them.
    expect((await a.get('/api/v1/calls/incoming').expect(200)).body.call.id).toBe(first.id);
    expect((await b.post(`/api/v1/calls/${first.id}/alive`).expect(200)).body.state).toBe(
      'ringing',
    );
    // A second call while the first one is really alive: busy.
    await b.post('/api/v1/calls').send({ conversationId, media: 'audio' }).expect(409);

    // The caller's tab went away long ago: the next call works and the old one is a missed call.
    await abandon(first.id, (await b.get('/api/v1/me').expect(200)).body.user.id);
    const second = (await call(b)).body as { id: string; state: string };
    expect(second.state).toBe('ringing');
    expect((await b.get(`/api/v1/calls/${first.id}`).expect(200)).body).toMatchObject({
      state: 'ended',
      outcome: 'missed',
    });
    expect((await a.get('/api/v1/calls/incoming').expect(200)).body.call.id).toBe(second.id);
    await b.post(`/api/v1/calls/${second.id}/end`).send({ reason: 'hangup' }).expect(200);
    expect((await a.get('/api/v1/calls/incoming').expect(200)).body.call).toBeNull();
  });

  it('ends an answered call when one side disappears, and tells the other device', async () => {
    const live = (await call(b)).body as { id: string };
    await a.post(`/api/v1/calls/${live.id}/accept`).expect(200);
    expect((await a.post(`/api/v1/calls/${live.id}/alive`).expect(200)).body.state).toBe('active');
    await abandon(live.id, aId);
    expect((await b.get(`/api/v1/calls/${live.id}`).expect(200)).body).toMatchObject({
      state: 'ended',
      outcome: 'answered',
    });
    expect((await b.post(`/api/v1/calls/${live.id}/alive`).expect(200)).body.state).toBe('ended');
    // Nobody stays "in a call".
    await call(a);
  });
});
