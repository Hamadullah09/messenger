/**
 * Gives demo accounts their own passwords and email addresses (development / demos only).
 *
 *   npm run accounts:apply -w @storeline/api
 *
 * Reads apps/api/demo-accounts.local.json (git-ignored: it holds real passwords; see
 * demo-accounts.example.json). For each listed username it sets the password (no forced
 * change at next sign-in), binds the email address and clears any lockout. Optional:
 * renames usernames first, creates demo businesses (stores + their own admin) and turns
 * two-step verification off for every account.
 * Passwords are never printed.
 */
import '../src/load-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_BUSINESS_POLICY,
  emailSchema,
  passwordSchema,
  slugSchema,
  usernameSchema,
} from '@storeline/shared';
import { z } from 'zod';
import { PasswordService } from '../src/modules/auth/password.service';
import { syncSystemRoles } from '../src/modules/authorization/system-roles';

const fileSchema = z.object({
  /** { "oldUsername": "newUsername" } */
  renames: z.record(usernameSchema, usernameSchema).default({}),
  accounts: z
    .array(z.object({ username: usernameSchema, email: emailSchema, password: passwordSchema }))
    .default([]),
  /** Businesses to create if missing, each with its stores and its own admin. */
  businesses: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        slug: slugSchema,
        timeZone: z.string().default('Asia/Karachi'),
        stores: z.array(
          z.object({
            name: z.string().min(2),
            code: z.string().min(1).max(16),
            city: z.string().optional(),
          }),
        ),
        admin: z.object({
          username: usernameSchema,
          displayName: z.string().min(1).max(80),
          email: emailSchema,
          password: passwordSchema,
        }),
      }),
    )
    .default([]),
  /** Turn two-step verification off for every account (they can turn it on again). */
  resetAllTwoStep: z.boolean().default(false),
});

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const path = join(__dirname, '..', 'demo-accounts.local.json');
  const config = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const passwords = new PasswordService();
  const roles = await syncSystemRoles(prisma);

  for (const b of config.businesses) {
    if (await prisma.business.findUnique({ where: { slug: b.slug }, select: { id: true } })) {
      console.log(`• ${b.name} already exists`);
      continue;
    }
    if (
      await prisma.user.findUnique({ where: { username: b.admin.username }, select: { id: true } })
    ) {
      console.warn(`! username ${b.admin.username} is taken, ${b.name} skipped`);
      continue;
    }
    const passwordHash = await passwords.hash(b.admin.password);
    await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: b.name,
          slug: b.slug,
          timeZone: b.timeZone,
          policy: DEFAULT_BUSINESS_POLICY,
          address: { country: 'PK' },
          quota: { create: {} },
        },
        select: { id: true },
      });
      for (const store of b.stores) {
        await tx.store.create({
          data: {
            businessId: business.id,
            name: store.name,
            code: store.code.toUpperCase(),
            ...(store.city ? { address: { city: store.city, country: 'PK' } } : {}),
          },
        });
      }
      const admin = await tx.user.create({
        data: {
          username: b.admin.username,
          displayName: b.admin.displayName,
          passwordHash,
          contact: { create: { email: b.admin.email, emailVerifiedAt: new Date() } },
        },
        select: { id: true },
      });
      await tx.businessMembership.create({ data: { businessId: business.id, userId: admin.id } });
      await tx.roleAssignment.create({
        data: {
          userId: admin.id,
          roleId: roles.BUSINESS_ADMIN,
          scopeType: 'BUSINESS',
          businessId: business.id,
        },
      });
    });
    console.log(`✔ created ${b.name} with ${b.stores.length} stores and admin ${b.admin.username}`);
  }

  for (const [from, to] of Object.entries(config.renames)) {
    const [old, taken] = await Promise.all([
      prisma.user.findUnique({ where: { username: from }, select: { id: true } }),
      prisma.user.findUnique({ where: { username: to }, select: { id: true } }),
    ]);
    if (old && !taken) {
      await prisma.user.update({ where: { id: old.id }, data: { username: to } });
      console.log(`✔ renamed ${from} → ${to}`);
    } else if (!taken) {
      console.warn(`! ${from} not found, not renamed`);
    }
  }

  for (const account of config.accounts) {
    const user = await prisma.user.findUnique({
      where: { username: account.username },
      select: { id: true },
    });
    if (!user) {
      console.warn(`! ${account.username} not found, skipped`);
      continue;
    }
    const owner = await prisma.userContact.findUnique({
      where: { email: account.email },
      select: { userId: true },
    });
    if (owner && owner.userId !== user.id) {
      console.warn(`! the email for ${account.username} belongs to another account, skipped`);
      continue;
    }
    const passwordHash = await passwords.hash(account.password);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      prisma.userContact.upsert({
        where: { userId: user.id },
        create: { userId: user.id, email: account.email, emailVerifiedAt: new Date() },
        update: { email: account.email, emailVerifiedAt: new Date() },
      }),
    ]);
    console.log(`✔ ${account.username}: password and email set`);
  }

  if (config.resetAllTwoStep) {
    const { count } = await prisma.user.updateMany({
      where: { OR: [{ mfaEnabledAt: { not: null } }, { mfaPendingSecretEnc: { not: null } }] },
      data: {
        mfaSecretEnc: null,
        mfaPendingSecretEnc: null,
        mfaEnabledAt: null,
        mfaLastUsedStep: null,
      },
    });
    console.log(`✔ two-step verification turned off for ${count} account(s)`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof z.ZodError ? z.prettifyError(error) : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
