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
  group: boolean;
  title: string | null;
  caller: PublicUserDto;
  /** One-to-one: the person called. Group: the caller again. */
  callee: PublicUserDto;
  /** Everyone invited (group calls), by id. */
  members: Record<string, PublicUserDto>;
  /** Who is in the call now: user id → the device (session) they use. */
  joined: Record<string, string>;
  /** Group calls: did anyone besides the caller join? */
  everJoined: boolean;
  state: 'ringing' | 'active' | 'ended';
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  outcome: CallOutcome | null;
}

/** Mesh calls: every device connects to every other, so keep groups small. */
export const GROUP_CALL_MAX = 8;
const CALL_TTL_SECONDS = 4 * 3600;
const callKey = (id: string) => `call:${id}`;
const busyKey = (userId: string) => `call-busy:${userId}`;

/**
 * Voice and video calls (WebRTC, peer to peer). One-to-one in direct chats; group calls in
 * groups (up to 8 people, everyone connected to everyone). The server rings, relays signalling
 * between the devices in the call and records the call in the chat. Media never passes through
 * the server.
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
      group: call.group,
      title: call.title,
      caller: call.caller,
      callee: call.callee,
      participants: Object.keys(call.joined).map((id) => call.members[id]!).filter(Boolean),
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
    return !!call && call.state !== 'ended' && userId in call.joined;
  }

  private everyone(call: CallState): string[] {
    return Object.keys(call.members);
  }

  async start(actor: Actor, request: StartCallRequest): Promise<CallDto> {
    const { conversation } = await this.access.requireMember(request.conversationId, actor.userId);
    if (conversation.type !== 'DIRECT' && conversation.type !== 'GROUP')
      throw ApiError.validation('Calls are available in chats and groups.', 'conversationId');
    await this.access.requireSendPermission(actor, conversation.businessId);
    if (await this.busy(actor.userId)) throw ApiError.conflict('You are already in a call.');
    const group = conversation.type === 'GROUP';
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId: conversation.id, leftAt: null, user: { status: 'ACTIVE' } },
      select: { user: { select: publicUserSelect } },
      take: group ? 256 : 2,
    });
    const members = Object.fromEntries(rows.map((m) => [m.user.id, toPublicUser(m.user)]));
    const caller = members[actor.userId];
    if (!caller) throw ApiError.forbidden();
    if (group) {
      // One group call per group at a time: join it instead.
      const existing = await this.redis.client.get(`group-call:${conversation.id}`);
      const live = existing ? await this.load(existing) : null;
      if (live && live.state !== 'ended') return this.join(actor, live.id);
    }
    const callee = group ? caller : Object.values(members).find((m) => m.id !== actor.userId);
    if (!callee) throw ApiError.conflict('This person cannot be called.');
    const title = group
      ? ((
          await this.prisma.conversation.findUnique({
            where: { id: conversation.id },
            select: { title: true },
          })
        )?.title ?? 'Group')
      : null;
    const call: CallState = {
      id: randomUUID(),
      conversationId: conversation.id,
      businessId: conversation.businessId,
      media: request.media,
      group,
      title,
      caller,
      callee,
      members,
      joined: { [actor.userId]: actor.sessionId },
      everJoined: false,
      state: group ? 'active' : 'ringing',
      startedAt: new Date().toISOString(),
      answeredAt: group ? new Date().toISOString() : null,
      endedAt: null,
      outcome: null,
    };
    if (!group && (await this.busy(callee.id))) {
      await this.finish(call, 'busy');
      return this.toDto(call);
    }
    await this.save(call);
    await this.redis.client.set(busyKey(actor.userId), call.id, 'EX', CALL_TTL_SECONDS);
    if (group) await this.redis.client.set(`group-call:${conversation.id}`, call.id, 'EX', CALL_TTL_SECONDS);
    const invite = this.everyone(call).filter((id) => id !== actor.userId);
    this.realtime.toUsers(invite, 'call.incoming', this.toDto(call));
    return this.toDto(call);
  }

  private async requireParty(actor: Actor, callId: string): Promise<CallState> {
    const call = await this.load(callId);
    if (!call || !(actor.userId in call.members)) throw ApiError.notFound('Call');
    return call;
  }

  /** Group calls: join (or re-join) a running call. */
  async join(actor: Actor, callId: string): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.state === 'ended') throw ApiError.conflict('This call has ended.');
    if (!(actor.userId in call.joined) && Object.keys(call.joined).length >= GROUP_CALL_MAX)
      throw ApiError.conflict(`Group calls can have up to ${GROUP_CALL_MAX} people.`);
    if (!(actor.userId in call.joined) && (await this.busy(actor.userId)))
      throw ApiError.conflict('You are already in a call.');
    call.joined[actor.userId] = actor.sessionId;
    if (actor.userId !== call.caller.id) call.everJoined = true;
    await this.save(call);
    await this.redis.client.set(busyKey(actor.userId), call.id, 'EX', CALL_TTL_SECONDS);
    this.realtime.toUsers(this.everyone(call), 'call.updated', this.toDto(call));
    return this.toDto(call);
  }

  async accept(actor: Actor, callId: string): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.group) return this.join(actor, callId);
    if (call.callee.id !== actor.userId) throw ApiError.forbidden();
    if (call.state !== 'ringing') throw ApiError.conflict('This call has ended.');
    if (await this.busy(actor.userId)) throw ApiError.conflict('You are already in a call.');
    call.state = 'active';
    call.answeredAt = new Date().toISOString();
    call.joined[actor.userId] = actor.sessionId;
    await this.save(call);
    await this.redis.client.set(busyKey(actor.userId), call.id, 'EX', CALL_TTL_SECONDS);
    // Every device of both people: the other phones/tabs stop ringing.
    this.realtime.toUsers([call.caller.id, call.callee.id], 'call.updated', this.toDto(call));
    return this.toDto(call);
  }

  async decline(actor: Actor, callId: string): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    // Group calls go on without the person who declined.
    if (call.group) return this.toDto(call);
    if (call.callee.id !== actor.userId) throw ApiError.forbidden();
    if (call.state !== 'ringing') return this.toDto(call);
    await this.finish(call, 'declined');
    return this.toDto(call);
  }

  /** Hang up (either person / leave a group call), cancel (caller while ringing) or time out. */
  async end(actor: Actor, callId: string, reason: 'hangup' | 'timeout' | 'failed'): Promise<CallDto> {
    const call = await this.requireParty(actor, callId);
    if (call.state === 'ended') return this.toDto(call);
    if (call.group) {
      delete call.joined[actor.userId];
      const current = await this.redis.client.get(busyKey(actor.userId));
      if (current === call.id) await this.redis.client.del(busyKey(actor.userId));
      if (Object.keys(call.joined).length > 0) {
        await this.save(call);
        this.realtime.toUsers(this.everyone(call), 'call.updated', this.toDto(call));
        return this.toDto(call);
      }
      await this.finish(call, call.everJoined ? 'answered' : 'missed');
      return this.toDto(call);
    }
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

  /** Ends the call, frees everyone and writes the call into the chat. */
  private async finish(call: CallState, outcome: CallOutcome): Promise<void> {
    const now = new Date();
    const since = call.answeredAt ?? call.startedAt;
    const durationSec =
      outcome === 'answered' ? Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 1000)) : 0;
    call.state = 'ended';
    call.outcome = outcome;
    call.endedAt = now.toISOString();
    call.joined = {};
    await this.save(call);
    for (const userId of this.everyone(call)) {
      const current = await this.redis.client.get(busyKey(userId));
      if (current === call.id) await this.redis.client.del(busyKey(userId));
    }
    if (call.group) await this.redis.client.del(`group-call:${call.conversationId}`);
    this.realtime.toUsers(this.everyone(call), 'call.updated', this.toDto(call));
    const meta: MessageMeta = {
      type: 'call',
      media: call.media,
      outcome,
      durationSec,
      callerId: call.caller.id,
    };
    const { event } = await this.prisma
      .$transaction((tx) =>
        this.writer.create(tx, {
          conversationId: call.conversationId,
          businessId: call.businessId,
          senderId: call.caller.id,
          // One record per call, even if several people hang up at once.
          clientMessageId: call.id,
          kind: 'CALL',
          body: call.group ? `${call.title ?? 'Group'} call` : null,
          meta,
        }),
      )
      .catch(() => ({ event: null }));
    if (event) await this.outbox.dispatch([event]);
  }

  /** Relays WebRTC signalling to one other device in the call. */
  async signal(actor: Actor, payload: CallSignal): Promise<void> {
    const call = await this.requireParty(actor, payload.callId);
    if (call.state === 'ended') throw ApiError.conflict('This call has ended.');
    const mine = call.joined[actor.userId];
    if (call.group) {
      if (mine !== actor.sessionId) throw ApiError.forbidden();
      const to = payload.to ? call.joined[payload.to] : undefined;
      if (!to) throw ApiError.conflict('That person is not in the call.');
      this.realtime.toSessions([to], 'call.signal', {
        callId: call.id,
        fromUserId: actor.userId,
        data: payload.data,
      });
      return;
    }
    const fromCaller = call.caller.id === actor.userId;
    if (fromCaller && actor.sessionId !== call.joined[call.caller.id]) throw ApiError.forbidden();
    const calleeSession = call.joined[call.callee.id];
    if (!fromCaller && calleeSession && actor.sessionId !== calleeSession) throw ApiError.forbidden();
    const target = fromCaller ? calleeSession : call.joined[call.caller.id];
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
            type: true,
            title: true,
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
      const peerUser = r.conversation.members[0]?.user;
      if (meta?.type !== 'call' || !peerUser) return [];
      const peer =
        r.conversation.type === 'GROUP'
          ? { ...toPublicUser(peerUser), id: peerUser.id, displayName: r.conversation.title ?? 'Group' }
          : toPublicUser(peerUser);
      return [
        {
          messageId: r.id,
          conversationId: r.conversationId,
          peer,
          group: r.conversation.type === 'GROUP',
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
