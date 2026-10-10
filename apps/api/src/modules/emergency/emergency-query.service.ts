import { Injectable } from '@nestjs/common';
import type { ResponderSource } from '@storeline/shared';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { incidentInclude, toIncidentDto, type IncidentRow } from './emergency.mapper';

export interface ChainLevel {
  level: number;
  source: ResponderSource;
  userIds: string[];
}

export interface StoreRef {
  businessId: string;
  storeId: string;
}

/** Most levels an incident can have: five contacts plus the business-admin fallback. */
const MAX_LEVELS = 6;

/**
 * Read-side helpers shared by the API and the worker: escalation-chain resolution, responder
 * eligibility, and the audience for incident events. Works only with user ids and public
 * profiles; private contact data is never read here.
 */
@Injectable()
export class EmergencyQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async incident(id: string, tx?: Tx): Promise<IncidentRow | null> {
    return (tx ?? this.prisma).emergencyIncident.findUnique({
      where: { id },
      include: incidentInclude,
    });
  }

  async incidentDto(id: string, tx?: Tx) {
    const row = await this.incident(id, tx);
    return row ? toIncidentDto(row) : null;
  }

  /**
   * The escalation chain, snapshotted when the incident is raised (docs/architecture/emergency.md):
   * configured contacts in priority order (one level each), or, when none is eligible, the
   * store's managers; business admins are always the final level. The reporter is never
   * alerted about their own incident.
   */
  async buildChain(tx: Tx, store: StoreRef, reporterId: string): Promise<ChainLevel[]> {
    const levels: ChainLevel[] = [];
    const used = new Set<string>([reporterId]);
    const push = (source: ResponderSource, userIds: string[]) => {
      const fresh = [...new Set(userIds)].filter((id) => !used.has(id));
      if (fresh.length === 0 || levels.length >= MAX_LEVELS) return;
      fresh.forEach((id) => used.add(id));
      levels.push({ level: levels.length + 1, source, userIds: fresh });
    };

    const contacts = await tx.emergencyContact.findMany({
      where: { storeId: store.storeId, businessId: store.businessId },
      orderBy: { priority: 'asc' },
      select: { userId: true },
    });
    const eligibleContacts = await this.eligibleAtStore(
      tx,
      store,
      contacts.map((c) => c.userId),
    );
    for (const { userId } of contacts) {
      if (eligibleContacts.has(userId)) push('CONTACT', [userId]);
    }
    if (levels.length === 0) {
      const managers = await tx.roleAssignment.findMany({
        where: {
          revokedAt: null,
          scopeType: 'STORE',
          businessId: store.businessId,
          storeId: store.storeId,
          role: { key: 'STORE_MANAGER', isSystem: true },
        },
        select: { userId: true },
      });
      const eligible = await this.eligibleAtStore(
        tx,
        store,
        managers.map((m) => m.userId),
      );
      push(
        'STORE_MANAGER',
        managers.map((m) => m.userId).filter((id) => eligible.has(id)),
      );
    }
    push('BUSINESS_ADMIN', await this.businessAdmins(tx, store.businessId));
    return levels;
  }

  async businessAdmins(tx: Tx, businessId: string): Promise<string[]> {
    const admins = await tx.roleAssignment.findMany({
      where: {
        revokedAt: null,
        scopeType: 'BUSINESS',
        businessId,
        role: { key: 'BUSINESS_ADMIN', isSystem: true },
        user: {
          status: 'ACTIVE',
          kind: 'INTERNAL',
          businessMemberships: { some: { businessId, status: 'ACTIVE' } },
        },
      },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    return [...new Set(admins.map((a) => a.userId))];
  }

  /** Users who can still be alerted for this store: active, internal, active store member. */
  async eligibleAtStore(tx: Tx, store: StoreRef, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tx.user.findMany({
      where: {
        id: { in: userIds },
        status: 'ACTIVE',
        kind: 'INTERNAL',
        businessMemberships: { some: { businessId: store.businessId, status: 'ACTIVE' } },
        storeMemberships: { some: { storeId: store.storeId, status: 'ACTIVE' } },
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Re-checked at escalation time: people may have been deactivated or moved since. */
  async stillEligible(
    tx: Tx,
    store: StoreRef,
    recipients: Array<{ userId: string; source: ResponderSource }>,
  ): Promise<Set<string>> {
    const admins = new Set(await this.businessAdmins(tx, store.businessId));
    const storeLevel = await this.eligibleAtStore(
      tx,
      store,
      recipients.filter((r) => r.source !== 'BUSINESS_ADMIN').map((r) => r.userId),
    );
    return new Set(
      recipients
        .filter((r) =>
          r.source === 'BUSINESS_ADMIN' ? admins.has(r.userId) : storeLevel.has(r.userId),
        )
        .map((r) => r.userId),
    );
  }

  /** Internal users holding incident.read for the store (store or business scope). */
  async watchers(store: StoreRef): Promise<string[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        revokedAt: null,
        role: { permissions: { some: { permission: 'incident.read' } } },
        OR: [
          { scopeType: 'BUSINESS', businessId: store.businessId },
          { scopeType: 'STORE', businessId: store.businessId, storeId: store.storeId },
        ],
        user: {
          status: 'ACTIVE',
          kind: 'INTERNAL',
          businessMemberships: { some: { businessId: store.businessId, status: 'ACTIVE' } },
        },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  /** Who receives emergency.incident_updated: reporter, everyone alerted, and store watchers. */
  async audience(incident: {
    id: string;
    businessId: string;
    storeId: string;
    reporterId: string;
  }): Promise<string[]> {
    const [alerted, watchers] = await Promise.all([
      this.prisma.emergencyIncidentRecipient.findMany({
        where: { incidentId: incident.id, state: { notIn: ['PENDING', 'SKIPPED'] } },
        select: { userId: true },
      }),
      this.watchers(incident),
    ]);
    return [...new Set([incident.reporterId, ...alerted.map((r) => r.userId), ...watchers])];
  }
}
