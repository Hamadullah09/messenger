import { Injectable } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { REALTIME_NAMESPACE, type ServerToClientEvents } from '@storeline/shared';
import { RedisService } from '../../infra/redis/redis.service';

const ROOM_CHUNK = 500;

export const userRoom = (userId: string): string => `user:${userId}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

/**
 * Publishes Socket.IO events from any process (API or worker) through Redis, reaching
 * sockets on every API replica. Emitting is fire-and-forget: it is NOT a delivery
 * guarantee (clients acknowledge and resync by seq).
 */
@Injectable()
export class RealtimeEmitter {
  private readonly emitter;

  constructor(redis: RedisService) {
    this.emitter = new Emitter<ServerToClientEvents>(redis.createConnection('socket-emitter')).of(
      REALTIME_NAMESPACE,
    );
  }

  toUsers<E extends keyof ServerToClientEvents>(
    userIds: readonly string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const unique = [...new Set(userIds)];
    for (let i = 0; i < unique.length; i += ROOM_CHUNK) {
      const rooms = unique.slice(i, i + ROOM_CHUNK).map(userRoom);
      (this.emitter.to(rooms) as { emit: (event: string, ...payload: unknown[]) => void }).emit(
        event,
        ...args,
      );
    }
  }

  /** To specific signed-in devices (sessions) only, e.g. the two devices in a call. */
  toSessions<E extends keyof ServerToClientEvents>(
    sessionIds: readonly string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    if (sessionIds.length === 0) return;
    (
      this.emitter.to([...new Set(sessionIds)].map(sessionRoom)) as {
        emit: (event: string, ...payload: unknown[]) => void;
      }
    ).emit(event, ...args);
  }

  /** Tells the sessions' sockets why, then closes them on every node. */
  disconnectSessions(sessionIds: readonly string[], reason: string): void {
    if (sessionIds.length === 0) return;
    const rooms = sessionIds.map(sessionRoom);
    (this.emitter.to(rooms) as { emit: (event: string, ...payload: unknown[]) => void }).emit(
      'session.revoked',
      { reason },
    );
    this.emitter.in(rooms).disconnectSockets(true);
  }
}
