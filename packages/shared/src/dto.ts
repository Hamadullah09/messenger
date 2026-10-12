/**
 * Response shapes shared by the API and every client. These never contain private
 * contact data, password hashes, tokens, or storage credentials.
 */
import type { Address, BusinessPolicy, SocialLinks } from './schemas/admin';
import type { Permission, ScopeType } from './authorization/permissions';
import type { MediaKind } from './schemas/media';
import type { FileSharingPolicy, GroupCategory, PostingPolicy } from './schemas/messaging';
import type { EmergencyCategory } from './emergency-types';

export type UserKind = 'INTERNAL' | 'EXTERNAL';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
export type BusinessStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type StoreStatus = 'ACTIVE' | 'ARCHIVED';

/** The only user representation exposed outside privileged, audited endpoints. */
export interface PublicUserDto {
  id: string;
  username: string;
  displayName: string;
  kind: UserKind;
  status: UserStatus;
}

export interface UserContactDto {
  userId: string;
  email: string | null;
  emailVerifiedAt: string | null;
  phone: string | null;
  phoneVerifiedAt: string | null;
}

export interface GrantDto {
  roleKey: string;
  roleName: string;
  scope: { type: ScopeType; businessId: string | null; storeId: string | null };
  permissions: Permission[];
}

export interface MeDto {
  user: PublicUserDto;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  session: { id: string; mfaVerified: boolean };
  businesses: Array<{
    id: string;
    name: string;
    slug: string;
    status: BusinessStatus;
    stores: Array<{ id: string; name: string; code: string }>;
  }>;
  grants: GrantDto[];
  /** Platform security settings the UI needs to explain itself. */
  security: { mfaRequiredForAdmins: boolean };
}

export interface AuthTokensDto {
  accessToken: string;
  accessTokenExpiresAt: string;
  /**
   * Native clients only (request header `X-SMA-Client: native`): the refresh token, to be kept
   * in the platform keystore. Browsers never receive it — they use the HttpOnly cookie.
   */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export type LoginResponseDto =
  | ({ mfaRequired: false } & AuthTokensDto & { me: MeDto })
  | { mfaRequired: true; mfaToken: string };

export interface MfaSetupDto {
  otpauthUrl: string;
  secret: string;
  qrCodeDataUrl: string;
}

export interface SessionDto {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  userAgent: string | null;
  mfaVerified: boolean;
  current: boolean;
}

/** Public profile of a business or store (country, state, links, logo…). */
export interface PlaceDetailsDto {
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  mapUrl: string | null;
  address: Address | null;
  socialLinks: SocialLinks;
  /** Relative API path of the logo image, or null when none was uploaded. */
  logoUrl: string | null;
}

export interface BusinessDto extends PlaceDetailsDto {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  timeZone: string;
  locale: string;
  policy: BusinessPolicy;
  storeCount: number;
  memberCount: number;
  /** Active stores (names only). */
  stores: Array<{ id: string; name: string; code: string }>;
  /** People holding a business-wide role: owners, admins, business managers (names only). */
  admins: Array<{ id: string; displayName: string; username: string; roleName: string }>;
  createdAt: string;
}

export interface StoreDto extends PlaceDetailsDto {
  id: string;
  businessId: string;
  name: string;
  code: string;
  status: StoreStatus;
  timeZone: string | null;
  memberCount: number;
  /** Active store managers (names only; never contact details). */
  managers: Array<{ id: string; displayName: string; username: string }>;
  createdAt: string;
}

/** A group in a business, as listed for people who manage groups (no message content). */
export interface BusinessGroupDto {
  id: string;
  title: string;
  type: 'GROUP' | 'BROADCAST' | 'EMERGENCY';
  storeId: string | null;
  storeName: string | null;
  memberCount: number;
  lastActivityAt: string;
  /** Whether the caller is a member (and can open it). */
  isMember: boolean;
}

export interface AdminUserDto extends PublicUserDto {
  /** Account-security fields are null unless the caller may manage this user (user.update). */
  mustChangePassword: boolean | null;
  mfaEnabled: boolean | null;
  lastActiveAt: string | null;
  createdAt: string;
  stores: Array<{ id: string; name: string; code: string }>;
  roles: Array<{
    assignmentId: string;
    roleKey: string;
    roleName: string;
    scopeType: ScopeType;
    storeId: string | null;
  }>;
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  businessId: string | null;
  isSystem: boolean;
  allowedScopes: ScopeType[];
  permissions: Permission[];
}

export interface AuditLogDto {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  actor: PublicUserDto | null;
  businessId: string | null;
  storeId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

export type ConversationType = 'DIRECT' | 'GROUP' | 'EMERGENCY' | 'BROADCAST' | 'BROADCAST_LIST';
export type MemberRole = 'MEMBER' | 'ADMIN';
/** Sender-side pipeline state. See docs/architecture/messaging.md. */
export type MessageState = 'ACCEPTED' | 'DISPATCHED' | 'FAILED';
export type MessageKind =
  | 'TEXT'
  | 'SYSTEM'
  | 'IMAGE'
  | 'VIDEO'
  | 'DOCUMENT'
  | 'AUDIO'
  | 'LOCATION'
  | 'CONTACT'
  | 'POLL'
  | 'EVENT'
  | 'CALL'
  | 'STICKER';

export type CallOutcome = 'answered' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed';

/** Kind-specific content of a message (null for text, files and system messages). */
export type MessageMeta =
  | { type: 'audio'; voice: boolean; durationMs: number; waveform: number[] | null }
  | {
      type: 'location';
      lat: number;
      lng: number;
      accuracy: number | null;
      name: string | null;
      address: string | null;
      /** Live location: position updates until `until` (or until stopped). */
      live: { until: string; stoppedAt: string | null; updatedAt: string } | null;
    }
  | { type: 'contact'; userId: string; displayName: string; username: string }
  | { type: 'poll'; options: string[]; multiple: boolean }
  | {
      type: 'event';
      startsAt: string;
      endsAt: string | null;
      location: string | null;
      description: string | null;
    }
  | {
      type: 'call';
      media: 'audio' | 'video';
      outcome: CallOutcome;
      durationSec: number;
      callerId: string;
    }
  | { type: 'sticker'; sticker: string };

/**
 * Attachment metadata carried in messages. Never contains storage URLs: clients request a
 * short-lived download URL (GET /media/:id/url), which re-checks authorization each time.
 */
export interface AttachmentDto {
  mediaId: string;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
}

export type MediaStatus =
  'PENDING_UPLOAD' | 'VERIFYING' | 'READY' | 'QUARANTINED' | 'REJECTED' | 'FAILED';

export interface MediaAssetDto {
  id: string;
  /** Upload context: a conversation, or a draft campaign. */
  conversationId: string | null;
  campaignId: string | null;
  kind: MediaKind;
  status: MediaStatus;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  /** Plain-language reason for QUARANTINED / REJECTED / FAILED. */
  failureReason: string | null;
  createdAt: string;
}

export type UploadInstructionsDto =
  | {
      method: 'PUT';
      url: string;
      /** Headers the client must send exactly (they are part of the signature). */
      headers: Record<string, string>;
    }
  | {
      method: 'MULTIPART';
      partSize: number;
      partCount: number;
      parts: Array<{ partNumber: number; url: string; sizeBytes: number }>;
    };

export interface UploadSessionDto {
  media: MediaAssetDto;
  upload: UploadInstructionsDto;
  /** Upload URLs stop working after this time; request new part URLs to resume. */
  urlsExpireAt: string;
}

export interface UploadPartsDto {
  uploadedPartNumbers: number[];
  parts: Array<{ partNumber: number; url: string; sizeBytes: number }>;
  urlsExpireAt: string;
}

export interface MediaUrlDto {
  url: string;
  expiresAt: string;
}

export type SystemEventDto =
  | { type: 'group_created'; actorId: string; title: string }
  | { type: 'members_added'; actorId: string; userIds: string[] }
  | { type: 'member_removed'; actorId: string; userId: string }
  | { type: 'member_left'; actorId: string }
  | { type: 'group_renamed'; actorId: string; title: string }
  | { type: 'admin_changed'; actorId: string; userId: string; role: MemberRole }
  | { type: 'emergency_raised'; actorId: string; category: EmergencyCategory; storeName: string }
  | { type: 'emergency_escalated'; actorId: string; level: number; userIds: string[] }
  | { type: 'emergency_joined'; actorId: string }
  | { type: 'emergency_acknowledged'; actorId: string }
  | { type: 'emergency_resolved'; actorId: string }
  | { type: 'emergency_cancelled'; actorId: string };

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  sender: PublicUserDto;
  kind: MessageKind;
  /** null when deleted. */
  body: string | null;
  systemEvent: SystemEventDto | null;
  deleted: boolean;
  editedAt: string | null;
  createdAt: string;
  state: MessageState;
  clientMessageId: string;
  forwarded: boolean;
  replyTo: {
    id: string;
    seq: number;
    senderDisplayName: string;
    bodyPreview: string | null;
    deleted: boolean;
  } | null;
  reactions: Array<{ emoji: string; userId: string }>;
  /** null for text and deleted messages. */
  attachment: AttachmentDto | null;
  /** Location, contact, poll, event, call, voice-note or sticker details (null otherwise). */
  meta: MessageMeta | null;
  /** POLL: every vote (who chose which option). */
  pollVotes: Array<{ userId: string; option: number }>;
  /** EVENT: who is going. */
  eventResponses: Array<{ userId: string; response: 'GOING' | 'MAYBE' | 'NOT_GOING' }>;
  pinned: boolean;
  /** Viewer-specific; only present on per-user reads (history, search, starred list). */
  starred?: boolean;
}

export interface MessagePageDto {
  /** Ascending by seq. */
  items: MessageDto[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface PresenceDto {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ConversationMemberDto {
  user: PublicUserDto;
  role: MemberRole;
  joinedAt: string;
  lastDeliveredSeq: number;
  /** Omitted (null) when the business disabled read receipts. */
  lastReadSeq: number | null;
}

export interface ConversationSummaryDto {
  id: string;
  type: ConversationType;
  businessId: string;
  storeId: string | null;
  title: string;
  description: string | null;
  category: GroupCategory | null;
  postingPolicy: PostingPolicy;
  fileSharingPolicy: FileSharingPolicy;
  /** Who can change the group name and description. */
  editInfoPolicy: PostingPolicy;
  /** Who can add people to the group. */
  addMembersPolicy: PostingPolicy;
  /** For DIRECT conversations: the other participant. */
  counterpart: PublicUserDto | null;
  lastSeq: number;
  lastMessage: MessageDto | null;
  /**
   * Ticks for the viewer's own last message: SENT (reached the server's delivery pipeline),
   * DELIVERED (every other member's device), READ (everyone read it; only when the
   * business allows read receipts). null when the last message is not the viewer's.
   */
  lastMessageStatus: 'SENT' | 'DELIVERED' | 'READ' | null;
  lastActivityAt: string;
  unreadCount: number;
  memberCount: number;
  me: {
    role: MemberRole;
    historyFromSeq: number;
    lastReadSeq: number;
    lastDeliveredSeq: number;
    mutedUntil: string | null;
    pinnedAt: string | null;
    archivedAt: string | null;
    markedUnread: boolean;
    canPost: boolean;
    canShareFiles: boolean;
    canEditInfo: boolean;
    canAddMembers: boolean;
  };
}

/** A group both people of a direct chat belong to ("Groups in common"). */
export interface CommonGroupDto {
  id: string;
  title: string;
  memberCount: number;
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  createdAt: string;
  createdBy: PublicUserDto | null;
  members: ConversationMemberDto[];
  membersTruncated: boolean;
  readReceiptsEnabled: boolean;
}

export interface MessageInfoDto {
  messageId: string;
  recipients: Array<{
    user: PublicUserDto;
    status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ';
  }>;
}

export interface SearchResultDto {
  message: MessageDto;
  conversation: { id: string; title: string; type: ConversationType };
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    details?: Array<{ path: string; message: string }>;
  };
}

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';
