import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  SMA_PLAN_KEYS,
  SMA_PLANS,
  TRIAL_DAYS,
  type BusinessBillingDto,
  type SetBusinessPlanRequest,
  type SmaPlanDefinition,
  type SmaPlanKey,
  type SmaPlanOptionDto,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { CrmSettingsService, dateOnly, isoDate, num, round2, today } from './crm-core';
import { SalesService } from './sales.service';

const GB = 1024 ** 3;
const MEDIA_IN_USE = ['PENDING_UPLOAD', 'VERIFYING', 'READY'] as const;

/** The quota values for a plan (messages per minute stays as configured). */
export function quotaFor(plan: SmaPlanDefinition): Prisma.TenantQuotaUpdateInput {
  return {
    maxStores: plan.limits.maxStores,
    maxUsers: plan.limits.maxUsers,
    maxStorageBytes: BigInt(plan.limits.maxStorageGb) * BigInt(GB),
    maxCampaignSize: plan.limits.maxCampaignSize,
  };
}

/** Starts a new business on the free trial (called when the business is created). */
export async function startTrial(tx: Tx, businessId: string, days = TRIAL_DAYS): Promise<void> {
  const trial = SMA_PLANS.TRIAL;
  await tx.businessPlan.create({
    data: {
      businessId,
      plan: 'TRIAL',
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + days * 86_400_000),
    },
  });
  await tx.tenantQuota.update({ where: { businessId }, data: quotaFor(trial) });
}

/**
 * What businesses pay SMA: plans set the business's limits and, when billed automatically, a
 * monthly subscription in SMA's own CRM (invoices, reminders and pay links come from there).
 * Only the platform (Super Admin) changes plans; business owners and admins see theirs.
 */
@Injectable()
export class SmaBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly settings: CrmSettingsService,
    private readonly audit: AuditService,
  ) {}

  private async smaTenant(): Promise<string> {
    return (await this.sales.team()).businessId;
  }

  /** Plans with today's prices from SMA's Services catalog. */
  async options(actor: Actor): Promise<SmaPlanOptionDto[]> {
    await this.authz.require(actor, 'business.create', null);
    const tenantId = await this.smaTenant();
    const services = await this.prisma.crmService.findMany({
      where: {
        tenantId,
        name: {
          in: SMA_PLAN_KEYS.map((k) => SMA_PLANS[k].serviceName).filter((n): n is string => !!n),
        },
      },
    });
    return SMA_PLAN_KEYS.map((key) => {
      const def = SMA_PLANS[key];
      const svc = services.find((s) => s.name === def.serviceName);
      return {
        key,
        name: def.name,
        summary: def.summary,
        price: svc ? num(svc.price) : def.defaultPrice,
        currency: svc?.currency ?? 'USD',
        perStore: def.perStore,
        limits: def.limits,
      };
    });
  }

  /** The catalog item that prices a plan (created with the default price if missing). */
  private async planService(tx: Tx, tenantId: string, def: SmaPlanDefinition) {
    const existing = await tx.crmService.findFirst({ where: { tenantId, name: def.serviceName! } });
    if (existing) return existing;
    return tx.crmService.create({
      data: {
        tenantId,
        name: def.serviceName!,
        category: 'Plans',
        price: def.defaultPrice,
        currency: 'USD',
        billing: 'MONTHLY',
        description: def.summary,
      },
    });
  }

  private activeStores(businessId: string, tx: Tx | PrismaService = this.prisma) {
    return tx.store.count({ where: { businessId, status: 'ACTIVE' } });
  }

  async setPlan(
    actor: Actor,
    businessId: string,
    request: SetBusinessPlanRequest,
  ): Promise<BusinessBillingDto> {
    await this.authz.require(actor, 'business.create', null);
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, deletedAt: null, internal: false },
      select: { id: true, name: true, email: true },
    });
    if (!business) throw ApiError.notFound('Business');
    const def = SMA_PLANS[request.plan];
    const tenantId = await this.smaTenant();
    const settings = await this.settings.load(tenantId);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.businessPlan.findUnique({ where: { businessId } });
      await tx.tenantQuota.update({ where: { businessId }, data: quotaFor(def) });
      let subscriptionId = current?.subscriptionId ?? null;
      const stopBilling = async () => {
        if (subscriptionId)
          await tx.subscription.update({
            where: { id: subscriptionId },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          });
        subscriptionId = null;
      };
      if (request.plan === 'TRIAL') {
        await stopBilling();
      } else if (request.autoBill) {
        const svc = await this.planService(tx, tenantId, def);
        const quantity = def.perStore ? Math.max(1, await this.activeStores(businessId, tx)) : 1;
        const item = {
          serviceId: svc.id,
          name: svc.name,
          quantity,
          unitPrice: svc.price,
          position: 0,
        };
        const start = dateOnly(request.startDate ?? new Date());
        if (start < today())
          throw ApiError.validation('The first invoice date cannot be in the past.', 'startDate');
        if (subscriptionId) {
          await tx.subscriptionItem.deleteMany({ where: { subscriptionId } });
          await tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              name: `${def.name} — ${business.name}`,
              currency: svc.currency,
              status: 'ACTIVE',
              cancelledAt: null,
              items: { create: [item] },
            },
          });
        } else {
          subscriptionId = (
            await tx.subscription.create({
              data: {
                tenantId,
                businessId,
                name: `${def.name} — ${business.name}`,
                currency: svc.currency,
                interval: 'MONTHLY',
                nextInvoiceAt: start,
                dueDays: 14,
                taxRate: settings.taxRate,
                autoEmail: true,
                createdById: actor.userId,
                items: { create: [item] },
              },
              select: { id: true },
            })
          ).id;
        }
      } else {
        await stopBilling();
      }
      const data = {
        plan: request.plan,
        status: request.plan === 'TRIAL' ? ('TRIAL' as const) : ('ACTIVE' as const),
        trialEndsAt:
          request.plan === 'TRIAL'
            ? new Date(Date.now() + (request.trialDays ?? TRIAL_DAYS) * 86_400_000)
            : null,
        subscriptionId,
        updatedById: actor.userId,
      };
      await tx.businessPlan.upsert({
        where: { businessId },
        create: { businessId, ...data },
        update: data,
      });
      await this.audit.record(
        actor,
        {
          action: 'business.plan_changed',
          businessId,
          targetType: 'Business',
          targetId: businessId,
          metadata: { plan: request.plan, autoBill: request.autoBill },
        },
        tx,
      );
    });
    return this.billing(actor, businessId);
  }

  /** The business's plan, limits, usage and SMA invoices. */
  async billing(actor: Actor, businessId: string): Promise<BusinessBillingDto> {
    // Outsiders get "not found", as for every other business resource.
    if (!(await this.authz.can(actor, 'business.read', { businessId })))
      throw ApiError.notFound('Business');
    const tenantId = await this.smaTenant();
    const [plan, stores, users, storage, invoices, canChangePlan] = await Promise.all([
      this.prisma.businessPlan.findUnique({
        where: { businessId },
        include: { business: { select: { internal: true } } },
      }),
      this.activeStores(businessId),
      this.prisma.businessMembership.count({ where: { businessId, status: 'ACTIVE' } }),
      this.prisma.mediaAsset.aggregate({
        where: { businessId, status: { in: [...MEDIA_IN_USE] } },
        _sum: { sizeBytes: true },
      }),
      this.prisma.invoice.findMany({
        where: { tenantId, businessId, status: { notIn: ['DRAFT', 'VOID'] } },
        orderBy: { issueDate: 'desc' },
        take: 24,
        select: {
          id: true,
          number: true,
          status: true,
          total: true,
          amountPaid: true,
          currency: true,
          issueDate: true,
          dueDate: true,
          payToken: true,
        },
      }),
      this.authz.can(actor, 'business.create', null),
    ]);
    if (!plan || plan.business.internal) throw ApiError.notFound('Plan');
    const def = SMA_PLANS[plan.plan as SmaPlanKey];
    const sub = plan.subscriptionId
      ? await this.prisma.subscription.findUnique({
          where: { id: plan.subscriptionId },
          select: {
            status: true,
            nextInvoiceAt: true,
            currency: true,
            items: { select: { quantity: true, unitPrice: true } },
          },
        })
      : null;
    const live = sub && sub.status === 'ACTIVE' ? sub : null;
    const todayIso = isoDate(today());
    return {
      businessId,
      plan: plan.plan as SmaPlanKey,
      planName: def.name,
      status: plan.status,
      trialEndsAt: plan.trialEndsAt?.toISOString() ?? null,
      monthlyAmount: live
        ? round2(
            live.items.reduce(
              (s, i) => s + num(i.unitPrice) * (def.perStore ? Math.max(1, stores) : i.quantity),
              0,
            ),
          )
        : null,
      currency: live?.currency ?? 'USD',
      autoBilled: !!live,
      nextInvoiceAt: live ? isoDate(live.nextInvoiceAt) : null,
      limits: def.limits,
      usage: { stores, users, storageGb: round2(Number(storage._sum.sizeBytes ?? 0n) / GB) },
      invoices: invoices.map((i) => {
        const balance = round2(num(i.total) - num(i.amountPaid));
        return {
          id: i.id,
          number: i.number,
          status: i.status,
          total: num(i.total),
          balance,
          currency: i.currency,
          issueDate: isoDate(i.issueDate),
          dueDate: isoDate(i.dueDate),
          overdue: balance > 0 && isoDate(i.dueDate) < todayIso,
          payUrl: i.payToken && i.status !== 'PAID' ? `/pay/${i.payToken}` : null,
        };
      }),
      canChangePlan,
    };
  }
}
