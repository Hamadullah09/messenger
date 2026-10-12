import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { APP_CONFIG, isAllowedOrigin, type AppConfig } from '../../infra/config/config';
import { RedisService } from '../../infra/redis/redis.service';

/**
 * Socket.IO server configuration: Redis adapter for multi-replica fan-out, WebSocket-only
 * transport (no sticky sessions needed), strict CORS and small payload limits.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly config: AppConfig;
  private readonly redis: RedisService;

  constructor(app: INestApplicationContext) {
    super(app);
    this.config = app.get(APP_CONFIG);
    this.redis = app.get(RedisService);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      path: '/socket.io',
      transports: ['websocket'],
      cors: {
        origin: (origin, done) => done(null, !origin || isAllowedOrigin(this.config, origin)),
        credentials: false,
      },
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      connectTimeout: 10_000,
      serveClient: false,
    } satisfies Partial<ServerOptions>) as Server;
    server.adapter(
      createAdapter(
        this.redis.createConnection('socket-pub'),
        this.redis.createConnection('socket-sub'),
      ),
    );
    return server;
  }
}
