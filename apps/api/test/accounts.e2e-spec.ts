import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, PASSWORD, type Session } from './harness';

/**
 * Account administration: store managers run their own staff, admins change roles and
 * passwords, one person can manage several stores, password reset links, and the public
 * details (links, logo) of businesses and stores.
 */
describe('Accounts, roles and business details', () => {
  let h: Harness;
  let admin: Session;
  let manager: Session;
  let businessId: string;
  let storeA: string;
  let storeB: string;

  const newStaff = (session: Session, username: string, storeId: string, roleKey = 'EMPLOYEE') =>
    session.post(`/api/v1/businesses/${businessId}/users`).send({
      username,
      displayName: username,
      initialPassword: 'first-password',
      roleKey,
      storeIds: [storeId],
      email: `${username}@example.com`,
    });

  beforeAll(async () => {
    h = await Harness.start();
    businessId = (await h.createBusiness('Accounts Co')).id;
    storeA = (await h.createStore(businessId, 'AA')).id;
    storeB = (await h.createStore(businessId, 'BB')).id;
    await h.createUser({ username: 'acc.admin', role: 'BUSINESS_ADMIN', businessId });
    await h.createUser({
      username: 'acc.manager',
      role: 'STORE_MANAGER',
      businessId,
      storeIds: [storeA],
    });
    admin = await h.loginWithMfa('acc.admin');
    manager = await h.loginWithMfa('acc.manager');
  });
  afterAll(() => h.stop());

  it('a store manager adds staff to their own store only, and never admins', async () => {
    const created = await newStaff(manager, 'acc.staff1', storeA).expect(201);
    expect(created.body.roles).toEqual([
      expect.objectContaining({ roleKey: 'EMPLOYEE', storeId: storeA }),
    ]);
    await newStaff(manager, 'acc.staff2', storeB).expect(403);
    await newStaff(manager, 'acc.boss', storeA, 'STORE_MANAGER').expect(403);
    await manager
      .post(`/api/v1/businesses/${businessId}/users`)
      .send({
        username: 'acc.owner',
        displayName: 'Owner',
        initialPassword: 'first-password',
        roleKey: 'BUSINESS_OWNER',
        email: 'acc.owner@example.com',
      })
      .expect(403);
  });

  it('every new account needs an email and a username without spaces', async () => {
    await admin
      .post(`/api/v1/businesses/${businessId}/users`)
      .send({
        username: 'no.email',
        displayName: 'No Email',
        initialPassword: 'first-password',
        storeIds: [storeA],
      })
      .expect(400);
    await newStaff(admin, 'has space', storeA).expect(400);
  });

  it('a store manager deactivates and resets the password of their own staff only', async () => {
    const own = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const other = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeB] });
    const both = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA, storeB] });

    await manager
      .post(`/api/v1/users/${own.id}/password`)
      .send({ newPassword: 'manager-set-1' })
      .expect(204);
    await h.login(own.username, 'manager-set-1');
    await manager.post(`/api/v1/users/${own.id}/deactivate`).expect(204);
    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ username: own.username, password: 'manager-set-1' })
      .expect(401);
    await manager.post(`/api/v1/users/${own.id}/reactivate`).expect(204);

    await manager.post(`/api/v1/users/${other.id}/deactivate`).expect(403);
    // Someone also working at a store this manager does not run stays out of reach.
    await manager.post(`/api/v1/users/${both.id}/deactivate`).expect(403);
    await manager
      .post(`/api/v1/users/${other.id}/password`)
      .send({ newPassword: 'not-allowed-1' })
      .expect(403);
  });

  it('an admin changes roles; one person can manage several stores', async () => {
    const person = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const promoted = await admin
      .put(`/api/v1/businesses/${businessId}/users/${person.id}/role`)
      .send({ roleKey: 'STORE_MANAGER', storeIds: [storeA, storeB] })
      .expect(200);
    expect(promoted.body.roles.map((r: { storeId: string }) => r.storeId).sort()).toEqual(
      [storeA, storeB].sort(),
    );

    const removed = await admin
      .delete(`/api/v1/businesses/${businessId}/users/${person.id}/managed-stores/${storeB}`)
      .expect(200);
    expect(removed.body.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleKey: 'STORE_MANAGER', storeId: storeA }),
        expect.objectContaining({ roleKey: 'EMPLOYEE', storeId: storeB }),
      ]),
    );
    const owner = await admin
      .put(`/api/v1/businesses/${businessId}/users/${person.id}/role`)
      .send({ roleKey: 'BUSINESS_OWNER' })
      .expect(200);
    expect(owner.body.roles).toEqual([expect.objectContaining({ roleKey: 'BUSINESS_OWNER' })]);
    // A store manager cannot change roles at all.
    await manager
      .put(`/api/v1/businesses/${businessId}/users/${person.id}/role`)
      .send({ roleKey: 'EMPLOYEE', storeIds: [storeA] })
      .expect(403);
  });

  it('reset links work once and expire; without email the request says so', async () => {
    const person = await h.createUser({
      role: 'EMPLOYEE',
      businessId,
      storeIds: [storeA],
      email: 'reset.me@example.com',
    });
    const forgot = await h
      .http()
      .post('/api/v1/auth/password/forgot')
      .send({ identifier: person.username })
      .expect(200);
    expect(forgot.body).toEqual({ emailEnabled: false });
    expect(await h.prisma.passwordResetToken.count({ where: { userId: person.id } })).toBe(0);

    const token = 'x'.repeat(43);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await h.prisma.passwordResetToken.create({
      data: { userId: person.id, tokenHash, expiresAt: new Date(Date.now() + 60_000) },
    });
    await h
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'brand-new-pass' })
      .expect(204);
    await h.login(person.username, 'brand-new-pass');
    await h
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'again-new-pass' })
      .expect(400);

    const expired = 'y'.repeat(43);
    await h.prisma.passwordResetToken.create({
      data: {
        userId: person.id,
        tokenHash: createHash('sha256').update(expired).digest('hex'),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await h
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token: expired, newPassword: 'expired-pass-1' })
      .expect(400);
    await h.login(person.username, 'brand-new-pass');
    expect(PASSWORD).not.toBe('brand-new-pass');
  });

  it('stores business details and logos safely', async () => {
    await admin
      .patch(`/api/v1/businesses/${businessId}`)
      .send({ website: 'javascript:alert(1)' })
      .expect(400);
    const saved = await admin
      .patch(`/api/v1/businesses/${businessId}`)
      .send({
        address: { city: 'Lahore', region: 'Punjab', country: 'pk' },
        mapUrl: 'https://maps.google.com/?q=Lahore',
        socialLinks: { instagram: 'https://instagram.com/accounts.co' },
      })
      .expect(200);
    expect(saved.body.address).toEqual({ city: 'Lahore', region: 'Punjab', country: 'PK' });

    const png = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#c2410c' },
    })
      .png()
      .toBuffer();
    await admin
      .put(`/api/v1/stores/${storeA}/logo`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('not an image'))
      .expect(400);
    const store = await admin
      .put(`/api/v1/stores/${storeA}/logo`)
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(200);
    const logo = await h.http().get(store.body.logoUrl).expect(200);
    expect(logo.headers['content-type']).toBe('image/webp');
    const meta = await sharp(logo.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
    // Store managers cannot change the business profile.
    await manager.patch(`/api/v1/businesses/${businessId}`).send({ description: 'x' }).expect(403);
  });
});
