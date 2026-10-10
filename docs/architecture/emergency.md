# Emergency Help: Contact Privacy and Escalation

Status: implemented in phase 5 (2026-10-10). Code: `apps/api/src/modules/emergency`,
`apps/web/src/components/emergency`, `apps/web/src/app/(app)/emergency`. Tests:
`apps/api/test/emergency.e2e-spec.ts` (11 integration tests) and `emergency-rules.spec.ts`.

> **Safety scope.** This feature alerts people inside the business (store contacts,
> managers, admins). It does **not** contact police, fire or ambulance services and is not a
> substitute for them; the UI says so before every alert and again when nobody responds.

## Privacy model

- Private email and phone live in `UserContact`, a separate table that ordinary queries
  never join (ADR-0006). Every emergency DTO is built from `publicUserSelect`
  (`id, username, displayName, kind, status`); the emergency module never reads
  `UserContact`.
- An emergency contact is a **pointer** (`EmergencyContact{storeId, userId, priority}`).
  Pressing "Emergency help" resolves to user ids and display names only, and the reporter
  talks to responders inside an `EMERGENCY` conversation, so the manager's phone number and
  email are never revealed — not even once the conversation is open.
- The caller never chooses who is alerted: the store comes from their own active
  memberships, and the chain from the store's settings.
- Audit metadata records ids, levels and counts — never descriptions or contact values.
- Tests assert that no REST response or socket payload in the emergency flow contains the
  seeded contact email or phone, alongside `test/privacy.e2e-spec.ts` for messaging.

## Data model

| Table | Purpose |
| --- | --- |
| `EmergencyContact` | Ordered contacts per store (`priority` 1 = primary, 2 = backup …, max 5). Composite FK to `Store(businessId, id)`. |
| `Store.emergencyAckTimeoutSeconds` | Time each level has to acknowledge (15–1800 s, default 120; CHECK constraint). |
| `EmergencyIncident` | One alert: reporter, store, category, description, `status`, current `level`, `maxLevel`, `ackDeadlineAt`, who acknowledged/resolved. Unique (`reporterId`, `clientIncidentId`) for idempotency; partial unique index allows **one active incident per reporter and store**. |
| `EmergencyIncidentRecipient` | The escalation chain snapshot and **per-recipient notification state** (see below), with timestamps for each transition. |
| `EmergencyIncidentEvent` | Append-only timeline (`seq` gives a total order): CREATED, NOTIFIED, ESCALATED, RECIPIENT_SKIPPED, CHAIN_EXHAUSTED, NOTIFY_FAILED, JOINED, ACKNOWLEDGED, RESOLVED, CANCELLED. |

Each incident owns an `EMERGENCY` conversation (reporter + alerted responders, full history
for everyone who joins), so photos and messages use the normal messaging and media pipelines.

## Resolution

```
caller → active StoreMemberships (membership, store and business ACTIVE)
  ├─ 0 stores  → 409 (no store team to alert)
  ├─ 1 store   → that store
  └─ n stores  → client must pass storeId (400 on storeId otherwise);
                 a storeId that is not one of the caller's stores → 404
emergency.trigger must cover that store.

chain (snapshotted on creation; the reporter is never in their own chain):
  configured contacts in priority order, one level each, skipping anyone who is not
  ACTIVE, INTERNAL and an active member of the store
  └─ none eligible → one level with every active STORE_MANAGER of the store
  + final level: the business's BUSINESS_ADMINs
  └─ chain empty → 409 "No one is set up to receive emergency alerts…" (audited as FAILURE)
```

## Incident and escalation flow

```mermaid
sequenceDiagram
  autonumber
  participant E as Employee
  participant API as api
  participant DB as PostgreSQL
  participant W as worker
  participant M1 as Level 1
  participant M2 as Level 2

  E->>API: POST /emergency/incidents {storeId?, category, description?, clientIncidentId}
  API->>DB: tx: chain snapshot; EMERGENCY conversation; incident (OPEN, level 1, ackDeadlineAt);<br/>recipients (level 1 QUEUED, others PENDING); system + description messages; outbox
  API-->>E: 201 {incident, existing:false}  (public profiles only)
  W-->>M1: emergency.alert_created (full-screen alert) → recipient SENT_TO_GATEWAY
  M1->>API: POST …/receipt {DELIVERED} (device got it), {READ} (opened)
  alt M1 acknowledges in time
    M1->>API: POST …/acknowledge → ACKNOWLEDGED (conditional on OPEN/ESCALATED)
  else deadline passes
    W->>DB: sweeper: lock row (SKIP LOCKED) where status awaiting, level = 1, deadline passed
    W->>DB: level 2, new deadline, add M2 to the conversation, outbox
    W-->>M2: emergency.alert_created ("Escalated to you")
  end
```

**Why a database sweeper instead of delayed BullMQ jobs:** the deadline lives in
`EmergencyIncident.ackDeadlineAt`, and the worker scans for overdue rows every
`EMERGENCY_SWEEP_INTERVAL_MS` (default 5 s). Escalation therefore survives Redis data loss,
worker restarts and missed jobs (threat T20), and several worker replicas can run safely:
each transition locks the row with `FOR UPDATE SKIP LOCKED` and is conditional on
(`status`, `level`, deadline). Duplicate or late sweeps are no-ops. Worst-case escalation
latency is the deadline plus one sweep interval.

Incident states: `OPEN → ESCALATED (level n)* → ACKNOWLEDGED → RESOLVED`;
`OPEN/ESCALATED → CANCELLED` (only the reporter, only before anyone acknowledges);
`OPEN/ESCALATED → RESOLVED` is also allowed. When every level has been alerted without an
acknowledgement, `chainExhaustedAt` is set, sweeping stops, the incident stays open and
visible to everyone alerted and to store watchers, and an audit FAILURE plus an error log
are written (alert on this in production monitoring).

Concurrent acknowledgements: the update is conditional, so exactly one wins; the others get
`200` with the winner shown (`acknowledgedBy`). Acknowledging a closed incident is `409`.

## Notification states (per recipient)

| State | Meaning | Set by |
| --- | --- | --- |
| `PENDING` | Later escalation level, not alerted yet | creation |
| `QUEUED` | Alert committed with an outbox event | API / sweeper |
| `SENT_TO_GATEWAY` | Worker emitted it to the user's realtime room | worker |
| `DELIVERED_TO_DEVICE` | A signed-in client of that user confirmed receipt | `POST …/receipt {DELIVERED}` |
| `READ` | They opened the incident | `POST …/receipt {READ}` |
| `ACKNOWLEDGED` | They pressed "I'm responding" | acknowledge |
| `FAILED` | Delivery job exhausted its retries (`gateway_unavailable`) | worker dead-letter |
| `SKIPPED` | No longer eligible at escalation time | sweeper |

Queuing never marks an alert delivered. Receipts are monotonic (never move backwards) and
only update the caller's own row. A responder who is offline gets the alert on next sign-in
or reconnect: the client loads active incidents and shows any alert addressed to them that
is not yet acknowledged.

## Who sees what

| Person | Sees the incident | Can respond (acknowledge / join / resolve) | Gets |
| --- | --- | --- | --- |
| Reporter | yes | no (can cancel before acknowledgement) | `emergency.incident_updated` |
| Alerted recipient | yes | yes | `emergency.alert_created` + updates |
| Holder of `incident.read` at the store or business (e.g. Security, Store Manager, Business Admin) | yes (list, detail, timeline) | with `incident.acknowledge` | `emergency.incident_updated` + banner |
| Anyone else, other tenants, platform admins | 404 | — | — |

Platform-wide (`SUPER_ADMIN`) coverage is deliberately ignored: incidents are tenant data.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/emergency/stores` | Stores where the caller can raise an alert |
| POST | `/emergency/incidents` | Raise (idempotent; re-opens an active one and appends new details) |
| GET | `/emergency/incidents?active=&storeId=&cursor=&limit=` | Visible incidents, newest first, with `me` |
| GET | `/emergency/incidents/:id` | Detail, recipients, timeline, `me` |
| POST | `/emergency/incidents/:id/acknowledge` | Responder; idempotent |
| POST | `/emergency/incidents/:id/join` | Responder joins the conversation without acknowledging |
| POST | `/emergency/incidents/:id/resolve` | `{note?}` |
| POST | `/emergency/incidents/:id/cancel` | Reporter, before acknowledgement |
| POST | `/emergency/incidents/:id/receipt` | `{state: DELIVERED \| READ}`, 204 |
| GET/PUT | `/emergency/stores/:storeId/settings` | `emergency_contact.manage` (privileged, MFA): `{ackTimeoutSeconds, contactUserIds[]}` |

Rate limit: 10 new incidents per user per 10 minutes (retries with the same
`clientIncidentId` and re-opening an active incident do not count).

## Web client

- Red **Emergency help** button in the top bar on every screen (`SOS` on phones), and on the
  Emergency page. The dialog asks for the store (only if the person works at several), a
  category and an optional description, and states that it does not call emergency services.
- Alerted responders get a full-screen alert dialog with a repeating tone and vibration
  (mutable; browsers may block sound until the page has been used once), "I'm responding" and
  "View details".
- A red banner shows incidents still waiting for a response to the reporter and store
  watchers. The Emergency page lists incidents and shows status, an escalation countdown,
  who was alerted with honest delivery wording, the timeline, and the actions.
- Admin → Emergency: order contacts, set the response time, see the fallback.

## Limitations

- **In-app only.** No SMS, voice, e-mail or mobile push gateway is integrated, so a responder
  with no signed-in device is only reached through escalation to the next level. The
  per-recipient state model and the private `UserContact` data are ready for an out-of-band
  channel worker (phase 8 / decision D10).
- Browser tab must be open for the alert sound; there are no OS-level notifications yet.
- The chain is snapshotted when the alert is raised; contacts changed afterwards apply to the
  next alert (people who become ineligible are skipped).
