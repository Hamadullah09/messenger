# Phased Implementation Checklist

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started.
This file is updated at the end of every phase; it is the source of truth for what is
and is not production-ready.

## Phase 1 — Foundation (last verified 2026-10-10)
- ✅ Monorepo (npm workspaces), strict TypeScript, ESLint (flat config), Prettier
- ✅ Docker Compose: PostgreSQL 17, Redis 7.4, SeaweedFS (S3, not yet used by code)
- ✅ Prisma schema, initial migration with hand-written constraints, deterministic seed (fictitious data)
- ✅ Config validation at boot (Zod), structured logging (pino, redaction), request IDs
- ✅ Health: liveness + readiness (DB, Redis)
- 🟡 CI workflow written (`.github/workflows/ci.yml`) — **not yet run on GitHub** (no remote)
- 🟡 Dockerfiles for api/worker and web — not yet deployed anywhere
- ✅ Architecture docs, ADRs, threat model, runbook, deployment notes

## Phase 2 — Identity and access control
- ✅ Login (argon2id), 15-min access JWT bound to a server session, refresh rotation with reuse detection
- ✅ Brute-force protection (Redis rate limits per IP and per username + durable lockout backstop)
- ✅ TOTP MFA (setup, enable, verify, replay protection); privileged permissions require an MFA session
- ✅ Businesses, stores, users, store memberships, scoped role assignments, custom roles (API)
- ✅ Permission catalog + pure evaluator in `@storeline/shared` (25 unit tests)
- ✅ Session listing / revocation; deactivation revokes sessions and closes sockets
- ✅ Audit log for administrative and security actions; denials of privileged permissions audited
- ✅ Private contact data isolated (separate table, privileged + audited endpoint, payload tests)
- ⬜ Invitations and self-service account recovery (needs email/SMS provider — D10). Admins set a temporary password; users must change it at first sign-in.
- ⬜ Departments (table exists, no API/UI)
- ⬜ Custom role editor and role-assignment UI (API done and tested)
- ⬜ Key rotation for `DATA_ENCRYPTION_KEY` / re-encryption of MFA secrets

## Phase 3 — Core messaging
- ✅ Direct and group conversations, membership management, group admins, posting policy
- ✅ Send (idempotent by clientMessageId), reply, forward, edit (with revisions), delete-for-everyone, reactions
- ✅ Star / pin messages, mute / pin / archive / mark-unread conversations
- ✅ Transactional outbox, relay (SKIP LOCKED), BullMQ delivery workers, bounded retry, DLQ marking
- ✅ Socket.IO gateway (Redis adapter, user rooms only), delivered/read watermarks, typing, presence
- ✅ Gap-free per-conversation sequence and seq-based resync after reconnect
- ✅ Full-text message search scoped to membership and history boundary
- ✅ Web client: login + MFA, forced password change, three-pane chat (virtualised history,
  optimistic send + retry, ticks, reactions, reply/edit/delete/forward/star/pin, message info,
  in-chat search), new chat / new group, group info, settings (profile, theme, MFA, password,
  devices), admin (businesses, stores, people, audit log), help
- ✅ Integration tests: 52 tests across auth, tenancy isolation, messaging, real-time delivery, outbox recovery, privacy
- 🟡 Web client verified manually in a browser for sign-in, chat, live delivery, ticks and reactions; admin screens covered only by API tests (no UI e2e suite yet)
- ✅ UI refresh (2026-10-10): Sage-style messaging shell (sidebar with Light/Dark switch, global search with Ctrl+K, unread bell, profile menu), card-based Dashboard home with live data only, Search page, list ticks from a new `lastMessageStatus` field, responsive layouts (phone drawer + bottom tabs, tablet icon rail, two-pane chats from 1024 px, full sidebar from 1280 px), dark-mode contrast tokens
- 🟡 Presence: the `presenceEnabled` business policy is applied to lookups but not yet to live presence broadcasts
- ⬜ Starred-messages and pinned-messages list screens (API done)
- ⬜ Notification centre and browser/OS notifications
- ⬜ Admin replay endpoint for dead-lettered events (manual SQL procedure in the runbook)
- ⬜ Purge job for deleted-message revisions after the retention period (D5)
- ⬜ Automated accessibility audit (axe) and manual screen-reader pass
- ⬜ Browser end-to-end test suite (Playwright)


## Phase 4 — Media (last verified 2026-10-10)
- ✅ Upload sessions with presigned, size-bound URLs; direct browser → storage uploads
- ✅ Multipart uploads (16 MiB parts) with resume via fresh part URLs; abandoned-upload sweeper
- ✅ Type allow-list, magic-byte verification, ClamAV streaming scan (fail closed), quarantine
- ✅ Image thumbnails (EXIF stripped, decompression-bomb guard), dimensions, SHA-256
- ✅ Per-kind size limits (business policy + platform ceiling), storage quota per business
- ✅ Group file-sharing policy (everyone / admins only / off)
- ✅ Attachments on messages (caption, forward without re-upload); search covers captions and file names
- ✅ Authorized short-lived download URLs; removed members, deleted messages and other tenants get 404; sensitive-conversation downloads audited
- ✅ Web: attach button, upload tray with progress / cancel / retry, safety-check stage, photo previews + viewer, video player, document download
- ✅ Tests: 21 unit tests (signatures, file names, Content-Disposition, LIKE escaping), 15 integration tests against real SeaweedFS + ClamAV
- ⬜ Video poster frames and duration (ffmpeg in the worker)
- ⬜ HEIC previews (needs an HEVC-capable decoder)
- ⬜ Purge job for media of deleted messages after retention; storage usage report for admins
- ⬜ Malware-signature freshness alerting (freshclam status) — phase 7 monitoring
## Phase 5 — Emergency communication (last verified 2026-10-10; design: docs/architecture/emergency.md)
- ✅ Per-store emergency contacts (ordered primary / backup / …, max 5) and response time; admin UI (privileged, MFA)
- ✅ Store-aware resolution from the caller's own memberships; fallback to store managers, then business admins; reporter never alerted about their own incident
- ✅ Incidents with a dedicated EMERGENCY conversation (text, photos and files via the normal pipelines); idempotent raise; one active incident per reporter and store (a second press re-opens it and keeps the new details)
- ✅ Escalation driven by a database sweeper (survives Redis loss and worker restarts, safe with several workers); conditional transitions; ineligible people skipped; chain-exhausted state audited and logged
- ✅ Acknowledge (exactly one winner under concurrency), join, resolve with note, cancel by the reporter before acknowledgement
- ✅ Per-recipient notification states: queued → sent to gateway → delivered to device → read → acknowledged, plus failed / skipped; queuing never counts as delivery
- ✅ Timeline and audit history; live socket events for alerted people and store watchers (`incident.read`)
- ✅ Contact privacy: public profiles only in every emergency payload (tested)
- ✅ Web: Emergency help button on every screen, full-screen responder alert with sound/vibration, active-alert banner, Emergency page (status, countdown, recipients, timeline, actions), chat strip, admin Emergency tab
- ✅ Tests: 11 integration tests (resolution, contact order, escalation timing and idempotency, eligibility, acknowledgement race, isolation, idempotency/re-open/cancel, receipts, watchers) + unit tests for receipt monotonicity; live smoke script `scripts/emergency-smoke.cjs`
- 🟡 Web emergency screens type-checked, linted and compiled; the API flow was verified live against the running stack, but the screens have not yet been clicked through in a browser
- ⬜ Out-of-band channels (SMS / voice / push) for responders without an open app — needs a provider (D10)
- ⬜ OS-level notifications and service-worker alerts when the tab is closed
- ⬜ Monitoring alert on `emergency.incident.chain_exhausted` and sweep lag (phase 7)
## Phase 6 — Bulk campaigns (last verified 2026-10-11; design: docs/architecture/campaigns.md)
- ✅ Campaign drafts (idempotent), audiences by everyone / stores / groups / role filter / customers, resolved server-side within one business; counts-only preview (no recipient enumeration)
- ✅ Explicit state machine (draft → scheduled → sending ⇄ paused → completed; cancel), every transition conditional and audited
- ✅ Large-broadcast confirmation (type the exact count above 1,000), tenant campaign-size quota, MFA-gated `bulk_message.send`, store-scoped senders limited to their stores
- ✅ Worker dispatcher: durable set-based batches under SKIP LOCKED (multi-worker safe), per-tenant rate limit and round-robin fairness, expiry, eligibility re-check, per-recipient failure isolation
- ✅ Delivery into one read-only Announcements channel per recipient through the normal outbox pipeline; honest per-recipient buckets (queued / accepted / sent / delivered / read / failed / skipped / cancelled)
- ✅ Retry of failures without duplicates (re-queue + replay of dead-lettered outbox events), CSV report (formula-injection safe, audited), suppression list and customer opt-out
- ✅ Campaign attachments uploaded to the draft and verified by the media pipeline (one file, many recipients)
- ✅ Web: Campaigns page (list with progress, editor with audience picker and attachment, live delivery funnel, recipients by status, CSV export, do-not-send list), opt-out in the Announcements chat
- ✅ Tests: 9 integration tests; benchmark: 30,000 recipients in 3.9 min on a laptop (docs/operations/load-test-results.md)

## Phase 7 — Enterprise operations (last verified 2026-10-11)
- ✅ Prometheus metrics on private ports (API, worker): HTTP, sockets, messages, queues, outbox, delivery, DB, Redis, media, storage, campaigns, emergency, auth, authorization, audit — bounded labels only
- ✅ 19 alert rules (validated with promtool in CI), Grafana dashboard, local monitoring profile (docs/operations/monitoring.md)
- ✅ Optional OpenTelemetry tracing (OTLP/HTTP), verified against a local receiver
- ✅ Backup / restore scripts (checksum, optional encryption) and a restore drill that compares every table (docs/operations/restore-drill-log.md)
- ✅ Load tests (interactive messaging, 30k campaign) and resilience tests (worker crash, Redis outage, PostgreSQL restart, emergency escalation) — findings fixed: pool exhaustion, hang during a Redis outage, slow recovery
- ✅ Security review with fixes (docs/security/security-review.md); OpenTelemetry advisories resolved
- ✅ Deployment automation: release workflow (CI → images with SBOM/provenance → approval → deploy), production compose with Caddy TLS, one-shot migrate + role-sync job, health-gated deploy with automatic rollback
- 🟡 Not measured on production hardware; Alertmanager routing and on-call are environment-specific
- ⬜ PostgreSQL row-level security as defence in depth (evaluated: tenancy is enforced in the application and tested everywhere; RLS recommended before multi-region)
- ⬜ External penetration test

## Phase 8 — Desktop and mobile readiness (last verified 2026-10-11; docs/architecture/clients.md)
- ✅ Frozen v1 contract (docs/api/openapi.json, 114 operations) with a CI check that rejects removed operations
- ✅ Shared validation and domain types in @storeline/shared, usable by React Native / Electron / Tauri
- ✅ Native auth flow (refresh token in the body for Keychain/Keystore, rotation + reuse detection)
- ✅ Device registry bound to sessions; sign out one device or all other devices (sessions, sockets and push end together)
- ✅ Notification preferences with privacy-first lock-screen previews and a business policy for content
- ✅ Web Push (VAPID) with encrypted subscriptions and an SSRF allow-list; installable PWA with a service worker
- ✅ Tests: 5 integration tests, including decrypting delivered push payloads
- ⬜ FCM / APNs adapters (need provider credentials)
- ⬜ Desktop and mobile applications (separate phases)

## Known limitations and residual risks
- Release candidate, not production-certified: needs production-hardware load tests, an external security review, Alertmanager/on-call setup and FCM/APNs credentials for mobile push.
- No end-to-end encryption (ADR-0007).
- Web CSP allows inline scripts (Next.js hydration); moving to nonce-based CSP is planned.
- Prisma CLI carries a time-boxed advisory exception (docs/security/dependency-exceptions.md).
- Conversation list loads the 100 most recent chats; older chats need pagination UI.

# Unresolved Product Decisions (with recommended defaults)

| # | Decision | Recommended default (implemented unless noted) |
| --- | --- | --- |
| D1 | Can employees DM any colleague in the business, or only within shared stores? | Shared store only; Business Admins/Super Admins can DM anyone in their business. |
| D2 | Read receipts | On by default; business can disable (then only delivered ticks). |
| D3 | History for members added later / removed | New members see messages from join onward; removed members lose all access. |
| D4 | Edit / delete windows | Edit 15 min, delete-for-everyone 60 min; moderators (`message.delete`) anytime. |
| D5 | Retention of deleted content | Keep previous body in revisions for 30 days for compliance, then purge. |
| D6 | Platform operator access to content | No role grants it; break-glass workflow with dual approval (not built). |
| D7 | Right-to-erasure for departed employees | Anonymise profile after 90 days, keep messages attributed to "Former employee". Not built. |
| D8 | Last-seen / online visibility | Visible to people you share a direct conversation with; business can disable. |
| D9 | PostgreSQL RLS | Defer to phase 7 pending load-test cost. |
| D10 | Email/SMS providers for invitations, recovery, emergency out-of-band alerts | Pick provider (e.g. SES / Twilio); until then admins set initial passwords and users must change them on first login. |
| D11 | End-to-end encryption | Not offered; conflicts with admin visibility and retention (ADR-0007). |
| D12 | Customer (external) channel | Data model supports `kind=EXTERNAL`; onboarding flow and consent capture in phase 6. |
| D13 | Max group size | 5,000 members; announcement-only above 500. |
