import type {
  ActivityOutcome,
  FollowUpKind,
  LeadActivityType,
  LeadDirection,
  LeadSource,
  LeadStage,
} from '@storeline/shared';

export const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  PROPOSAL: 'Proposal sent',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

/** Colour per funnel stage (dot / bar / chip). */
export const STAGE_TONE: Record<LeadStage, { dot: string; chip: string }> = {
  NEW: { dot: 'bg-sky-500', chip: 'bg-sky-500/12 text-sky-700 dark:text-sky-300' },
  CONTACTED: {
    dot: 'bg-indigo-500',
    chip: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
  },
  QUALIFIED: {
    dot: 'bg-violet-500',
    chip: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  },
  PROPOSAL: { dot: 'bg-amber-500', chip: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  NEGOTIATION: {
    dot: 'bg-orange-500',
    chip: 'bg-orange-500/15 text-orange-800 dark:text-orange-300',
  },
  WON: { dot: 'bg-emerald-500', chip: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' },
  LOST: { dot: 'bg-zinc-400', chip: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300' },
};

export const SOURCE_LABEL: Record<LeadSource, string> = {
  WEBSITE: 'Website',
  COLD_CALL: 'Cold call',
  REFERRAL: 'Referral',
  SOCIAL_MEDIA: 'Social media',
  EMAIL_CAMPAIGN: 'Email campaign',
  EVENT: 'Event or exhibition',
  WALK_IN: 'Walk-in',
  PARTNER: 'Partner',
  ADVERTISEMENT: 'Advertisement',
  OTHER: 'Other',
};

export const ACTIVITY_LABEL: Record<LeadActivityType, string> = {
  CREATED: 'Lead created',
  NOTE: 'Note',
  CALL: 'Call',
  EMAIL: 'Email',
  MEETING: 'Meeting',
  WHATSAPP: 'WhatsApp message',
  STAGE_CHANGED: 'Stage changed',
  ASSIGNED: 'Assignment',
  CONVERTED: 'Became an SMA customer',
};

export function money(value: number | null | undefined, currency = 'PKR'): string {
  if (value === null || value === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString()}`;
  }
}

export const DIRECTION_LABEL: Record<LeadDirection, string> = {
  INBOUND: 'Inbound',
  OUTBOUND: 'Outbound',
};

export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  NO_ANSWER: 'No answer',
  CALL_BACK_LATER: 'Call back later',
  MEETING_BOOKED: 'Meeting booked',
  NEEDS_MORE_INFO: 'Needs more information',
  WRONG_CONTACT: 'Wrong number / contact',
};

export const OUTCOME_TONE: Record<ActivityOutcome, string> = {
  INTERESTED: 'text-success',
  MEETING_BOOKED: 'text-success',
  NOT_INTERESTED: 'text-danger',
  WRONG_CONTACT: 'text-danger',
  NO_ANSWER: 'text-warning',
  CALL_BACK_LATER: 'text-warning',
  NEEDS_MORE_INFO: 'text-muted',
};

export const FOLLOW_UP_LABEL: Record<FollowUpKind, string> = {
  MEETING: 'Meeting',
  CALL: 'Call',
  VISIT: 'Visit',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  OTHER: 'Follow-up',
};

/** The activity to log when a planned follow-up is done. */
export const FOLLOW_UP_ACTIVITY: Record<
  FollowUpKind,
  'CALL' | 'MEETING' | 'WHATSAPP' | 'EMAIL' | 'NOTE'
> = {
  MEETING: 'MEETING',
  VISIT: 'MEETING',
  CALL: 'CALL',
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  OTHER: 'NOTE',
};
