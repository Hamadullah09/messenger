# ADR-0002: Transactional outbox for every cross-user side effect

Status: Accepted (2026-10-10)

## Context
Publishing to Redis/BullMQ after a DB commit can lose events if the process crashes in
between; publishing before commit can announce data that is rolled back.

## Decision
Every state change that must reach other users inserts an `OutboxEvent` row in the same
transaction. After commit the API makes a best-effort enqueue (BullMQ `jobId` = outbox
id) for low latency; a relay in the worker polls `PENDING` rows with
`FOR UPDATE SKIP LOCKED` every second as the guaranteed path. Consumers are idempotent.
Retries use exponential backoff with jitter, bounded attempts, then the BullMQ failed set
(DLQ) plus `Message.state = FAILED` and an alert. Admin replay re-enqueues the same
outbox id, so no duplicate visible message is created.

## Consequences
+ No silent loss between commit and publish. + Delivery survives Redis outages.
− At-least-once delivery: clients must dedupe by message id (they do).
