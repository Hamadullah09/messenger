import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  callSignalSchema,
  conversationRefSchema,
  REALTIME_NAMESPACE,
  seqAckSchema,
  type AckResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@storeline/shared';
import type { Namespace, Socket } from 'socket.io';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { Actor } from '../auth/actor';
import { SessionService } from '../auth/session.service';
import { CallsService } from '../calls/calls.service';
import { ConversationAccessService } from '../messaging/conversation-access.service';
import { ReceiptsService } from '../messaging/receipts.service';
import { PresenceService } from './presence.service';
import { sessionRoom, userRoom } from './realtime-emitter.service';
import { metrics } from '../../infra/metrics/metrics';

interface SocketData {
  actor: Actor;
  displayName: string;
  /** Token bucket for client events. */
  tokens: number;
  refilledAt: number;
  typingAt: Map<string, number>;
}

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const MAX_SOCKETS_PER_USER = 10;
const BUCKET_CAPACITY = 40;
const BUCKET_REFILL_PER_SECOND = 20;
const TYPING_THROTTLE_MS = 2_000;
const TYPING_MAX_GROUP_SIZE = 256;
const REVALIDATE_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Receive-side real-time channel. Clients never choose rooms: each socket joins only its
 * user and session rooms (ADR-0004). Every event is validated and re-authorized.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private timers: NodeJS.Timeout[] = [];

  @WebSocketServer()
  private readonly namespace!: Namespace<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >;

  constructor(
    private readonly sessions: SessionService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptsService,
    private readonly access: ConversationAccessService,
    private readonly presence: PresenceService,
    private readonly calls: CallsService,
  ) {}

  afterInit(): void {
    this.namespace.use((socket, next) => {
      void this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch((error: unknown) => {
          const code = error instanceof ApiError ? error.code : 'UNAUTHENTICATED';
          next(Object.assign(new Error(code), { data: { code } }));
        });
    });
    this.timers.push(
      // Background checks must never crash the API (e.g. while the database restarts).
      setInterval(
        () =>
          void this.heartbeat().catch((error: unknown) =>
            this.logger.warn({ err: error }, 'Presence heartbeat failed'),
          ),
        HEARTBEAT_INTERVAL_MS,
      ).unref(),
      setInterval(
        () =>
          void this.revalidate().catch((error: unknown) =>
            this.logger.warn({ err: error }, 'Session revalidation failed; will retry'),
          ),
        REVALIDATE_INTERVAL_MS,
      ).unref(),
    );
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    const { actor } = socket.data;
    metrics.wsConnects.inc();
    metrics.wsConnections.inc();
    await socket.join([userRoom(actor.userId), sessionRoom(actor.sessionId)]);
    await this.presence.connected(actor.userId, socket.id).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Presence update failed');
    });
  }

  async handleDisconnect(socket: AppSocket): Promise<void> {
    const actor = socket.data?.actor;
    if (!actor) return;
    metrics.wsConnections.dec();
    await this.presence.disconnected(actor.userId, socket.id).catch(() => undefined);
  }

  @SubscribeMessage('message.delivered')
  onDelivered(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() payload: unknown,
  ): Promise<AckResponse> {
    return this.handle(socket, async () => {
      const ack = seqAckSchema.parse(payload);
      await this.receipts.acknowledge(
        socket.data.actor.userId,
        ack.conversationId,
        ack.seq,
        'delivered',
      );
    });
  }

  @SubscribeMessage('message.read')
  onRead(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() payload: unknown,
  ): Promise<AckResponse> {
    return this.handle(socket, async () => {
      const ack = seqAckSchema.parse(payload);
      await this.receipts.acknowledge(
        socket.data.actor.userId,
        ack.conversationId,
        ack.seq,
        'read',
      );
    });
  }

  @SubscribeMessage('typing.start')
  onTypingStart(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() payload: unknown,
  ): Promise<AckResponse> {
    return this.handle(socket, () => this.typing(socket, payload, true));
  }

  @SubscribeMessage('typing.stop')
  onTypingStop(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() payload: unknown,
  ): Promise<AckResponse> {
    return this.handle(socket, () => this.typing(socket, payload, false));
  }

  /** WebRTC offer/answer/ICE, relayed to the other device in the call. */
  @SubscribeMessage('call.signal')
  onCallSignal(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() payload: unknown,
  ): Promise<AckResponse> {
    return this.handle(socket, () =>
      this.calls.signal(socket.data.actor, callSignalSchema.parse(payload)),
    );
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private async typing(socket: AppSocket, payload: unknown, typing: boolean): Promise<void> {
    const { conversationId } = conversationRefSchema.parse(payload);
    const now = Date.now();
    const last = socket.data.typingAt.get(conversationId) ?? 0;
    if (typing && now - last < TYPING_THROTTLE_MS) return;
    socket.data.typingAt.set(conversationId, typing ? now : 0);

    const { conversation } = await this.access.requireMember(
      conversationId,
      socket.data.actor.userId,
    );
    if (conversation.memberCount > TYPING_MAX_GROUP_SIZE) return;
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, leftAt: null, userId: { not: socket.data.actor.userId } },
      select: { userId: true },
    });
    this.namespace.to(members.map((m) => userRoom(m.userId))).emit('typing.changed', {
      conversationId,
      userId: socket.data.actor.userId,
      displayName: socket.data.displayName,
      typing,
    });
  }

  private async authenticate(socket: AppSocket): Promise<void> {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 4096) throw ApiError.unauthenticated();
    const actor = await this.sessions.authenticate(token, {
      requestId: null,
      ipHash: this.crypto.keyedHash(socket.handshake.address),
    });
    if (actor.mustChangePassword)
      throw new ApiError('PASSWORD_CHANGE_REQUIRED', 'Password change required');
    const existing = await this.namespace.in(userRoom(actor.userId)).fetchSockets();
    if (existing.length >= MAX_SOCKETS_PER_USER) throw ApiError.rateLimited(30);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { displayName: true },
    });
    socket.data = {
      actor,
      displayName: user.displayName,
      tokens: BUCKET_CAPACITY,
      refilledAt: Date.now(),
      typingAt: new Map(),
    };
  }

  /** Validation, rate limiting and error mapping shared by every client event. */
  private async handle(socket: AppSocket, fn: () => Promise<void>): Promise<AckResponse> {
    if (!this.takeToken(socket))
      return { ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } };
    try {
      await fn();
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError)
        return { ok: false, error: { code: error.code, message: error.message } };
      if (error instanceof Error && error.name === 'ZodError') {
        return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid payload' } };
      }
      this.logger.error({ err: error }, 'Socket event failed');
      return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } };
    }
  }

  private takeToken(socket: AppSocket): boolean {
    const data = socket.data;
    const now = Date.now();
    data.tokens = Math.min(
      BUCKET_CAPACITY,
      data.tokens + ((now - data.refilledAt) / 1000) * BUCKET_REFILL_PER_SECOND,
    );
    data.refilledAt = now;
    if (data.tokens < 1) return false;
    data.tokens -= 1;
    return true;
  }

  private async heartbeat(): Promise<void> {
    const sockets = await this.namespace.local.fetchSockets();
    await this.presence
      .heartbeat(
        sockets
          .filter((s) => s.data?.actor)
          .map((s) => ({ userId: s.data.actor.userId, socketId: s.id })),
      )
      .catch(() => undefined);
  }

  /** Closes local sockets whose session was revoked or expired (backstop for missed revocation events). */
  private async revalidate(): Promise<void> {
    const sockets = await this.namespace.local.fetchSockets();
    const sessionIds = [
      ...new Set(sockets.map((s) => s.data?.actor?.sessionId).filter((id): id is string => !!id)),
    ];
    if (sessionIds.length === 0) return;
    const valid = await this.prisma.session.findMany({
      where: {
        id: { in: sessionIds },
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    const validIds = new Set(valid.map((s) => s.id));
    for (const socket of sockets) {
      if (socket.data?.actor && !validIds.has(socket.data.actor.sessionId)) socket.disconnect(true);
    }
  }
}
