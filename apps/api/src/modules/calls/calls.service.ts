import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CallConfigDto,
  CallDto,
  CallLogEntryDto,
  CallOutcome,
  CallSignal,
  MessageMeta,
  PublicUserDto,
  StartCallRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import type { Actor } from '../auth/actor';
import { ConversationAccessService } from '../messaging/conversation-access.service';
import { MessageWriter } from '../messaging/message-writer.service';
import { OutboxService } from '../outbox/outbox.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

/** Call state kept in Redis while a call rings or is active. */
interface CallState {
  id: string;
  conversationId: string;
  businessId: string;
  media: 'audio' | 'video';
  caller: PublicUserDto;
  callee: PublicUserDto;
  callerSessionId: string;
  calleeSessionId: string | null;
  state: 'ringing' | 'active' | 'ended';
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  outcome: CallOutcome | null;
}

const CALL_TTL_SECONDS = 4 * 3600;
const callKey = (id: string) => `call:${id}`;
const busyKey = (userId: string) => `call-busy:${userId}`;

/**
 * One-to-one voice and video calls in direct chats (WebRTC, peer to peer). The server only
 * rings, relays signalling between the two devices in the call and records the call in the
 * chat (missed, declined, duration). Media never passes through the server.
 */
@Injectable()
export class CallsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly access: ConversationAccessService,
    private readonly writer: MessageWriter,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  configFor(): CallConfigDto {
    return { iceServers: this.config.CALL_ICE_SERVERS, ringSeconds: this.config.CALL_RING_SECONDS };
  }

  private toDto(call: CallState): CallDto {
    return {
      id: call.id,
      conversationId: call.conversationId,
      media: call.media,
      caller: call.caller,
      callee: call.callee,
      state: call.state,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      outcome: call.outcome,
    };
  }

  private async load(callId: string): Promise<CallState | null> {
    const raw = await this.redis.client.get(callKey(callId));
    return raw ? (JSON.parse(raw) as CallState) : null;
  }

  private async save(call: CallState): Promise<void> {
    await this.redis.client.set(callKey(call.id), JSON.stringify(call), 'EX', CALL_TTL_SECONDS);
  }

  /** Whether the user is in a live call (stale markers are ignored). */
  private async busy(userId: string): Promise<boolean> {
    const callId = await this.redis.client.get(busyKey(userId));
    if (!callId) return false;
    const call = await this.load(callId);
    return !!call && call.state !== 'ended';
  }

  async start(actor: Actor, request: StartCallRequest): Promise<CallDto> {
    const { conversation } = await this.access.requireMember(request.conversationId, actor.userId);
    if (conversation.type !== 'DIRECT')
      throw ApiError.validation('Calls are available in one-to-one chats.', 'conversationId');
    await this.access.requireSendPermission(actor, conversation.businessId);
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId: conversation.id, leftAt: null },
      select: { user: { select: publicUserSelect } },
    });
    const caller = members.find((m) => m.user.id === actor.userId)?.user;
    const callee = members.find((m) => m.user.id !== actor.userId)?.user;
    if (!caller || !callee || callee.status !== 'ACTIVE')
      throw ApiError.conflict('This person cannot be called.');
    if (await this.busy(actor.userId)) throw ApiError.conflict('You are already in a call.');
    const call: CallState = {
      id: randomUUID(),
      conversationId: conversation.id,
      businessId: conversation.businessId,
      media: request.media,
      caller: toPublicUser(caller),
      callee: toPublicUser(callee),
      callerSessionId: actor.sessionId,
      calleeSessionId: null,
      state: 'ringing',
      startedAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      outcome: null,
    };
    if (await this.busy(callee.id)) {
      // WhatsApp shows "on another call"; record it as missed for the person called.
      await this.finish(call, 'busy');
      return this.toDto(call);
    }
    await this.save(call);
    await this.redis.client.set(busyKey(actor.userId), call.id, 'EX', CALL_TTL_SECONDS);
    this.realtime.toUsers([callee.id], 'call.incoming', this.toDto(call));
    return this.toDto(call);
  }

  private async requireParty(actor: Actor, callId: string): Promise<CallState> {
    const call = await this.load(callId);
    if (!call || (call.caller.id !== actor.userId && call.callee.id !== actor.userId))
      throw ApiError.notFound('Call');
    return call;
  }

  async accept(actor: Actor, callId: string): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.callee.id !== actor.userId) throw ApiError.forbidden();
    if (call.state !== 'ringing') throw ApiError.conflict('This call has ended.');
    if (await this.busy(actor.userId)) throw ApiError.conflict('You are already in a call.');
    call.state = 'active';
    call.answeredAt = new Date().toISOString();
    call.calleeSessionId = actor.sessionId;
    await this.save(call);
    await this.redis.client.set(busyKey(actor.userId), call.id, 'EX', CALL_TTL_SECONDS);
    // Every device of both people: the other phones/tabs stop ringing.
    this.realtime.toUsers([call.caller.id, call.callee.id], 'call.updated', this.toDto(call));
    return this.toDto(call);
  }

  async decline(actor: Actor, callId: string): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.callee.id !== actor.userId) throw ApiError.forbidden();
    if (call.state !== 'ringing') return this.toDto(call);
    await this.finish(call, 'declined');
    return this.toDto(call);
  }

  /** Hang up (either person), cancel (caller while ringing) or no answer in time. */
  async end(actor: Actor, callId: string, reason: 'hangup' | 'timeout' | 'failed'): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.state === 'ended') return this.toDto(call);
    const outcome: CallOutcome =
      call.state === 'active'
        ? 'answered'
        : reason === 'failed'
          ? 'failed'
          : reason === 'timeout' ||
              Date.now() - Date.parse(call.startedAt) >= this.config.CALL_RING_SECONDS * 1000
            ? 'missed'
            : call.caller.id === actor.userId
              ? 'cancelled'
              : 'declined';
    await this.finish(call, outcome);
    return this.toDto(call);
  }

  /** Ends the call, frees both people and writes the call into the chat. */
  private async finish(call: CallState, outcome: CallOutcome): Promise<void> {
    const now = new Date();
    const durationSec =
      outcome === 'answered' && call.answeredAt
        ? Math.max(0, Math.round((now.getTime() - Date.parse(call.answeredAt)) / 1000))
        : 0;
    call.state = 'ended';
    call.outcome = outcome;
    call.endedAt = now.toISOString();
    await this.save(call);
    for (const userId of [call.caller.id, call.callee.id]) {
      const current = await this.redis.client.get(busyKey(userId));
      if (current === call.id) await this.redis.client.del(busyKey(userId));
    }
    this.realtime.toUsers([call.caller.id, call.callee.id], 'call.updated', this.toDto(call));
    const meta: MessageMeta = {
      type: 'call',
      media: call.media,
      outcome,
      durationSec,
      callerId: call.caller.id,
    };
    const { event } = await this.prisma.$transaction((tx) =>
      this.writer.create(tx, {
        conversationId: call.conversationId,
        businessId: call.businessId,
        senderId: call.caller.id,
        // One record per call, even if both people hang up at once.
        clientMessageId: call.id,
        kind: 'CALL',
        body: null,
        meta,
      }),
    ).catch(() => ({ event: null }));
    if (event) await this.outbox.dispatch([event]);
  }

  /** Relays WebRTC signalling to the other device in the call only. */
  async signal(actor: Actor, payload: CallSignal): Promise<void> {
    const call = await this.requireParty(actor, payload.callId);
    if (call.state === 'ended') throw ApiError.conflict('This call has ended.');
    const fromCaller = call.caller.id === actor.userId;
    if (fromCaller && actor.sessionId !== call.callerSessionId) throw ApiError.forbidden();
    if (!fromCaller && call.calleeSessionId && actor.sessionId !== call.calleeSessionId)
      throw ApiError.forbidden();
    const target = fromCaller ? call.calleeSessionId : call.callerSessionId;
    if (!target) throw ApiError.conflict('The call has not been answered yet.');
    this.realtime.toSessions([target], 'call.signal', {
      callId: call.id,
      fromUserId: actor.userId,
      data: payload.data,
    });
  }

  /** The Calls tab: recent calls in chats the person still belongs to. */
  async log(actor: Actor): Promise<CallLogEntryDto[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        kind: 'CALL',
        deletedAt: null,
        hiddenBy: { none: { userId: actor.userId } },
        conversation: { members: { some: { userId: actor.userId, leftAt: null } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        conversationId: true,
        meta: true,
        createdAt: true,
        conversation: {
          select: {
            members: {
              where: { userId: { not: actor.userId } },
              select: { user: { select: publicUserSelect } },
              take: 1,
            },
          },
        },
      },
    });
    return rows.flatMap((r) => {
      const meta = r.meta as MessageMeta | null;
      const peer = r.conversation.members[0]?.user;
      if (meta?.type !== 'call' || !peer) return [];
      return [
        {
          messageId: r.id,
          conversationId: r.conversationId,
          peer: toPublicUser(peer),
          media: meta.media,
          outcome: meta.outcome,
          outgoing: meta.callerId === actor.userId,
          durationSec: meta.durationSec,
          at: r.createdAt.toISOString(),
        },
      ];
    });
  }
}
