# Load and Resilience Test Results

How to run: [load-testing.md](load-testing.md). All numbers below were measured on
**2026-10-10/11** on a developer laptop — 4 CPU cores, Windows 10, Docker Desktop (WSL2) —
with PostgreSQL 17, Redis 7.4, one API process, one worker process **and the load generator
all on the same machine**. They show the system's behaviour and relative capacity; they are
not production capacity figures. Re-run on production-like hardware before go-live.

## Targets

| Workload (from the requirements) | Average rate | Measured capacity on the laptop |
| --- | --- | --- |
| 30,000 outbound messages / day | 0.35 msg/s | 40 msg/s sustained interactive (≈ 3.4 M/day) |
| Business-wide announcement | — | 30,000 recipients delivered in 3.9 minutes |

## 1. Interactive messaging (`scripts/load/message-load.cjs`)

100 users online over Socket.IO, 10 groups of 10, 40 messages/s for 60 s (2,400 messages,
21,600 deliveries). Rate chosen just under the per-business limit (3,000/min).

| Run | Sent | Errors | HTTP accept p50 / p95 / p99 | End-to-end delivery p50 / p95 / p99 | Lost |
| --- | --- | --- | --- | --- | --- |
| Before fixes | 2,079 / 2,400 (29.7 msg/s) | 321 × 500 | 11.4 s / 14.2 s / 14.4 s | 8.1 s / 10.3 s / 10.4 s | 0 |
| **After fixes** | **2,400 / 2,400 (39.9 msg/s)** | **0** | **253 ms / 703 ms / 872 ms** | **251 ms / 704 ms / 874 ms** | **0** |

Findings and fixes:

1. **Connection-pool exhaustion.** Each send used ~30 queries; with Prisma's default pool
   (2 × CPU + 1 = 9 connections) requests queued until `Unable to start a transaction in the
   given time` (500). Fixes: Prisma `relationJoins` (each `include` is one SQL query instead
   of one per relation — the message DTO load went from ~6 queries to 1) and an explicit pool
   size (`connection_limit=20`, documented for production).
2. No message accepted by the API was lost; every accepted message reached every member.

## 2. Campaign throughput (`scripts/load/campaign-benchmark.cjs`)

One campaign to 30,000 recipients through the real API and worker; "written" = every
recipient's message persisted (SENT), "emitted" = every message emitted by the delivery
workers (SENT_TO_GATEWAY).

| Configuration | Written | Emitted | Failed |
| --- | --- | --- | --- |
| Defaults (batch 200, round 1 s), 1 worker | 194 s (154 msg/s) | 235 s (128 msg/s) | 0 |
| Batch 1,000, round 250 ms, 1 worker | 129 s (233 msg/s) | 234 s (128 msg/s) | 0 |
| Batch 1,000, round 250 ms, 2 workers | 153 s (196 msg/s) | 209 s (144 msg/s) | 0 |

Before the set-based write path (one round trip per statement per recipient), 1,000
recipients took over 30 s; the batch path writes a batch with a constant number of statements.
On this machine the delivery stage (≈130–145 msg/s) is the limit and a second worker adds
little because PostgreSQL, Redis and both workers share 4 cores; on separate hosts delivery
scales with worker replicas (each job is independent).

## 3. Resilience (`scripts/resilience/resilience.cjs`)

| Scenario | Result | Detail |
| --- | --- | --- |
| Worker crash (SIGKILL) while users send | PASS | 20/20 accepted while down; delivered 3.2 s after restart; no duplicates |
| Redis outage | PASS | 10/10 sends accepted during the outage; delivered 2.9 s after Redis returned |
| Emergency escalation during a worker outage | PASS | Escalated 4.0 s after the worker restarted |
| PostgreSQL restart | PASS | Readiness reported not-ready during the outage; ready 0.5 s after restart; 10/10 sends OK |

Findings and fixes:

1. **Sends hung during a Redis outage** (first run): the post-commit fast path awaited a BullMQ
   enqueue on a connection that retries forever, so the request never returned even though
   the message was already safe in PostgreSQL. Fix: queue producers and best-effort Redis
   commands use fail-fast connections, and the fast path has a 2 s bound; the outbox relay
   delivers later. Sends during the outage then took milliseconds instead of ~12 s each.
2. **Slow recovery after Redis returned** (31 s): the relay's backoff grew to 30 s. Capped at
   5 s → delivery resumed 2.9 s after recovery.

## Proposed service-level objectives

| SLO | Objective | Alert |
| --- | --- | --- |
| API availability (non-5xx) | 99.9 % monthly | `SmaHighErrorRate` (> 2 % for 5 min) |
| Message accept latency | p95 < 500 ms at normal load | `SmaHighLatency` |
| Delivery latency (accept → emit) | p95 < 2 s | `SmaDeliveryLatency` |
| Outbox backlog | oldest pending < 30 s | `SmaOutboxBacklog` |
| Emergency escalation | within deadline + 30 s | `SmaEmergencyEscalationOverdue` |
| Campaign | 30,000 recipients in < 10 min | `SmaCampaignStalled` |
