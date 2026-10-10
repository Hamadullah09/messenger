/**
 * Synchronises the built-in system roles and their permissions with the catalog in
 * @storeline/shared. Idempotent. Run on every deployment after `prisma migrate deploy`
 * (production has no seed): `node dist/cli/sync-roles.js` (image) or `npm run db:sync-roles`.
 */
import '../load-env';
import { PrismaClient } from '@prisma/client';
import { syncSystemRoles } from '../modules/authorization/system-roles';

const prisma = new PrismaClient();

syncSystemRoles(prisma)
  .then((roles) => console.log(`✔ ${Object.keys(roles).length} system roles synchronised`))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
