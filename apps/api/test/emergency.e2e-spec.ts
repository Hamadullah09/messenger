import type {
  CreateIncidentResponseDto,
  IncidentDetailDto,
  IncidentDto,
  IncidentListItemDto,
  Page,
} from '@storeline/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmergencyEscalationService } from '../src/modules/emergency/emergency-escalation.service';
import { collectEvents, Harness, nextEvent, uuid, type Session } from './harness';

const MANAGER_EMAIL = 'manager.private@example.com';
const MANAGER_PHONE = '+15555550123';
const ADMIN_EMAIL = 'admin.private@example.com';

async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 5000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > until) throw new Error(`Condition not met: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Emergency help', () => {
  let h: Harness;
  let escalation: EmergencyEscalationService;

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    escalation = h.worker!.get(EmergencyEscalationService);
  });
  afterAll(() => h.stop());

  /** A business with one store: a manager, a security guard, an admin and two employees. */
  async function tenant() {
    const businessId = (await h.createBusiness()).id;
    const storeId = (await h.createStore(businessId)).id;
    const otherStoreId = (await h.createStore(businessId)).id;
    const manager = await h.createUser({
      role: 'STORE_MANAGER',
      businessId,
      storeIds: [storeId],
      email: MANAGER_EMAIL.replace('@', `+${uuid().slice(0, 6)}@`),
      phone: MANAGER_PHONE,
    });
    const security = await h.createUser({ role: 'SECURITY', businessId, storeIds: [storeId] });
    const admin = await h.createUser({
      role: 'BUSINESS_ADMIN',
      businessId,
      email: ADMIN_EMAIL.replace('@', `+${uuid().slice(0, 6)}@`),
    });
    const employee = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const colleague = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    return { businessId, storeId, otherStoreId, manager, security, admin, employee, colleague };
  }

  const raise = (session: Session, body: Record<string, unknown> = {}) =>
    session.post('/api/v1/emergency/incidents').send({ clientIncidentId: uuid(), ...body });

  const recipientStates = (incidentId: string) =>
    h.prisma.emergencyIncidentRecipient.findMany({
      where: { incidentId },
      orderBy: { level: 'asc' },
      select: { userId: true, level: true, source: true, state: true },
    });

  /** Makes the current level's acknowledgement deadline lapse. */
  const expireDeadline = (incidentId: string) =>
    h.prisma.emergencyIncident.update({
      where: { id: incidentId },
      data: { ackDeadlineAt: new Date(Date.now() - 1000) },
    });

  it('alerts the store manager when no contacts are configured, without exposing contact details', async () => {
    const t = await tenant();
    const employee = await h.login(t.employee.username);
    const manager = await h.login(t.manager.username);
    const managerSocket = await h.socket(manager);
    const seen: string[] = [];
    managerSocket.onAny((_e, payload) => seen.push(JSON.stringify(payload)));
    const alert = nextEvent<IncidentDto>(managerSocket, 'emergency.alert_created');

    const res = await raise(employee, {
      category: 'MEDICAL',
      description: 'Customer collapsed',
    }).expect(201);
    const body = res.body as CreateIncidentResponseDto;
    seen.push(JSON.stringify(res.body));
    expect(body.existing).toBe(false);
    expect(body.incident).toMatchObject({
      status: 'OPEN',
      level: 1,
      maxLevel: 2, // store managers, then business admins
      category: 'MEDICAL',
      store: { id: t.storeId },
      reporter: { id: t.employee.id },
    });
    expect(body.incident.me).toMatchObject({
      isReporter: true,
      canCancel: true,
      canRespond: false,
    });

    const received = await alert;
    expect(received.id).toBe(body.incident.id);
    expect(received.recipients.map((r) => r.user.id)).toEqual([t.manager.id]);

    // Queued → sent to the gateway; never "delivered" until the device says so.
    const states = await waitFor(
      () => recipientStates(body.incident.id),
      (rows) => rows[0]?.state === 'SENT_TO_GATEWAY',
    );
    expect(states).toEqual([
      { userId: t.manager.id, level: 1, source: 'STORE_MANAGER', state: 'SENT_TO_GATEWAY' },
      { userId: t.admin.id, level: 2, source: 'BUSINESS_ADMIN', state: 'PENDING' },
    ]);

    // The manager is in the emergency conversation with full history; the admin is not yet.
    const detail = (
      await manager.get(`/api/v1/conversations/${body.incident.conversationId}`).expect(200)
    ).body;
    seen.push(JSON.stringify(detail));
    expect(detail.type).toBe('EMERGENCY');
    const messages = (
      await manager
        .get(`/api/v1/conversations/${body.incident.conversationId}/messages`)
        .expect(200)
    ).body;
    seen.push(JSON.stringify(messages));
    expect(messages.items.map((m: { kind: string }) => m.kind)).toEqual(['SYSTEM', 'TEXT']);
    const admin = await h.loginWithMfa(t.admin.username);
    await admin.get(`/api/v1/conversations/${body.incident.conversationId}`).expect(404);

    seen.push(
      JSON.stringify(
        (await manager.get(`/api/v1/emergency/incidents/${body.incident.id}`).expect(200)).body,
      ),
    );
    seen.push(JSON.stringify((await employee.get('/api/v1/emergency/incidents').expect(200)).body));
    const all = seen.join('\n');
    expect(all).not.toContain('manager.private');
    expect(all).not.toContain(MANAGER_PHONE);
    expect(all).not.toContain('admin.private');
    expect(all).not.toMatch(/"(email|phone)"/);
  });

  it('follows the configured contact order and validates settings', async () => {
    const t = await tenant();
    const admin = await h.loginWithMfa(t.admin.username);
    const url = `/api/v1/emergency/stores/${t.storeId}/settings`;

    // Contacts must be active members of the store.
    await admin
      .put(url)
      .send({ ackTimeoutSeconds: 60, contactUserIds: [t.admin.id] })
      .expect(400);
    const saved = await admin
      .put(url)
      .send({ ackTimeoutSeconds: 60, contactUserIds: [t.security.id, t.manager.id] })
      .expect(200);
    expect(saved.body).toMatchObject({
      ackTimeoutSeconds: 60,
      contacts: [
        { priority: 1, user: { id: t.security.id }, eligible: true },
        { priority: 2, user: { id: t.manager.id }, eligible: true },
      ],
      fallback: { storeManagers: 1, businessAdmins: 1 },
    });
    expect(JSON.stringify(saved.body)).not.toContain('private');

    // Employees cannot read or change the settings; other tenants cannot see the store.
    const employee = await h.login(t.employee.username);
    await employee.get(url).expect(403);
    const other = await tenant();
    const otherAdmin = await h.loginWithMfa(other.admin.username);
    await otherAdmin.get(url).expect(404);

    const res = await raise(employee).expect(201);
    const incident = (res.body as CreateIncidentResponseDto).incident;
    expect(incident.maxLevel).toBe(3);
    expect(incident.ackTimeoutSeconds).toBe(60);
    expect(await recipientStates(incident.id)).toMatchObject([
      { userId: t.security.id, level: 1, source: 'CONTACT' },
      { userId: t.manager.id, level: 2, source: 'CONTACT' },
      { userId: t.admin.id, level: 3, source: 'BUSINESS_ADMIN' },
    ]);
  });

  it('escalates when the deadline passes, idempotently, until the chain is exhausted', async () => {
    const t = await tenant();
    const employee = await h.login(t.employee.username);
    const admin = await h.loginWithMfa(t.admin.username);
    const adminSocket: Socket = await h.socket(admin);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;

    // Not due yet: nothing happens.
    expect(await escalation.escalate(incident.id, 1)).toBe(false);

    const alert = nextEvent<IncidentDto>(adminSocket, 'emergency.alert_created');
    await expireDeadline(incident.id);
    expect(await escalation.sweepOnce()).toBe(1);
    expect((await alert).level).toBe(2);
    // A duplicate or late job for the old level is a no-op.
    expect(await escalation.escalate(incident.id, 1, new Date(Date.now() + 3_600_000))).toBe(false);
    expect(await escalation.sweepOnce()).toBe(0);

    const escalated = (await admin.get(`/api/v1/emergency/incidents/${incident.id}`).expect(200))
      .body as IncidentDetailDto;
    expect(escalated).toMatchObject({ status: 'ESCALATED', level: 2 });
    expect(escalated.me).toMatchObject({ canRespond: true, isConversationMember: true });
    expect(escalated.events.map((e) => e.type)).toEqual([
      'CREATED',
      'NOTIFIED',
      'ESCALATED',
      'NOTIFIED',
    ]);
    // The admin now sees the whole conversation, including what was said before they joined.
    const messages = (
      await admin.get(`/api/v1/conversations/${incident.conversationId}/messages`).expect(200)
    ).body;
    expect(messages.items[0].systemEvent.type).toBe('emergency_raised');

    await expireDeadline(incident.id);
    expect(await escalation.sweepOnce()).toBe(1);
    const exhausted = await h.prisma.emergencyIncident.findUniqueOrThrow({
      where: { id: incident.id },
    });
    expect(exhausted).toMatchObject({ status: 'ESCALATED', level: 2, ackDeadlineAt: null });
    expect(exhausted.chainExhaustedAt).not.toBeNull();
    expect(await escalation.sweepOnce()).toBe(0);
    const audit = await h.prisma.auditLog.findMany({
      where: { targetId: incident.id },
      select: { action: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'emergency.incident.created',
      'emergency.incident.escalated',
      'emergency.incident.chain_exhausted',
    ]);
  });

  it('skips contacts who are no longer eligible, at creation and at escalation', async () => {
    const t = await tenant();
    const admin = await h.loginWithMfa(t.admin.username);
    await admin
      .put(`/api/v1/emergency/stores/${t.storeId}/settings`)
      .send({
        ackTimeoutSeconds: 30,
        contactUserIds: [t.colleague.id, t.manager.id, t.security.id],
      })
      .expect(200);
    await h.prisma.user.update({ where: { id: t.colleague.id }, data: { status: 'DEACTIVATED' } });

    const employee = await h.login(t.employee.username);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;
    expect((await recipientStates(incident.id)).map((r) => [r.userId, r.level])).toEqual([
      [t.manager.id, 1],
      [t.security.id, 2],
      [t.admin.id, 3],
    ]);

    // The backup leaves the store before the deadline: escalation goes straight to the admin.
    await h.prisma.storeMembership.updateMany({
      where: { userId: t.security.id, storeId: t.storeId },
      data: { status: 'REVOKED' },
    });
    await expireDeadline(incident.id);
    expect(await escalation.sweepOnce()).toBe(1);
    const rows = await recipientStates(incident.id);
    expect(rows.find((r) => r.userId === t.security.id)?.state).toBe('SKIPPED');
    expect(rows.find((r) => r.userId === t.admin.id)?.state).not.toBe('PENDING');
    const after = await h.prisma.emergencyIncident.findUniqueOrThrow({
      where: { id: incident.id },
    });
    expect(after.level).toBe(3);
  });

  it('lets exactly one responder acknowledge, and stops escalation', async () => {
    const t = await tenant();
    const second = await h.createUser({
      role: 'STORE_MANAGER',
      businessId: t.businessId,
      storeIds: [t.storeId],
    });
    const employee = await h.login(t.employee.username);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;
    const a = await h.login(t.manager.username);
    const b = await h.login(second.username);

    // The reporter cannot acknowledge their own alert.
    await employee.post(`/api/v1/emergency/incidents/${incident.id}/acknowledge`).expect(403);

    const [ra, rb] = await Promise.all([
      a.post(`/api/v1/emergency/incidents/${incident.id}/acknowledge`),
      b.post(`/api/v1/emergency/incidents/${incident.id}/acknowledge`),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(ra.body.acknowledgedBy.id).toBe(rb.body.acknowledgedBy.id);
    const events = await h.prisma.emergencyIncidentEvent.count({
      where: { incidentId: incident.id, type: 'ACKNOWLEDGED' },
    });
    expect(events).toBe(1);

    const row = await h.prisma.emergencyIncident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(row).toMatchObject({ status: 'ACKNOWLEDGED', ackDeadlineAt: null });
    await h.prisma.emergencyIncident.update({
      where: { id: incident.id },
      data: { ackDeadlineAt: new Date(Date.now() - 1000) },
    });
    expect(await escalation.sweepOnce()).toBe(0);

    // Too late to cancel once someone has responded.
    await employee.post(`/api/v1/emergency/incidents/${incident.id}/cancel`).expect(409);
  });

  it('keeps incidents private to the reporter, responders and the store team', async () => {
    const t = await tenant();
    const employee = await h.login(t.employee.username);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;
    const path = `/api/v1/emergency/incidents/${incident.id}`;

    // A colleague at the same store has no access; another tenant cannot see it exists.
    const colleague = await h.login(t.colleague.username);
    await colleague.get(path).expect(404);
    await colleague.post(`${path}/acknowledge`).expect(404);
    expect(
      (
        (await colleague.get('/api/v1/emergency/incidents').expect(200))
          .body as Page<IncidentListItemDto>
      ).items,
    ).toHaveLength(0);
    const other = await tenant();
    const outsider = await h.loginWithMfa(other.admin.username);
    await outsider.get(path).expect(404);
    await outsider.post(`${path}/resolve`).send({}).expect(404);

    // Security on shift (incident.read + incident.acknowledge) sees it and can join and resolve.
    const security = await h.login(t.security.username);
    const list = (await security.get('/api/v1/emergency/incidents?active=true').expect(200))
      .body as Page<IncidentListItemDto>;
    expect(list.items.map((i) => i.id)).toEqual([incident.id]);
    expect(list.items[0]!.me).toMatchObject({ canRespond: true, isConversationMember: false });
    const joined = (await security.post(`${path}/join`).expect(200)).body as IncidentDetailDto;
    expect(joined.me.isConversationMember).toBe(true);
    await security.get(`/api/v1/conversations/${incident.conversationId}`).expect(200);

    const resolved = (
      await security.post(`${path}/resolve`).send({ note: 'Paramedics on site' }).expect(200)
    ).body as IncidentDetailDto;
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Paramedics on site' });
    expect(resolved.resolvedBy?.id).toBe(t.security.id);
    await security.post(`${path}/acknowledge`).expect(409); // already closed
  });

  it('is idempotent, re-opens an active alert, and lets the reporter cancel', async () => {
    const t = await tenant();
    const employee = await h.login(t.employee.username);
    const key = uuid();
    const first = (await raise(employee, { clientIncidentId: key }).expect(201))
      .body as CreateIncidentResponseDto;
    const retry = (await raise(employee, { clientIncidentId: key }).expect(201))
      .body as CreateIncidentResponseDto;
    expect(retry.incident.id).toBe(first.incident.id);

    const again = (await raise(employee, { description: 'Still here, back door' }).expect(201))
      .body as CreateIncidentResponseDto;
    expect(again).toMatchObject({ existing: true, incident: { id: first.incident.id } });
    const messages = (
      await employee
        .get(`/api/v1/conversations/${first.incident.conversationId}/messages`)
        .expect(200)
    ).body;
    expect(messages.items.map((m: { body: string | null }) => m.body)).toContain(
      'Still here, back door',
    );
    expect(await h.prisma.emergencyIncident.count({ where: { reporterId: t.employee.id } })).toBe(
      1,
    );

    const colleague = await h.login(t.manager.username);
    await colleague.post(`/api/v1/emergency/incidents/${first.incident.id}/cancel`).expect(403);
    const cancelled = (
      await employee.post(`/api/v1/emergency/incidents/${first.incident.id}/cancel`).expect(200)
    ).body as IncidentDetailDto;
    expect(cancelled.status).toBe('CANCELLED');
    expect(await escalation.sweepOnce()).toBe(0);

    // After closing, a new press raises a new alert.
    const next = (await raise(employee).expect(201)).body as CreateIncidentResponseDto;
    expect(next.incident.id).not.toBe(first.incident.id);
  });

  it('resolves the store from the caller memberships', async () => {
    const t = await tenant();
    const roamer = await h.createUser({
      role: 'EMPLOYEE',
      businessId: t.businessId,
      storeIds: [t.storeId, t.otherStoreId],
    });
    const session = await h.login(roamer.username);
    const stores = (await session.get('/api/v1/emergency/stores').expect(200)).body;
    expect(stores).toHaveLength(2);

    const ambiguous = await raise(session).expect(400);
    expect(ambiguous.body.error.details[0].path).toBe('storeId');
    const other = await tenant();
    await raise(session, { storeId: other.storeId }).expect(404);
    // No manager or contact at the other store: business admins are alerted directly.
    const res = await raise(session, { storeId: t.otherStoreId }).expect(201);
    expect(res.body.incident.recipients.map((r: { user: { id: string } }) => r.user.id)).toEqual([
      t.admin.id,
    ]);

    // Business admins with no store have no store context.
    const admin = await h.loginWithMfa(t.admin.username);
    await raise(admin).expect(409);
  });

  it('refuses with a clear message when nobody can be alerted', async () => {
    const businessId = (await h.createBusiness()).id;
    const storeId = (await h.createStore(businessId)).id;
    const lonely = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    const session = await h.login(lonely.username);
    const res = await raise(session).expect(409);
    expect(res.body.error.message).toMatch(/emergency number/);
    expect(await h.prisma.emergencyIncident.count({ where: { businessId } })).toBe(0);
    expect(await h.prisma.conversation.count({ where: { businessId } })).toBe(0);
  });

  it('tracks device receipts monotonically and notifies the reporter', async () => {
    const t = await tenant();
    const employee = await h.login(t.employee.username);
    const reporterSocket = await h.socket(employee);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;
    await waitFor(
      () => recipientStates(incident.id),
      (rows) => rows[0]?.state === 'SENT_TO_GATEWAY',
    );

    const manager = await h.login(t.manager.username);
    const path = `/api/v1/emergency/incidents/${incident.id}/receipt`;
    const seenUpdate = nextEvent<IncidentDto>(
      reporterSocket,
      'emergency.incident_updated',
      5000,
      (i) => i.recipients[0]?.state === 'READ',
    );
    await manager.post(path).send({ state: 'DELIVERED' }).expect(204);
    expect((await recipientStates(incident.id))[0]!.state).toBe('DELIVERED_TO_DEVICE');
    await manager.post(path).send({ state: 'READ' }).expect(204);
    await manager.post(path).send({ state: 'DELIVERED' }).expect(204); // never moves backwards
    expect((await recipientStates(incident.id))[0]!.state).toBe('READ');
    expect((await seenUpdate).recipients[0]!.readAt).not.toBeNull();

    // Someone who was never alerted cannot create receipts.
    const colleague = await h.login(t.colleague.username);
    await colleague.post(path).send({ state: 'READ' }).expect(204);
    expect(
      await h.prisma.emergencyIncidentRecipient.count({
        where: { incidentId: incident.id, userId: t.colleague.id },
      }),
    ).toBe(0);
  });

  it('sends live updates to store watchers but alerts only the chain', async () => {
    const t = await tenant();
    const security = await h.login(t.security.username);
    const securitySocket = await h.socket(security);
    const alerts = collectEvents(securitySocket, 'emergency.alert_created', 1500);
    const update = nextEvent<IncidentDto>(securitySocket, 'emergency.incident_updated');
    const colleague = await h.login(t.colleague.username);
    const colleagueSocket = await h.socket(colleague);
    const colleagueEvents = collectEvents(colleagueSocket, 'emergency.incident_updated', 1500);

    const employee = await h.login(t.employee.username);
    const incident = ((await raise(employee).expect(201)).body as CreateIncidentResponseDto)
      .incident;
    expect((await update).id).toBe(incident.id);
    expect(await alerts).toHaveLength(0);
    expect(await colleagueEvents).toHaveLength(0);
  });
});
