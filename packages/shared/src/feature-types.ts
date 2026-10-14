/**
 * Response shapes for calls, broadcast lists, status updates, store tasks and shifts, reports
 * and platform integrations.
 */
import type { AttachmentDto, CallOutcome, PublicUserDto } from './dto';
import type { IntegrationKey } from './schemas/rich-messages';

// ── Calls ──

export type CallState = 'ringing' | 'active' | 'ended';

export interface CallDto {
  id: string;
  conversationId: string;
  media: 'audio' | 'video';
  /** Group call (everyone in the group is invited; people join and leave). */
  group: boolean;
  /** Group name for group calls. */
  title: string | null;
  caller: PublicUserDto;
  /** For one-to-one calls the person called; for group calls the starter again. */
  callee: PublicUserDto;
  /** Group calls: who is in the call now. */
  participants: PublicUserDto[];
  state: CallState;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Set when ended. */
  outcome: CallOutcome | null;
}

export interface CallConfigDto {
  /** WebRTC ICE servers (STUN/TURN). Empty on a local network, where none are needed. */
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** Seconds the phone rings before the call counts as missed. */
  ringSeconds: number;
}

/** One entry of the Calls tab. */
export interface CallLogEntryDto {
  messageId: string;
  conversationId: string;
  /** The other person (a group call: the group, by name). */
  peer: PublicUserDto;
  group: boolean;
  media: 'audio' | 'video';
  outcome: CallOutcome;
  outgoing: boolean;
  durationSec: number;
  at: string;
}

// ── Broadcast lists ──

export interface BroadcastListDto {
  /** The list's conversation (only the owner is a member). */
  conversationId: string;
  businessId: string;
  name: string;
  recipients: PublicUserDto[];
  createdAt: string;
}

/** Result of sending to a broadcast list. */
export interface BroadcastDeliveryDto {
  delivered: number;
  /** People who could not be messaged (left the business, no longer reachable). */
  skipped: number;
}

// ── Status ──

export interface StatusPostDto {
  id: string;
  author: PublicUserDto;
  businessId: string;
  storeId: string | null;
  storeName: string | null;
  text: string | null;
  background: string | null;
  media: AttachmentDto | null;
  createdAt: string;
  expiresAt: string;
  /** Whether the viewer has seen it. */
  viewed: boolean;
  /** Only for your own posts. */
  viewCount: number | null;
}

export interface StatusFeedDto {
  mine: StatusPostDto[];
  /** Other people's posts, grouped by person; unseen first, newest first. */
  others: Array<{ author: PublicUserDto; posts: StatusPostDto[]; allViewed: boolean }>;
}

export interface StatusViewerDto {
  user: PublicUserDto;
  viewedAt: string;
}

// ── Store tasks and shifts ──

export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface TaskDto {
  id: string;
  businessId: string;
  storeId: string;
  storeName: string;
  title: string;
  notes: string | null;
  priority: TaskPriority;
  status: 'OPEN' | 'DONE';
  dueAt: string | null;
  assignee: PublicUserDto | null;
  createdBy: PublicUserDto | null;
  completedBy: PublicUserDto | null;
  completedAt: string | null;
  createdAt: string;
  /** What the viewer may do. */
  canEdit: boolean;
  canComplete: boolean;
}

export interface ShiftDto {
  id: string;
  businessId: string;
  storeId: string;
  storeName: string;
  user: PublicUserDto;
  startsAt: string;
  endsAt: string;
  title: string | null;
  notes: string | null;
  canEdit: boolean;
}

/** People a manager can assign tasks and shifts to in a store. */
export interface StoreStaffDto {
  storeId: string;
  people: PublicUserDto[];
}

// ── Reports ──

export interface ReportDto {
  from: string;
  to: string;
  /** null = whole platform. */
  businessId: string | null;
  messages: {
    total: number;
    /** Per day (YYYY-MM-DD in UTC). */
    perDay: Array<{ day: string; count: number }>;
    byKind: Array<{ kind: string; count: number }>;
    activeSenders: number;
    /** Median minutes until someone else replied in a chat (direct and group). */
    medianReplyMinutes: number | null;
    /** Share of replies within 15 minutes (0–1). */
    repliedWithin15m: number | null;
    busiestStores: Array<{ storeId: string; storeName: string; count: number }>;
  };
  emergencies: {
    total: number;
    /** Median minutes until someone acknowledged. */
    medianAckMinutes: number | null;
  };
  tasks: { created: number; completed: number; overdueOpen: number };
  campaigns: {
    total: number;
    sent: number;
    failed: number;
    skipped: number;
    byChannel: Array<{ channel: string; campaigns: number; sent: number; failed: number }>;
  };
  customers: { total: number; newInPeriod: number; optedIn: number };
  /** Platform-wide reports only (sales funnel of SMA itself). */
  leads: {
    created: number;
    won: number;
    lost: number;
    conversionRate: number | null;
    byStage: Array<{ stage: string; count: number }>;
    bySource: Array<{ source: string; count: number }>;
  } | null;
}

// ── Platform integrations ──

export interface IntegrationsDto {
  channels: { EMAIL: boolean; SMS: boolean; WHATSAPP: boolean };
  /** Per key: where the value comes from and a masked preview (never the secret itself). */
  keys: Array<{
    key: IntegrationKey;
    source: 'app' | 'server' | 'none';
    preview: string | null;
    secret: boolean;
  }>;
}
