import type { Prisma } from '@prisma/client';
import type { PublicUserDto } from '@storeline/shared';

/**
 * The ONLY selection used to expose users outside privileged endpoints. It deliberately
 * omits credentials, MFA state and the separate UserContact relation (ADR-0006).
 */
export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  kind: true,
  status: true,
} as const satisfies Prisma.UserSelect;

export type PublicUserRow = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export function toPublicUser(row: PublicUserRow): PublicUserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    kind: row.kind,
    status: row.status,
  };
}
