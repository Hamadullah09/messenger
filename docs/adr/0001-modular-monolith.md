# ADR-0001: Modular monolith with a separate worker process

Status: Accepted (2026-10-10)

## Context
The baseline load (30k outbound messages/day, millions/month) is modest for a single
well-indexed PostgreSQL and a few Node processes. The hard problems are correctness
(tenant isolation, delivery durability, privacy), not raw scale.

## Decision
One NestJS codebase (`apps/api`) with two entrypoints: `main.ts` (HTTP + Socket.IO) and
`worker.ts` (outbox relay, delivery, escalation, campaigns, media scanning). Both scale
horizontally and independently. Module boundaries (`src/modules/*`) are kept explicit
so messaging, media, and campaigns can be extracted later if measurements justify it.

## Consequences
+ One deployment artifact, shared types, transactional consistency without distributed
  transactions. + Workers scale separately from request handling.
− Requires discipline to keep module boundaries; a lint rule is planned.
