/**
 * Creates the first Super Admin on a new installation (production has no seed).
 *
 *   docker compose -f compose.prod.yaml run --rm -e ADMIN_PASSWORD -e ADMIN_EMAIL api \
 *     node dist/cli/create-super-admin.js <username> "<Display name>"
 *
 * The password comes from ADMIN_PASSWORD (never a command-line argument, which shells keep in
 * their history); they must change it at first sign-in, and two-step login is required before
 * any administrative action. Refuses to run when a Super Admin already exists.
 */
import '../load-env';
import { PrismaClient } from '@prisma/client';
import { PASSWORD_MIN_LENGTH } from '@storeline/shared';
import { PasswordService } from '../modules/auth/password.service';
import { syncSystemRoles } from '../modules/authorization/system-roles';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [username, displayName] = process.argv.slice(2);
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!username || !displayName || !/^[a-z0-9._-]{3,32}$/.test(username))
    throw new Error(
      'Usage: create-super-admin <username (a-z 0-9 . _ -)> "<Display name>" (ADMIN_PASSWORD in the environment)',
    );
  if (password.length < Math.max(PASSWORD_MIN_LENGTH, 12))
    throw new Error('Set ADMIN_PASSWORD (at least 12 characters) in the environment.');
  const roles = await syncSystemRoles(prisma);
  const existing = await prisma.roleAssignment.count({
    where: { roleId: roles.SUPER_ADMIN, revokedAt: null, user: { deletedAt: null } },
  });
  if (existing > 0) throw new Error('A Super Admin already exists. Add more admins in the app.');
  const passwordHash = await new PasswordService().hash(password);
  const email = process.env.ADMIN_EMAIL?.trim();
  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      mustChangePassword: true,
      ...(email ? { contact: { create: { email } } } : {}),
    },
    select: { id: true },
  });
  await prisma.roleAssignment.create({
    data: { userId: user.id, roleId: roles.SUPER_ADMIN, scopeType: 'PLATFORM' },
  });
  console.log(
    `✔ Super Admin "${username}" created. Sign in, choose a new password and set up two-step login.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
