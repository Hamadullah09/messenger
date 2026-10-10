/**
 * Emergency response shapes (docs/architecture/emergency.md). People are exposed as
 * PublicUserDto only: no email, phone or other private contact data, ever.
 */
import type { PublicUserDto } from './dto';
import type { EMERGENCY_CATEGORIES, INCIDENT_STATUSES } from './schemas/emergency';

export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Per-recipient notification state. Queued is never reported as delivered. */
export type AlertState =
  | 'PENDING'
  | 'QUEUED'
  | 'SENT_TO_GATEWAY'
  | 'DELIVERED_TO_DEVICE'
  | 'READ'
  | 'ACKNOWLEDGED'
  | 'FAILED'
  | 'SKIPPED';

export type ResponderSource = 'CONTACT' | 'STORE_MANAGER' | 'BUSINESS_ADMIN' | 'RESPONDER';

export type IncidentEventType =
  | 'CREATED'
  | 'NOTIFIED'
  | 'ESCALATED'
  | 'RECIPIENT_SKIPPED'
  | 'CHAIN_EXHAUSTED'
  | 'NOTIFY_FAILED'
  | 'JOINED'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'CANCELLED';

export interface IncidentRecipientDto {
  user: PublicUserDto;
  level: number;
  source: ResponderSource;
  state: AlertState;
  notifiedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  acknowledgedAt: string | null;
  failedAt: string | null;
}

/** Viewer-independent incident view; also the payload of emergency socket events. */
export interface IncidentDto {
  id: string;
  businessId: string;
  store: { id: string; code: string; name: string };
  conversationId: string;
  reporter: PublicUserDto;
  category: EmergencyCategory;
  description: string | null;
  status: IncidentStatus;
  level: number;
  maxLevel: number;
  ackTimeoutSeconds: number;
  ackDeadlineAt: string | null;
  chainExhaustedAt: string | null;
  acknowledgedBy: PublicUserDto | null;
  acknowledgedAt: string | null;
  resolvedBy: PublicUserDto | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** People alerted so far (later escalation levels are not listed until they are alerted). */
  recipients: IncidentRecipientDto[];
}

export interface IncidentEventDto {
  id: string;
  type: IncidentEventType;
  actor: PublicUserDto | null;
  level: number | null;
  users: PublicUserDto[];
  createdAt: string;
}

export interface IncidentViewerDto {
  isReporter: boolean;
  /** This viewer's own alert state, when they were alerted. */
  alertState: AlertState | null;
  isConversationMember: boolean;
  canRespond: boolean;
  canCancel: boolean;
}

export interface IncidentDetailDto extends IncidentDto {
  events: IncidentEventDto[];
  me: IncidentViewerDto;
}

export interface IncidentListItemDto extends IncidentDto {
  me: IncidentViewerDto;
}

export interface CreateIncidentResponseDto {
  incident: IncidentDetailDto;
  /** true when an active incident already existed and was re-opened instead. */
  existing: boolean;
}

export interface EmergencyContactDto {
  priority: number;
  user: PublicUserDto;
  /** false when the user is no longer active at the store; resolution skips them. */
  eligible: boolean;
}

export interface EmergencySettingsDto {
  storeId: string;
  ackTimeoutSeconds: number;
  contacts: EmergencyContactDto[];
  /** Who is alerted when no contact is eligible: active store managers, then business admins. */
  fallback: { storeManagers: number; businessAdmins: number };
}
