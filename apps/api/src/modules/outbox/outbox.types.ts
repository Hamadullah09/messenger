/** Outbox event types and payloads. Payloads carry ids only; consumers re-read current state. */
export type OutboxEventPayloads = {
  'message.created': { messageId: string };
  'message.updated': { messageId: string };
  'conversation.updated': { conversationId: string };
  'conversation.removed': { conversationId: string; userIds: string[] };
  'session.revoked': { sessionIds: string[]; reason: string };
  'media.uploaded': { mediaId: string };
  /** Alert these users now (initial alert or escalation). */
  'emergency.notify': { incidentId: string; level: number; userIds: string[] };
  'emergency.updated': { incidentId: string };
};

export type OutboxEventType = keyof OutboxEventPayloads;

export const OUTBOX_EVENT_TYPES = [
  'message.created',
  'message.updated',
  'conversation.updated',
  'conversation.removed',
  'session.revoked',
  'media.uploaded',
  'emergency.notify',
  'emergency.updated',
] as const satisfies readonly OutboxEventType[];

export const DELIVERY_QUEUE = 'delivery';
/** Verification (signature + malware scan + thumbnails) runs on its own queue and concurrency. */
export const MEDIA_QUEUE = 'media';

export function queueFor(type: OutboxEventType): typeof DELIVERY_QUEUE | typeof MEDIA_QUEUE {
  return type.startsWith('media.') ? MEDIA_QUEUE : DELIVERY_QUEUE;
}

/** Push notifications to offline devices (external push services; separate from delivery). */
export const PUSH_QUEUE = 'push';

export type PushJobData =
  | { kind: 'message'; messageId: string; userIds: string[] }
  | { kind: 'emergency'; incidentId: string; userIds: string[] };

export const PUSH_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2000, jitter: 0.3 },
  removeOnComplete: { age: 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export const MEDIA_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5000, jitter: 0.3 },
  removeOnComplete: { age: 3600, count: 10_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;

export interface DeliveryJobData {
  outboxId: string;
}

export const DELIVERY_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  removeOnComplete: { age: 3600, count: 10_000 },
  // Failed jobs are the dead-letter set; keep them for inspection and replay.
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;
