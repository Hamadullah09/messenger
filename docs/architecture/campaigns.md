# Bulk Campaigns

Status: implemented in phase 6. Code: `apps/api/src/modules/campaigns`,
`apps/web/src/app/(app)/campaigns`, `apps/web/src/components/campaigns`. Tests:
`apps/api/test/campaigns.e2e-spec.ts` (9 integration tests). Load results:
[../operations/load-test-results.md](../operations/load-test-results.md).

## What a campaign is

An announcement from an authorized administrator to a segment of **one business**. Each
recipient receives it as an ordinary message in their own read-only **Announcements**
channel (`Conversation.type = BROADCAST`, one per recipient and business, keyed by
`channelKey = businessId:userId`). This means:

- recipients get it through the normal durable pipeline (outbox → BullMQ → user rooms), with
  normal resync after reconnect, search, forwarding and attachments;
- delivery and read state come from the channel watermarks — the same honest
  device-confirmed signals as chat ticks;
- the sender's chat list is not flooded, and recipients cannot reply (posting is admin-only
  and the sender is not a member);
- 30,000 recipients are 30,000 independent rows, never one transaction or one socket broadcast.

## Who can send

`bulk_message.send` (privileged → MFA required). Business-scoped holders can target the
whole business; store-scoped holders (custom roles) only their stores and groups in them,
and only see their own campaigns. Platform-wide grants are ignored: a platform admin cannot
message a tenant's people. Report export additionally needs `report.export`.

## Audience

Resolved on the server with one SQL statement (`campaign-audience.ts`):

```
segments (union): everyone | storeIds | groupIds (all must belong to the business)
→ active users with an ACTIVE business membership, INTERNAL (EXTERNAL only with includeCustomers)
→ optional role filter (system role keys held in this business)
→ sender's store scope (store-scoped senders)
→ minus the creator
→ suppression list / opt-outs → counted as "suppressed", recorded as SKIPPED
```

The preview endpoint returns **counts only**, never names (no recipient enumeration). The
recipient list and CSV are available to campaign managers after sending, with public
profiles only (no contact data).

## State machine

```
DRAFT ──send──────────────▶ SENDING ⇄ PAUSED
  │  └─schedule─▶ SCHEDULED ─(due, worker)─▶ SENDING ──(no PENDING left)──▶ COMPLETED
  │                 └─unschedule─▶ DRAFT              COMPLETED ─retry-failed─▶ SENDING
  └──────────── cancel (from DRAFT / SCHEDULED / SENDING / PAUSED) ─▶ CANCELLED
```

Every transition is a conditional update (`WHERE status IN (...)`) and audited
(`campaign.created/updated/scheduled/unscheduled/started/paused/resumed/cancelled/retried/completed`,
`campaign.report.exported`, suppression changes, opt-outs).

Sending checks: content present; attachment `READY` and uploaded to this campaign; audience
valid; at least one recipient; at most `TenantQuota.maxCampaignSize`; and when the audience is
larger than `LARGE_CAMPAIGN_THRESHOLD` (1,000) the request must carry
`confirmRecipientCount` equal to the current count (a 409 tells the client the number).

## Dispatch (worker)

`CampaignWorker` runs `CampaignDispatcher.runOnce()` every `CAMPAIGN_DISPATCH_INTERVAL_MS`:

1. Due `SCHEDULED` campaigns become `SENDING`.
2. `SENDING` campaigns are served **one batch per business per round**, least recently served
   first (round-robin fairness: one tenant's 100k campaign cannot starve another's 50).
3. Batch size = `min(CAMPAIGN_BATCH_SIZE, TenantQuota.messagesPerMinute × interval / 60 s)` —
   the per-tenant rate limit.
4. A batch is one transaction under `SELECT … FOR UPDATE SKIP LOCKED` on the campaign row, so
   several worker replicas can run safely:
   - first batch: snapshot the audience into `BulkCampaignRecipient` rows (`INSERT … SELECT`);
   - recipients past `expiresAt` → `SKIPPED (expired)`;
   - re-check eligibility and suppression at send time → `SKIPPED`;
   - attachment no longer `READY` → `FAILED (attachment_unavailable)` (never sent without it);
   - create missing channels, then **set-based writes**: one `UPDATE … RETURNING` allocates the
     next `seq` of every channel in the batch (row locks keep seq order = commit order,
     ADR-0003), then `createMany` for messages, attachments and outbox events, and one
     `UPDATE … FROM unnest(...)` marks recipients `SENT`;
   - when no `PENDING` rows remain → `COMPLETED`.
5. After commit the outbox events are dispatched (fast path); the relay guarantees the rest.

If a batch fails, it is retried one recipient at a time; a recipient that still fails is
marked `FAILED (write_failed)` so one bad row never blocks everyone. A crash mid-batch rolls
back and the batch is simply picked up again (no duplicates: `PENDING` rows only).

## Reporting

Mutually exclusive buckets per recipient:

| Bucket | Meaning |
| --- | --- |
| QUEUED | Not processed yet |
| ACCEPTED | Message stored in their channel, not yet emitted |
| SENT_TO_GATEWAY | Worker emitted it to their realtime room (not proof of delivery) |
| DELIVERED | Their device confirmed receipt (watermark) |
| READ | They opened it (only when the business has read receipts on) |
| FAILED | Write failed, or delivery dead-lettered after retries |
| SKIPPED | Suppressed, opted out, expired, or no longer eligible |
| CANCELLED | Not sent because the campaign was cancelled |

`POST /campaigns/:id/retry-failed` re-queues `FAILED` recipients and replays dead-lettered
deliveries from their **original** outbox event (removing the dead BullMQ job), so a retry
never creates a second visible message.

CSV export (`GET /campaigns/:id/report.csv`): username, display name, status, reason,
processed time; streamed in 5,000-row chunks; cells that look like formulas are prefixed to
prevent spreadsheet injection; audited with the row count.

## Consent

- `CampaignSuppression` (per business): admins add/remove people (`ADMIN`).
- Customers (external users) can turn announcements off/on themselves (`SELF_OPT_OUT`), from the
  Announcements chat; admins cannot remove someone's own opt-out. Staff announcements cannot
  be opted out of by staff.

## API

| Method | Path |
| --- | --- |
| GET | `/businesses/:businessId/campaigns` |
| POST | `/campaigns` (idempotent by `clientCampaignId`) |
| GET / PATCH | `/campaigns/:id` (edit drafts only) |
| GET | `/campaigns/:id/preview` (counts only) |
| POST | `/campaigns/:id/send`, `/schedule`, `/unschedule`, `/pause`, `/resume`, `/cancel`, `/retry-failed` |
| GET | `/campaigns/:id/recipients?status=&cursor=`, `/campaigns/:id/report.csv` |
| GET / POST / DELETE | `/businesses/:businessId/campaign-suppressions[/:userId]` |
| GET / PUT | `/businesses/:businessId/announcements/opt-out` (self) |
| POST | `/media/uploads` with `campaignId` (attachments for draft campaigns) |

## Limitations

- Group pickers in the web editor list the groups the sender belongs to (the API accepts any
  group of the business for business-wide senders).
- Per-tenant rate limiting is per worker round; with several workers the effective rate can
  briefly exceed the quota by up to one batch per worker.
- Campaigns are in-app only (no SMS/e-mail/push channel yet).
