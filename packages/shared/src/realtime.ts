/**
 * Socket.IO event contract (namespace "/v1"). See docs/architecture/messaging.md.
 * Message *sending* is REST-only; the socket carries acknowledgements and live events.
 */
import { z } from 'zod';
import type {
  ApiErrorCode,
  ConversationSummaryDto,
  MediaAssetDto,
  MessageDto,
  MessageState,
} from './dto';
import type { IncidentDto } from './emergency-types';
import type { CallDto } from './feature-types';
import type { CallSignal } from './schemas/rich-messages';
import { idSchema } from './schemas/common';

export const REALTIME_NAMESPACE = '/v1';
export const REALTIME_PATH = '/socket.io';

export const seqAckSchema = z.object({
  conversationId: idSchema,
  seq: z.number().int().min(1),
});
export type SeqAck = z.infer<typeof seqAckSchema>;

export const conversationRefSchema = z.object({ conversationId: idSchema });
export type ConversationRef = z.infer<typeof conversationRefSchema>;

export type AckResponse =
  { ok: true } | { ok: false; error: { code: ApiErrorCode; message: string } };

export interface ClientToServerEvents {
  'message.delivered': (payload: SeqAck, ack: (res: AckResponse) => void) => void;
  'message.read': (payload: SeqAck, ack: (res: AckResponse) => void) => void;
  'typing.start': (payload: ConversationRef, ack?: (res: AckResponse) => void) => void;
  'typing.stop': (payload: ConversationRef, ack?: (res: AckResponse) => void) => void;
  /** WebRTC offer/answer/ICE for a call you are part of. */
  'call.signal': (payload: CallSignal, ack?: (res: AckResponse) => void) => void;
}

export interface ReceiptUpdatedEvent {
  conversationId: string;
  userId: string;
  lastDeliveredSeq: number;
  /** null when read receipts are disabled for the business. */
  lastReadSeq: number | null;
}

export interface MessageStatusChangedEvent {
  conversationId: string;
  messageId: string;
  seq: number;
  state: MessageState;
}

export interface TypingChangedEvent {
  conversationId: string;
  userId: string;
  displayName: string;
  typing: boolean;
}

export interface PresenceChangedEvent {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface UnreadCountEvent {
  conversationId: string;
  unreadCount: number;
  lastReadSeq: number;
}

export interface ServerToClientEvents {
  'message.created': (message: MessageDto) => void;
  'message.updated': (message: MessageDto) => void;
  /** "Delete for me" on another of your devices: remove it from this one too. */
  'message.hidden': (event: { conversationId: string; messageId: string }) => void;
  'message.status_changed': (event: MessageStatusChangedEvent) => void;
  'receipt.updated': (event: ReceiptUpdatedEvent) => void;
  'conversation.updated': (conversation: ConversationSummaryDto) => void;
  'conversation.removed': (event: { conversationId: string }) => void;
  'conversation.unread_count': (event: UnreadCountEvent) => void;
  'typing.changed': (event: TypingChangedEvent) => void;
  'presence.changed': (event: PresenceChangedEvent) => void;
  'session.revoked': (event: { reason: string }) => void;
  /** Sent to the uploader only, when verification finishes (READY, QUARANTINED, REJECTED). */
  'media.status_changed': (media: MediaAssetDto) => void;
  /** To people being alerted now (initial alert or escalation). Show a high-visibility alert. */
  'emergency.alert_created': (incident: IncidentDto) => void;
  /** To the reporter, alerted responders and incident.read holders for the store. */
  'emergency.incident_updated': (incident: IncidentDto) => void;
  /** Someone is calling you. */
  'call.incoming': (call: CallDto) => void;
  /** A call you are part of was answered, declined or ended (to both people, all devices). */
  'call.updated': (call: CallDto) => void;
  /** WebRTC signalling from the other person. */
  'call.signal': (event: { callId: string; fromUserId: string; data: CallSignal['data'] }) => void;
  /** A status update was posted or removed in one of your businesses. */
  'status.changed': (event: { businessId: string }) => void;
  /** Your store tasks changed (assigned to you, completed, edited). */
  'task.changed': (event: { businessId: string; storeId: string }) => void;
}
