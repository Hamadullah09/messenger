import type { Prisma, PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES, type SystemRoleKey } from '@storeline/shared';

/** Upserts the system roles and their permission sets from the shared catalog (idempotent). */
export async function syncSystemRoles(
  client: PrismaClient | Prisma.TransactionClient,
): Promise<Record<SystemRoleKey, string>> {
  const ids = {} as Record<SystemRoleKey, string>;
  for (const role of Object.values(SYSTEM_ROLES)) {
    const existing = await client.role.findFirst({
      where: { key: role.key, businessId: null },
      select: { id: true },
    });
    const row = existing
      ? await client.role.update({
          where: { id: existing.id },
          data: {
            name: role.name,
            description: role.description,
            allowedScopes: [...role.allowedScopes],
            isSystem: true,
          },
          select: { id: true },
        })
      : await client.role.create({
          data: {
            key: role.key,
            name: role.name,
            description: role.description,
            allowedScopes: [...role.allowedScopes],
            isSystem: true,
          },
          select: { id: true },
        });
    await client.rolePermission.deleteMany({ where: { roleId: row.id } });
    await client.rolePermission.createMany({
      data: role.permissions.map((permission) => ({ roleId: row.id, permission })),
    });
    ids[role.key] = row.id;
  }
  return ids;
}
