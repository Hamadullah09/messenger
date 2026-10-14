import { Controller, Get, HttpCode, Module, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { Public } from '../auth/actor';
import { ClientErrorsController } from './client-errors.controller';

type CheckResult = 'ok' | 'fail';

/** Public health endpoints. They never expose versions, hostnames, errors or stack traces. */
@ApiTags('health')
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: CheckResult; checks: Record<string, CheckResult> }> {
    const [database, redis] = await Promise.all([
      withTimeout(this.prisma.$queryRaw`SELECT 1`),
      withTimeout(this.redis.client.ping()),
    ]);
    const healthy = database === 'ok' && redis === 'ok';
    res.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'fail', checks: { database, redis } };
  }
}

async function withTimeout(promise: Promise<unknown>, ms = 2_000): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

@Module({ controllers: [HealthController, ClientErrorsController] })
export class HealthModule {}
