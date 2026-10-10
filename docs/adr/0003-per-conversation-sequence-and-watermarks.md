# ADR-0003: Gap-free per-conversation sequence numbers and receipt watermarks

Status: Accepted (2026-10-10)

## Decision
`Conversation.lastSeq` is incremented with `UPDATE ... SET lastSeq = lastSeq + 1
RETURNING` inside the send transaction. The row lock serialises writers in a
conversation, so `seq` order equals commit order and is gap-free (a rolled-back
transaction releases its increment). Clients detect missed events by gaps and resync
from the DB. Delivery/read state per recipient is stored as `lastDeliveredSeq` /
`lastReadSeq` on the membership row.

## Consequences
+ Exact missed-message recovery; O(1) receipt writes regardless of group size;
  unread count = `lastSeq - max(lastReadSeq, historyFromSeq)`.
− Writes to one conversation are serialised (fine: a single chat cannot realistically
  exceed hundreds of msgs/s). Very large announcement channels use a single writer anyway.
