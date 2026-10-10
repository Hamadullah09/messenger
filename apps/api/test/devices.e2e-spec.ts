import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, globalAgent, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  DeviceDto,
  LoginResponseDto,
  NotificationConfigDto,
  PushPayload,
} from '@storeline/shared';
import ece from 'http_ece';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, PASSWORD, uuid, type Session } from './harness';

interface Received {
  path: string;
  urgency: string | undefined;
  payload: PushPayload;
}

/**
 * Multi-client readiness: native token flow, device registry, session revocation across
 * devices, and Web Push end to end against a local push service that decrypts the RFC 8291
 * payload (so we can assert exactly what would reach a lock screen).
 */
describe('Devices and push notifications', () => {
  let h: Harness;
  let push: Server;
  let pushOrigin: string;
  const received: Received[] = [];
  let pushStatus = 201;
  const keys = new Map<string, { ecdh: ReturnType<typeof createECDH>; auth: Buffer }>();

  beforeAll(async () => {
    const vapid = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.WEB_PUSH_ALLOWED_HOSTS = '127.0.0.1';
    // A throwaway certificate for the fake push service, trusted only inside this test process.
    const dir = mkdtempSync(join(tmpdir(), 'sma-push-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'cert.pem'));
    globalAgent.options.ca = cert;
    push = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const id = (req.url ?? '').split('/').pop()!;
        const k = keys.get(id);
        if (k && pushStatus < 300) {
          const plain = ece.decrypt(Buffer.concat(chunks), {
            version: 'aes128gcm',
            privateKey: k.ecdh,
            authSecret: k.auth,
          });
          received.push({
            path: req.url ?? '',
            urgency: req.headers.urgency as string | undefined,
            payload: JSON.parse(plain.toString('utf8')) as PushPayload,
          });
        }
        res.writeHead(pushStatus).end();
      });
    });
    await new Promise<void>((r) => push.listen(0, '127.0.0.1', r));
    pushOrigin = `https://127.0.0.1:${(push.address() as AddressInfo).port}`;
    h = await Harness.start({ worker: true });
  });
  afterAll(async () => {
    await h.stop();
    push.close();
  });

  function subscription() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const id = uuid();
    keys.set(id, { ecdh, auth });
    return {
      id,
      body: {
        provider: 'WEB_PUSH',
        subscription: {
          endpoint: `${pushOrigin}/push/${id}`,
          keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') },
        },
      },
    };
  }

  const waitFor = async <T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > until) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  async function setup() {
    const businessId = (await h.createBusiness()).id;
    const storeId = (await h.createStore(businessId)).id;
    const a = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const b = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeId] });
    const sa = await h.login(a.username);
    const sb = await h.login(b.username);
    const dm = await sb
      .post('/api/v1/conversations/direct')
      .send({ businessId, userId: a.id })
      .expect(201);
    return { businessId, storeId, a, b, sa, sb, conversationId: dm.body.id as string };
  }

  async function registerPush(s: Session) {
    await s
      .post('/api/v1/devices')
      .send({ platform: 'WEB', name: 'Chrome on Windows' })
      .expect(200);
    const sub = subscription();
    await s.put('/api/v1/devices/current/push').send(sub.body).expect(200);
    return sub.id;
  }

  const send = (s: Session, conversationId: string, body: string) =>
    s
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .send({ clientMessageId: uuid(), body })
      .expect(201);

  it('gives native clients the refresh token in the body and rotates it with reuse detection', async () => {
    const t = await setup();
    const login = await h
      .http()
      .post('/api/v1/auth/login')
      .set('X-SMA-Client', 'native')
      .send({ username: t.a.username, password: PASSWORD })
      .expect(200);
    const body = login.body as Extract<LoginResponseDto, { mfaRequired: false }>;
    expect(body.refreshToken).toBeTruthy();
    expect(login.headers['set-cookie']).toBeUndefined();

    const refreshed = await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('X-SMA-Client', 'native')
      .send({ refreshToken: body.refreshToken })
      .expect(200);
    expect(refreshed.body.refreshToken).not.toBe(body.refreshToken);
    // Replaying the old token is treated as theft: the whole session ends.
    await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('X-SMA-Client', 'native')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
    await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('X-SMA-Client', 'native')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(401);
    // Browsers keep the cookie flow and never see the token.
    const web = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: t.a.username, password: PASSWORD });
    expect(web.body.refreshToken).toBeUndefined();
  });

  it('registers devices, rejects untrusted push endpoints and stores tokens encrypted', async () => {
    const t = await setup();
    const config = (await t.sa.get('/api/v1/notifications/config').expect(200))
      .body as NotificationConfigDto;
    expect(config).toMatchObject({ providers: { WEB_PUSH: true, FCM: false, APNS: false } });
    expect(config.webPushPublicKey).toBe(process.env.VAPID_PUBLIC_KEY);

    await t.sa.put('/api/v1/devices/current/push').send(subscription().body).expect(409); // no device yet
    const device = (
      await t.sa.post('/api/v1/devices').send({ platform: 'WEB', name: 'Edge' }).expect(200)
    ).body as DeviceDto;
    const again = (
      await t.sa.post('/api/v1/devices').send({ platform: 'WEB', name: 'Edge 2' }).expect(200)
    ).body as DeviceDto;
    expect(again.id).toBe(device.id);

    const evil = subscription().body;
    evil.subscription.endpoint = 'https://169.254.169.254/latest/meta-data';
    await t.sa.put('/api/v1/devices/current/push').send(evil).expect(400);
    await t.sa
      .put('/api/v1/devices/current/push')
      .send({ provider: 'FCM', token: 'x'.repeat(40) })
      .expect(409);

    const sub = subscription();
    const registered = (await t.sa.put('/api/v1/devices/current/push').send(sub.body).expect(200))
      .body as DeviceDto;
    expect(registered.push?.provider).toBe('WEB_PUSH');
    const row = await h.prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushTokenEnc).not.toContain(sub.id);
    expect(row.pushTokenEnc).not.toContain('127.0.0.1');
    const list = (await t.sa.get('/api/v1/devices').expect(200)).body as DeviceDto[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ current: true, name: 'Edge 2' });
  });

  it('notifies offline devices without message content unless allowed', async () => {
    const t = await setup();
    const id = await registerPush(t.sa);
    const mine = () => received.filter((r) => r.path.endsWith(id));

    await send(t.sb, t.conversationId, 'Delivery at 6 — secret code 4471');
    const first = await waitFor(mine, (r) => r.length === 1);
    expect(first[0]!.payload).toMatchObject({
      type: 'message',
      title: 'SMA',
      body: 'New message',
      conversationId: t.conversationId,
    });
    expect(JSON.stringify(first[0])).not.toContain('4471');

    // The user asks for content, but the business does not allow it: sender name only.
    await t.sa
      .put('/api/v1/notifications/preferences')
      .send({ pushEnabled: true, preview: 'CONTENT' })
      .expect(200);
    await send(t.sb, t.conversationId, 'Second: code 9911');
    const second = await waitFor(mine, (r) => r.length === 2);
    expect(second[1]!.payload.title).not.toBe('SMA'); // sender name, no content
    expect(second[1]!.payload.body).toBe('New message');
    expect(JSON.stringify(second[1])).not.toContain('9911');

    await h.prisma.business.update({
      where: { id: t.businessId },
      data: { policy: { pushContentAllowed: true } },
    });
    await send(t.sb, t.conversationId, 'Third: code 5555');
    const third = await waitFor(mine, (r) => r.length === 3);
    expect(third[2]!.payload.body).toBe('Third: code 5555');

    // Notifications off → nothing more.
    await t.sa
      .put('/api/v1/notifications/preferences')
      .send({ pushEnabled: false, preview: 'NONE' })
      .expect(200);
    await send(t.sb, t.conversationId, 'Fourth');
    await new Promise((r) => setTimeout(r, 1500));
    expect(mine()).toHaveLength(3);
  });

  it('skips online users and muted chats, but always alerts for emergencies', async () => {
    const t = await setup();
    const id = await registerPush(t.sa);
    const mine = () => received.filter((r) => r.path.endsWith(id));

    const socket = await h.socket(t.sa); // online now
    await send(t.sb, t.conversationId, 'while online');
    await new Promise((r) => setTimeout(r, 1500));
    expect(mine()).toHaveLength(0);
    socket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    await t.sa
      .patch(`/api/v1/conversations/${t.conversationId}/me`)
      .send({ mutedUntil: new Date(Date.now() + 3600_000).toISOString() })
      .expect(200);
    await send(t.sb, t.conversationId, 'while muted');
    await new Promise((r) => setTimeout(r, 1500));
    expect(mine()).toHaveLength(0);

    // Emergency: the employee raises one; the manager's device rings even though they are online.
    const managerDevice = await registerPush(t.sb);
    const managerSocket = await h.socket(t.sb);
    const raised = await t.sa
      .post('/api/v1/emergency/incidents')
      .send({ clientIncidentId: uuid(), category: 'MEDICAL' })
      .expect(201);
    const alert = await waitFor(
      () => received.filter((r) => r.path.endsWith(managerDevice)),
      (r) => r.length === 1,
    );
    expect(alert[0]).toMatchObject({
      urgency: 'high',
      payload: { type: 'emergency', incidentId: raised.body.incident.id, title: 'Emergency alert' },
    });
    managerSocket.disconnect();
  });

  it('forgets expired subscriptions and signs devices out across sessions', async () => {
    const t = await setup();
    await registerPush(t.sa);
    pushStatus = 410;
    await send(t.sb, t.conversationId, 'gone?');
    await waitFor(
      () => h.prisma.device.findFirst({ where: { userId: t.a.id } }),
      (d) => d?.pushTokenEnc === null && d?.lastPushError === 'subscription_gone',
    );
    pushStatus = 201;

    // A second device; "sign out other devices" from the first ends it and its push registration.
    const other = await h.login(t.a.username);
    await registerPush(other);
    const result = await t.sa.delete('/api/v1/me/sessions').expect(200);
    expect(result.body.revoked).toBeGreaterThanOrEqual(1);
    await other.get('/api/v1/me').expect(401);
    const devices = await h.prisma.device.findMany({ where: { userId: t.a.id } });
    expect(devices.every((d) => d.pushTokenEnc === null)).toBe(true);

    // Signing a single device out by id.
    const third = await h.login(t.a.username);
    const device = (
      await third.post('/api/v1/devices').send({ platform: 'ANDROID', name: 'Pixel' }).expect(200)
    ).body as DeviceDto;
    await t.sa.delete(`/api/v1/devices/${device.id}`).expect(204);
    await third.get('/api/v1/me').expect(401);
    // Someone else's device id is not found.
    await t.sb.delete(`/api/v1/devices/${device.id}`).expect(404);
  });
});
