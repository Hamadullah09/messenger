# ADR-0004: Fan out to server-resolved user rooms, not client-joined conversation rooms

Status: Accepted (2026-10-10)

## Context
Conversation rooms joined by clients drift from DB membership (a removed member's
socket may remain in the room on another node), which is an information-disclosure risk.

## Decision
Sockets join only `user:{id}` and `session:{id}`, assigned by the server at handshake.
The delivery worker resolves the *current active members* from PostgreSQL for every
event and emits to their user rooms through the Redis emitter.

## Consequences
+ Membership removal is effective for the next event with no room bookkeeping.
+ Clients cannot subscribe to arbitrary conversations.
− One DB membership read per delivered event (indexed; cached per job batch).
