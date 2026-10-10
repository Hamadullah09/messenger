import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import {
  REALTIME_NAMESPACE,
  SYSTEM_ROLES,
  type LoginResponseDto,
  type SystemRoleKey,
} from '@storeline/shared';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { syncSystemRoles } from '../src/modules/authorization/system-roles';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { MfaService } from '../src/modules/auth/mfa.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { WorkerModule } from '../src/worker.module';

export const PASSWORD = 'correct-horse-battery-staple';

/** Integration-test harness: real PostgreSQL, Redis, HTTP server, Socket.IO and (optionally) the worker. */
export class Harness {
  app!: NestExpressApplication;
  worker: INestApplicationContext | null = null;
  readonly prisma = new PrismaClient();
  baseUrl = '';
  roles!: Record<SystemRoleKey, string>;
  private passwordHash = '';
  private sockets: Socket[] = [];

  static async start(options: { worker?: boolean } = {}): Promise<Harness> {
    const harness = new Harness();
    await harness.reset();
    harness.app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger: false,
    });
    configureApp(harness.app);
    await harness.app.listen(0, '127.0.0.1');
    const address = harness.app.getHttpServer().address() as AddressInfo;
    harness.baseUrl = `http://127.0.0.1:${address.port}`;
    if (options.worker) {
      harness.worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
      await harness.worker.init();
    }
    return harness;
  }

  async stop(): Promise<void> {
    this.sockets.forEach((s) => s.disconnect());
    await this.worker?.close();
    await this.app?.close();
    await this.prisma.$disconnect();
  }

  /** Empties every table and the test Redis DB (rate limits, presence, queues). */
  async reset(): Promise<void> {
    const tables = await this.prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await this.prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    const redis = new Redis(process.env.REDIS_URL!);
    await redis.flushdb();
    await redis.quit();
    this.roles = await syncSystemRoles(this.prisma);
    this.passwordHash = await new PasswordService().hash(PASSWORD);
  }

  async clearRateLimits(pattern = 'rl:*'): Promise<void> {
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }

  http(): ReturnType<typeof request> {
    return request(this.app.getHttpServer());
  }

  get mfa(): MfaService {
    return this.app.get(MfaService);
  }

  // ─────────────── fixtures (direct DB writes for speed) ───────────────

  async createBusiness(
    name = `Biz ${randomUUID().slice(0, 6)}`,
  ): Promise<{ id: string; slug: string }> {
    return this.prisma.business.create({
      data: { name, slug: `b-${randomUUID().slice(0, 8)}`, policy: {}, quota: { create: {} } },
      select: { id: true, slug: true },
    });
  }

  async createStore(
    businessId: string,
    code = randomUUID().slice(0, 6).toUpperCase(),
  ): Promise<{ id: string }> {
    return this.prisma.store.create({
      data: { businessId, code, name: `Store ${code}` },
      select: { id: true },
    });
  }

  async createUser(options: {
    username?: string;
    role: SystemRoleKey;
    businessId?: string;
    storeIds?: string[];
    kind?: 'INTERNAL' | 'EXTERNAL';
    email?: string;
    phone?: string;
  }): Promise<{ id: string; username: string }> {
    const username = options.username ?? `u.${randomUUID().slice(0, 8)}`;
    const user = await this.prisma.user.create({
      data: {
        username,
        displayName: username.replace(/[._]/g, ' '),
        kind: options.kind ?? (options.role === 'CUSTOMER' ? 'EXTERNAL' : 'INTERNAL'),
        passwordHash: this.passwordHash,
        ...(options.email || options.phone
          ? { contact: { create: { email: options.email ?? null, phone: options.phone ?? null } } }
          : {}),
      },
      select: { id: true, username: true },
    });
    const role = SYSTEM_ROLES[options.role];
    if (role.allowedScopes.includes('PLATFORM')) {
      await this.prisma.roleAssignment.create({
        data: { userId: user.id, roleId: this.roles[options.role], scopeType: 'PLATFORM' },
      });
      return user;
    }
    const businessId = options.businessId!;
    await this.prisma.businessMembership.create({ data: { businessId, userId: user.id } });
    for (const storeId of options.storeIds ?? []) {
      await this.prisma.storeMembership.create({ data: { businessId, storeId, userId: user.id } });
    }
    if (role.allowedScopes.includes('STORE')) {
      for (const storeId of options.storeIds ?? []) {
        await this.prisma.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: this.roles[options.role],
            scopeType: 'STORE',
            businessId,
            storeId,
          },
        });
      }
    } else {
      await this.prisma.roleAssignment.create({
        data: {
          userId: user.id,
          roleId: this.roles[options.role],
          scopeType: 'BUSINESS',
          businessId,
        },
      });
    }
    return user;
  }

  // ─────────────── auth helpers ───────────────

  async login(username: string, password = PASSWORD): Promise<Session> {
    // Every test signs in from 127.0.0.1; clear the per-IP login budget so suites stay independent.
    await this.clearRateLimits('rl:login:ip:*');
    const res = await this.http()
      .post('/api/v1/auth/login')
      .send({ username, password })
      .expect(200);
    const body = res.body as LoginResponseDto;
    if (body.mfaRequired) throw new Error(`${username} requires MFA; use loginWithMfa`);
    return new Session(
      this,
      body.accessToken,
      body.me.user.id,
      refreshCookie(res.headers['set-cookie']),
    );
  }

  /** Signs in and enrols TOTP so privileged permissions are usable. Returns the session and secret. */
  async loginWithMfa(username: string): Promise<Session & { mfaSecret: string }> {
    const session = await this.login(username);
    const setup = await session.post('/api/v1/auth/mfa/setup').expect(200);
    const secret = setup.body.secret as string;
    await session
      .post('/api/v1/auth/mfa/enable')
      .send({ code: this.mfa.generate(secret) })
      .expect(204);
    return Object.assign(session, { mfaSecret: secret });
  }

  socket(session: Session): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${this.baseUrl}${REALTIME_NAMESPACE}`, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: session.token },
        reconnection: false,
        forceNew: true,
      });
      this.sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (error) => reject(error));
    });
  }
}

export class Session {
  constructor(
    private readonly harness: Harness,
    readonly token: string,
    readonly userId: string,
    readonly refreshCookie: string | null,
  ) {}

  get(path: string) {
    return this.harness.http().get(path).set('Authorization', `Bearer ${this.token}`);
  }
  post(path: string) {
    return this.harness.http().post(path).set('Authorization', `Bearer ${this.token}`);
  }
  put(path: string) {
    return this.harness.http().put(path).set('Authorization', `Bearer ${this.token}`);
  }
  patch(path: string) {
    return this.harness.http().patch(path).set('Authorization', `Bearer ${this.token}`);
  }
  delete(path: string) {
    return this.harness.http().delete(path).set('Authorization', `Bearer ${this.token}`);
  }
}

export function refreshCookie(setCookie: string | string[] | undefined): string | null {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = cookies.find((c) => c.startsWith('sl_refresh='));
  return match ? match.split(';')[0]! : null;
}

/** Resolves with the next payload of `event`, or rejects after `ms`. */
export function nextEvent<T>(
  socket: Socket,
  event: string,
  ms = 5_000,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, ms);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Collects every payload of `event` for `ms` milliseconds (used to assert that nothing arrives). */
export function collectEvents<T>(socket: Socket, event: string, ms: number): Promise<T[]> {
  const received: T[] = [];
  const handler = (payload: T) => received.push(payload);
  socket.on(event, handler);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off(event, handler);
      resolve(received);
    }, ms),
  );
}

export function uuid(): string {
  return randomUUID();
}
