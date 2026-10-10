import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Process-wide Prometheus registry (one per API or worker process). Labels are bounded,
 * low-cardinality values only: never user ids, tenant ids, message content or raw URLs
 * (routes are recorded as templates such as /api/v1/conversations/:id).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'sma_' });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const metrics = {
  httpRequests: new Counter({
    name: 'sma_http_requests_total',
    help: 'HTTP requests by method, route template and status class',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  }),
  httpDuration: new Histogram({
    name: 'sma_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  wsConnections: new Gauge({
    name: 'sma_websocket_connections',
    help: 'Open Socket.IO connections on this instance',
    registers: [registry],
  }),
  wsConnects: new Counter({
    name: 'sma_websocket_connects_total',
    help: 'Socket.IO connections accepted (reconnections included)',
    registers: [registry],
  }),
  messagesAccepted: new Counter({
    name: 'sma_messages_accepted_total',
    help: 'Messages durably accepted (persisted with an outbox event)',
    labelNames: ['kind'] as const,
    registers: [registry],
  }),
  deliveryJobs: new Counter({
    name: 'sma_delivery_jobs_total',
    help: 'Delivery jobs by event type and outcome (success, retry, dead_letter)',
    labelNames: ['type', 'outcome'] as const,
    registers: [registry],
  }),
  deliveryLatency: new Histogram({
    name: 'sma_delivery_latency_seconds',
    help: 'Outbox event creation to realtime emit',
    labelNames: ['type'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  }),
  dbQueryDuration: new Histogram({
    name: 'sma_db_query_duration_seconds',
    help: 'Database query latency as seen by the application',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  }),
  mediaProcessed: new Counter({
    name: 'sma_media_processed_total',
    help: 'Uploads verified by outcome (ready, quarantined, rejected, failed)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  mediaUploadBytes: new Counter({
    name: 'sma_media_upload_bytes_total',
    help: 'Bytes of completed uploads',
    registers: [registry],
  }),
  mediaDownloads: new Counter({
    name: 'sma_media_download_urls_total',
    help: 'Download URLs issued',
    labelNames: ['variant'] as const,
    registers: [registry],
  }),
  campaignMessages: new Counter({
    name: 'sma_campaign_messages_written_total',
    help: 'Campaign messages written to recipient channels',
    registers: [registry],
  }),
  campaignBatchDuration: new Histogram({
    name: 'sma_campaign_batch_duration_seconds',
    help: 'Duration of one campaign batch transaction',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  }),
  emergencyRaised: new Counter({
    name: 'sma_emergency_incidents_raised_total',
    help: 'Emergency alerts raised',
    registers: [registry],
  }),
  emergencyAckLatency: new Histogram({
    name: 'sma_emergency_ack_latency_seconds',
    help: 'Time from raising an emergency alert to the first acknowledgement',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  }),
  emergencyEscalations: new Counter({
    name: 'sma_emergency_escalations_total',
    help: 'Emergency escalations by result (escalated, chain_exhausted)',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  pushNotifications: new Counter({
    name: 'sma_push_notifications_total',
    help: 'Push notifications by provider and outcome (sent, gone, failed)',
    labelNames: ['provider', 'outcome'] as const,
    registers: [registry],
  }),
  authLoginFailures: new Counter({
    name: 'sma_auth_login_failures_total',
    help: 'Failed sign-in attempts (password or two-step code)',
    labelNames: ['step'] as const,
    registers: [registry],
  }),
  authzDenials: new Counter({
    name: 'sma_authz_denials_total',
    help: 'Authorization denials by permission and reason',
    labelNames: ['permission', 'reason'] as const,
    registers: [registry],
  }),
  auditEvents: new Counter({
    name: 'sma_audit_events_total',
    help: 'Audit log entries by action and outcome (administrative and security actions)',
    labelNames: ['action', 'outcome'] as const,
    registers: [registry],
  }),
};

/** Collapses a status code to its class so the label set stays small. */
export function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}
