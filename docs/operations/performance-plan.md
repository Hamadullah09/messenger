# Performance and Load-Testing Plan

## Workload model (baseline, to be validated with the business)

| Parameter | Baseline | Peak / safety target |
| --- | --- | --- |
| Outbound messages | 30,000/day (~0.35/s avg) | 50 msg/s sustained for 15 min (≈ 140× average) |
| Fan-out deliveries | avg group 12 ⇒ ~360k deliveries/day | 2,000 deliveries/s |
| Concurrent sockets | 2,000 | 10,000 |
| Largest group | 500 members | 5,000 (announcement channel) |
| Campaign | 30,000 recipients | 100,000 recipients |
| Reconnect storm | — | 5,000 sockets reconnecting within 30 s |
| Media | 5 concurrent 200 MB uploads/store | 200 concurrent multipart uploads |

## Initial SLOs (measured separately)

| SLI | Boundary | Objective |
| --- | --- | --- |
| Send acceptance latency | API receive → 201 | p95 < 150 ms, p99 < 400 ms |
| Delivery latency (online recipient) | 201 → `message.created` at client | p95 < 1 s, p99 < 3 s |
| Outbox lag | commit → enqueue | p99 < 2 s |
| Emergency alert delivery | incident commit → first contact device | p99 < 3 s |
| Availability | `/health/ready` + send endpoint | 99.9 % monthly |
| Message loss | accepted messages never retrievable | 0 |

No delivery-time guarantee is claimed until these are measured on representative
infrastructure.

## Tooling

- **k6** (HTTP + `k6/experimental/websockets`) for send/receive journeys; scripts in
  `tests/load/` (phase 7).
- **Artillery Socket.IO engine** for reconnect storms.
- Metrics: Prometheus scrape of api/worker (`/metrics`), Postgres `pg_stat_statements`,
  Redis `INFO`, BullMQ queue counts.

## Scenarios

1. Steady state at baseline for 1 h — verify no queue growth, stable memory.
2. Peak burst: 50 msg/s for 15 min into groups of 12–500.
3. Announcement: 1 msg to a 5,000-member group every 10 s.
4. Campaign: 100k recipients with tenant fairness while scenario 1 runs for a second tenant.
5. Worker kill -9 during 3 and 4 — recovery time and duplicate rate (must be 0 visible duplicates).
6. Redis restart — sends continue, delivery resumes, lag drains.
7. Postgres failover (managed) — error budget consumption and recovery.
8. Reconnect storm — 5,000 clients reconnect and sync by `seq`.
9. Media: 200 concurrent 200 MB multipart uploads; API RSS must stay flat.
10. Abuse: oversized payloads, cross-tenant IDs, socket event floods.

## Exit criteria

All SLOs met at peak with ≥ 30 % headroom on CPU, DB connections, and Redis memory; zero
lost messages; DLQ empty after recovery scenarios.
