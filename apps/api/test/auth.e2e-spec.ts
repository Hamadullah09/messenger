import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, PASSWORD, refreshCookie } from './harness';

describe('Authentication and sessions', () => {
  let h: Harness;
  let businessId: string;
  let storeId: string;

  beforeAll(async () => {
    h = await Harness.start();
    businessId = (await h.createBusiness()).id;
    storeId = (await h.createStore(businessId)).id;
    await h.createUser({ username: 'emp', role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    await h.createUser({ username: 'admin', role: 'BUSINESS_ADMIN', businessId });
  });
  afterAll(() => h.stop());

  it('signs in with valid credentials and returns the profile without secrets', async () => {
    const res = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: 'EMP', password: PASSWORD })
      .expect(200);
    expect(res.body.mfaRequired).toBe(false);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.me.user.username).toBe('emp');
    const cookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookie.find((c) => c.startsWith('sl_refresh='))).toMatch(/HttpOnly/i);
    expect(cookie.find((c) => c.startsWith('sl_refresh='))).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret|refreshToken/);
  });

  it('uses one generic error for unknown users and wrong passwords', async () => {
    const unknown = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: 'nobody', password: 'x' })
      .expect(401);
    const wrong = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: 'emp', password: 'wrong-password' })
      .expect(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    expect(unknown.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects requests without a valid bearer token', async () => {
    await h.http().get('/api/v1/me').expect(401);
    await h.http().get('/api/v1/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('rotates refresh tokens and revokes the session when a used token is replayed', async () => {
    const session = await h.login('emp');
    const first = await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie!)
      .set('X-Storeline-CSRF', '1')
      .expect(200);
    const rotatedCookie = refreshCookie(first.headers['set-cookie']);
    expect(rotatedCookie).not.toBe(session.refreshCookie);

    // Replaying the consumed token is treated as theft: the whole session is revoked.
    await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie!)
      .set('X-Storeline-CSRF', '1')
      .expect(401);
    await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookie!)
      .set('X-Storeline-CSRF', '1')
      .expect(401);
    await h
      .http()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(401);
  });

  it('requires the CSRF header on the cookie-authenticated refresh endpoint', async () => {
    const session = await h.login('emp');
    await h.http().post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie!).expect(403);
    await h
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie!)
      .set('X-Storeline-CSRF', '1')
      .set('Origin', 'https://evil.example')
      .expect(403);
  });

  it('logout revokes the access token immediately', async () => {
    const session = await h.login('emp');
    await session.get('/api/v1/me').expect(200);
    await session.post('/api/v1/auth/logout').expect(204);
    await session.get('/api/v1/me').expect(401);
  });

  it('forces a password change before anything else when required', async () => {
    const user = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    await h.prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
    const session = await h.login(user.username);
    const blocked = await session.get('/api/v1/conversations').expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await session.get('/api/v1/me').expect(200);
    await session
      .post('/api/v1/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' })
      .expect(204);
    await session.get('/api/v1/conversations').expect(200);
  });

  it('changing the password signs out other devices', async () => {
    const user = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const deviceA = await h.login(user.username);
    const deviceB = await h.login(user.username);
    await deviceA
      .post('/api/v1/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'another-long-password-1' })
      .expect(204);
    await deviceA.get('/api/v1/me').expect(200);
    await deviceB.get('/api/v1/me').expect(401);
  });

  it('privileged permissions require MFA; enrolment unlocks them and later sign-ins need a code', async () => {
    const plain = await h.login('admin');
    const denied = await plain
      .post(`/api/v1/businesses/${businessId}/stores`)
      .send({ name: 'New Store', code: 'NEW1' })
      .expect(403);
    expect(denied.body.error.code).toBe('MFA_REQUIRED');

    const secured = await h.loginWithMfa('admin');
    await secured
      .post(`/api/v1/businesses/${businessId}/stores`)
      .send({ name: 'New Store', code: 'NEW1' })
      .expect(201);

    // Next sign-in requires a TOTP code; use the next time step (the current one was consumed).
    const step1 = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    expect(step1.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    await h
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: '000000' })
      .expect(400);
    const code = h.mfa.generate(secured.mfaSecret, Date.now() + 30_000);
    const ok = await h
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code })
      .expect(200);
    expect(ok.body.me.session.mfaVerified).toBe(true);

    // The same code cannot be replayed.
    const again = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    await h
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: again.body.mfaToken, code })
      .expect(400);
  });

  it('limits two-step guesses per attempt and per user, without blocking a shared office IP', async () => {
    const businessId = (await h.createBusiness()).id;
    const signInWithCode = async (username: string, secret: string) => {
      const step = await h
        .http()
        .post('/api/v1/auth/login')
        .send({ username, password: PASSWORD })
        .expect(200);
      return h
        .http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: step.body.mfaToken, code: h.mfa.generate(secret, Date.now() + 30_000) });
    };

    // Seven colleagues behind one office IP all complete two-step sign-in.
    for (let i = 0; i < 7; i++) {
      const u = await h.createUser({ role: 'BUSINESS_ADMIN', businessId });
      const { mfaSecret } = await h.loginWithMfa(u.username);
      await h.clearRateLimits('rl:login:*');
      expect((await signInWithCode(u.username, mfaSecret)).status).toBe(200);
    }

    // One attempt allows 5 guesses.
    const victim = await h.createUser({ role: 'BUSINESS_ADMIN', businessId });
    const { mfaSecret } = await h.loginWithMfa(victim.username);
    const attempt = async () =>
      (
        await h
          .http()
          .post('/api/v1/auth/login')
          .send({ username: victim.username, password: PASSWORD })
          .expect(200)
      ).body.mfaToken as string;
    const guess = (token: string, code = '000000') =>
      h.http().post('/api/v1/auth/mfa/verify').send({ mfaToken: token, code });
    const first = await attempt();
    for (let i = 0; i < 5; i++) {
      const r = await guess(first);
      expect(r.status, `first #${i} ${JSON.stringify(r.body)}`).toBe(400);
    }
    expect((await guess(first)).status).toBe(429);

    // Across attempts, 10 wrong codes lock two-step sign-in for the user — even a right code.
    const second = await attempt();
    for (let i = 0; i < 5; i++) {
      const r = await guess(second);
      expect(r.status, `second #${i} ${JSON.stringify(r.body)}`).toBe(400);
    }
    const third = await attempt();
    const right = await guess(third, h.mfa.generate(mfaSecret, Date.now() + 30_000));
    expect(right.status).toBe(429);
  });

  it('rate limits repeated failed logins for a username', async () => {
    await h.clearRateLimits();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await h
        .http()
        .post('/api/v1/auth/login')
        .send({ username: 'ratelimited', password: 'nope-nope' });
      last = res.status;
    }
    expect(last).toBe(429);
    await h.clearRateLimits();
  });

  it('lists and revokes own sessions', async () => {
    const a = await h.login('emp');
    const b = await h.login('emp');
    const list = await a.get('/api/v1/me/sessions').expect(200);
    const other = (list.body as Array<{ id: string; current: boolean }>).find((s) => !s.current)!;
    expect(other).toBeDefined();
    await a.delete(`/api/v1/me/sessions/${other.id}`).expect(204);
    // b may or may not be the one revoked; at least one of the non-current sessions is gone.
    const after = await a.get('/api/v1/me/sessions').expect(200);
    expect(after.body.length).toBe(list.body.length - 1);
    void b;
  });

  it('deactivated users lose access immediately', async () => {
    const user = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const session = await h.login(user.username);
    const admin = await h.loginWithMfa(
      (await h.createUser({ role: 'BUSINESS_ADMIN', businessId })).username,
    );
    await admin.post(`/api/v1/users/${user.id}/deactivate`).expect(204);
    await session.get('/api/v1/me').expect(401);
    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: user.username, password: PASSWORD })
      .expect(401);
  });
});
