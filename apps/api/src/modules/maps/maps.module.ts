import { Controller, Get, Inject, Module, Param, ParseIntPipe, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { Public } from '../auth/actor';

const CACHE_MAX = 2000;
const TILE_LIMIT = { name: 'maps:tiles', limit: 600, windowSeconds: 60 } as const;

/**
 * Map tiles for location previews, fetched by the server so phones never contact a map
 * provider directly (privacy, and the page's Content-Security-Policy stays 'self'). Tiles are
 * cached in memory and in the browser. The provider is MAP_TILE_URL (OpenStreetMap by default:
 * light use only, with attribution — set a commercial provider for heavy use).
 */
@ApiTags('maps')
@Controller({ path: 'maps', version: '1' })
export class MapsController {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly rateLimiter: RateLimiterService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  @Public()
  @Get('tiles/:z/:x/:y.png')
  async tile(
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const max = 2 ** z;
    if (z < 1 || z > 18 || x < 0 || y < 0 || x >= max || y >= max) throw ApiError.notFound('Tile');
    await this.rateLimiter.consume(TILE_LIMIT, this.crypto.keyedHash(req.ip ?? 'unknown'));
    const key = `${z}/${x}/${y}`;
    let png = this.cache.get(key);
    if (!png) {
      const url = this.config.MAP_TILE_URL.replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const upstream = await fetch(url, {
        headers: { 'User-Agent': `SMA-Technology/1.0 (+${this.config.WEB_APP_URL})` },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!upstream?.ok) throw ApiError.notFound('Tile');
      png = Buffer.from(await upstream.arrayBuffer());
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(png);
  }
}

@Module({ controllers: [MapsController] })
export class MapsModule {}
