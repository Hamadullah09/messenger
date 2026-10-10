/**
 * Generates infrastructure/monitoring/grafana/dashboards/sma-overview.json from a compact
 * panel list, so the dashboard stays reviewable. Run: node scripts/monitoring/build-dashboard.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ds = { type: 'prometheus', uid: 'sma-prometheus' };
const rows = [
  [
    'Traffic and errors',
    [
      [
        'API requests / s by status',
        'sum by (status) (rate(sma_http_requests_total[5m]))',
        'reqps',
      ],
      [
        'API p95 latency by route (top 10)',
        'topk(10, histogram_quantile(0.95, sum by (le, route) (rate(sma_http_request_duration_seconds_bucket[5m]))))',
        's',
      ],
      [
        '5xx error ratio',
        'sum(rate(sma_http_requests_total{status="5xx"}[5m])) / clamp_min(sum(rate(sma_http_requests_total[5m])), 1e-9)',
        'percentunit',
      ],
      [
        'WebSocket connections / reconnects per min',
        ['sum(sma_websocket_connections)', 'sum(rate(sma_websocket_connects_total[5m])) * 60'],
        'short',
      ],
    ],
  ],
  [
    'Messaging pipeline',
    [
      ['Messages accepted / s', 'sum by (kind) (rate(sma_messages_accepted_total[5m]))', 'ops'],
      [
        'Delivery p95 latency (accept → emit)',
        'histogram_quantile(0.95, sum by (le, type) (rate(sma_delivery_latency_seconds_bucket[5m])))',
        's',
      ],
      ['Delivery jobs by outcome', 'sum by (outcome) (rate(sma_delivery_jobs_total[5m]))', 'ops'],
      ['Queue depth', 'sum by (queue, state) (sma_queue_jobs)', 'short'],
      [
        'Outbox backlog / oldest (s)',
        ['sma_outbox_pending', 'sma_outbox_oldest_pending_seconds', 'sma_outbox_failed'],
        'short',
      ],
    ],
  ],
  [
    'Emergency and campaigns',
    [
      [
        'Emergency alerts waiting / overdue (s)',
        ['sma_emergency_awaiting_ack', 'sma_emergency_overdue_seconds'],
        'short',
      ],
      [
        'Emergency acknowledgement p50 / p95',
        [
          'histogram_quantile(0.5, sum by (le) (rate(sma_emergency_ack_latency_seconds_bucket[1h])))',
          'histogram_quantile(0.95, sum by (le) (rate(sma_emergency_ack_latency_seconds_bucket[1h])))',
        ],
        's',
      ],
      ['Escalations', 'sum by (result) (increase(sma_emergency_escalations_total[1h]))', 'short'],
      [
        'Campaign messages / s and queued recipients',
        ['sum(rate(sma_campaign_messages_written_total[5m]))', 'sma_campaign_pending_recipients'],
        'short',
      ],
    ],
  ],
  [
    'Data stores and media',
    [
      [
        'DB query p95 / connections',
        [
          'histogram_quantile(0.95, sum by (le) (rate(sma_db_query_duration_seconds_bucket[5m])))',
          'sma_db_connections',
        ],
        'short',
      ],
      ['Redis up / ping (s)', ['sma_redis_up', 'sma_redis_ping_seconds'], 'short'],
      [
        'Media verification outcomes',
        'sum by (outcome) (increase(sma_media_processed_total[1h]))',
        'short',
      ],
      [
        'Upload throughput (bytes/s) / downloads',
        [
          'sum(rate(sma_media_upload_bytes_total[5m]))',
          'sum(rate(sma_media_download_urls_total[5m]))',
        ],
        'short',
      ],
      [
        'Storage used / max tenant quota ratio',
        ['sma_storage_bytes', 'sma_tenant_storage_usage_ratio_max'],
        'short',
      ],
    ],
  ],
  [
    'Security',
    [
      [
        'Failed sign-ins / min',
        'sum by (step) (rate(sma_auth_login_failures_total[5m])) * 60',
        'short',
      ],
      [
        'Authorization denials / min',
        'sum by (reason) (rate(sma_authz_denials_total[5m])) * 60',
        'short',
      ],
      [
        'Administrative actions (1h)',
        'topk(15, sum by (action) (increase(sma_audit_events_total[1h])))',
        'short',
      ],
    ],
  ],
];

const panels = [];
let id = 1;
let y = 0;
for (const [title, items] of rows) {
  panels.push({
    id: id++,
    type: 'row',
    title,
    collapsed: false,
    gridPos: { h: 1, w: 24, x: 0, y },
  });
  y += 1;
  items.forEach(([name, exprs, unit], i) => {
    const list = Array.isArray(exprs) ? exprs : [exprs];
    panels.push({
      id: id++,
      type: 'timeseries',
      title: name,
      datasource: ds,
      gridPos: { h: 8, w: 12, x: (i % 2) * 12, y: y + Math.floor(i / 2) * 8 },
      fieldConfig: { defaults: { unit }, overrides: [] },
      options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
      targets: list.map((expr, j) => ({
        refId: String.fromCharCode(65 + j),
        datasource: ds,
        expr,
      })),
    });
  });
  y += Math.ceil(items.length / 2) * 8;
}

const dashboard = {
  uid: 'sma-overview',
  title: 'SMA — Operations overview',
  tags: ['sma'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '30s',
  time: { from: 'now-6h', to: 'now' },
  panels,
};
const out = path.join(
  __dirname,
  '..',
  '..',
  'infrastructure',
  'monitoring',
  'grafana',
  'dashboards',
  'sma-overview.json',
);
fs.writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`wrote ${panels.length} panels to ${path.relative(process.cwd(), out)}`);
