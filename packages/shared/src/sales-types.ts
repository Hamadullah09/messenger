import type { PublicUserDto } from './dto';
import type {
  ActivityOutcome,
  LeadActivityKind,
  LeadDirection,
  LeadSource,
  LeadStage,
} from './schemas/sales';

export interface LeadDto {
  id: string;
  companyName: string;
  contactName: string;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  storeCount: number | null;
  estimatedValue: number | null;
  currency: string;
  source: LeadSource;
  direction: LeadDirection;
  sourceDetail: string | null;
  stage: LeadStage;
  /** When the lead entered its current stage, and how many whole days ago that was. */
  stageChangedAt: string;
  daysInStage: number;
  /** Open, and too long in this stage or without any activity. */
  stuck: boolean;
  callCount: number;
  messageCount: number;
  meetingCount: number;
  lastOutcome: ActivityOutcome | null;
  lostReason: string | null;
  notes: string | null;
  owner: PublicUserDto | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string;
  /** Set once the lead became an SMA customer business. */
  customer: { businessId: string; businessName: string; convertedAt: string } | null;
  createdAt: string;
}

export type LeadActivityType =
  LeadActivityKind | 'CREATED' | 'STAGE_CHANGED' | 'ASSIGNED' | 'CONVERTED';

export interface LeadActivityDto {
  id: string;
  type: LeadActivityType;
  body: string | null;
  outcome: ActivityOutcome | null;
  fromStage: LeadStage | null;
  toStage: LeadStage | null;
  actor: PublicUserDto | null;
  createdAt: string;
}

export interface LeadDetailDto extends LeadDto {
  activities: LeadActivityDto[];
}

export interface SalesContextDto {
  /** SMA's internal sales team (a hidden business that holds the team's chats). */
  teamBusinessId: string;
  teamGroupId: string | null;
  canSeeAll: boolean;
  canAssign: boolean;
  canConvert: boolean;
  canManageTeam: boolean;
}

export interface SalesOverviewDto {
  byStage: Record<LeadStage, number>;
  bySource: Array<{ source: LeadSource; total: number; won: number }>;
  byOwner: Array<{ owner: PublicUserDto | null; open: number; won: number; lost: number }>;
  openPipelineValue: number;
  wonThisMonth: number;
  wonValueThisMonth: number;
  /** Won ÷ (won + lost), 0–1; null before any lead closed. */
  winRate: number | null;
  followUpsDue: number;
  newThisWeek: number;
  /** Open leads that are not moving. */
  stuck: number;
  byDirection: Record<LeadDirection, { total: number; won: number }>;
  callsLogged: number;
  messagesLogged: number;
}

export interface SalesUserDto extends PublicUserDto {
  roleKey: 'SALES_MANAGER' | 'SALES_AGENT';
  openLeads: number;
  wonLeads: number;
}
