# Desktop and Mobile Readiness

Status: phase 8 — the backend and shared packages are ready for additional clients; the
desktop and mobile apps themselves are separate future phases. Tests:
`apps/api/test/devices.e2e-spec.ts` (5), `apps/api/test/openapi.e2e-spec.ts` (contract).

## Stable API contract

- REST is versioned in the path (`/api/v1`), the realtime namespace too (`/v1`).
- The v1 contract is committed as [`docs/api/openapi.json`](../api/openapi.json) (114
  operations). `test/openapi.e2e-spec.ts` fails CI when an operation is **removed** (breaking:
  ship a `/v2` instead) and when anything else changes without regenerating the snapshot
  (`UPDATE_OPENAPI=1 npx vitest run --project integration test/openapi.e2e-spec.ts`), so every
  contract change is reviewed.
- Compatibility rules for v1: only additive changes (new endpoints, new optional request
  fields, new response fields, new enum values that clients must tolerate as "unknown").
  Clients must ignore unknown fields and events.
- Realtime events are hints; clients resync over REST by `seq` after reconnecting
  (docs/architecture/messaging.md), so a client that misses or does not understand an event
  stays correct.

## Shared code

`@storeline/shared` contains every request schema (Zod), DTO, permission key, the
authorization evaluator, the socket event contract (`ServerToClientEvents`,
`ClientToServerEvents`) and the push payload (`PushPayload`). It has no Node- or DOM-specific
dependencies, so a React Native or Electron/Tauri client imports it directly for typed calls
and identical client-side validation. The server remains the authority for every rule.

## Authentication for native clients

| | Web (browser) | Native (desktop / mobile) |
| --- | --- | --- |
| Opt-in | — | Header `X-SMA-Client: native` on login, MFA verify and refresh |
| Access token | Memory, 15 min | Memory, 15 min |
| Refresh token | `HttpOnly`, `SameSite=Strict` cookie (never visible to JS) | Returned in the response body; store in Keychain (iOS/macOS), Keystore (Android), Credential Manager / libsecret (desktop) |
| Refresh call | Cookie + `X-Storeline-CSRF: 1` | `POST /auth/refresh` with `{ "refreshToken": "…" }` |

Refresh tokens rotate on every use; replaying a used token ends the whole session (reuse
detection), for native clients exactly as for the web. Browsers cannot opt into body tokens
from another origin (the header is not CORS-allowed).

## Devices and sessions

- After every sign-in a client calls `POST /devices` (`platform`, `name`, `appVersion`). A
  device is bound 1:1 to its session.
- `GET /devices` lists the caller's signed-in devices; `DELETE /devices/:id` signs one out;
  `DELETE /me/sessions` signs out **every other** device. Revocation ends the session, closes
  its sockets on every API instance and removes its push registration in the same transaction.
- Password changes and admin deactivation already revoke sessions; their devices stop
  receiving notifications immediately.

## Notifications

- Preferences (`GET/PUT /notifications/preferences`): `pushEnabled` and the lock-screen
  `preview` — `NONE` (default: "New message"), `SENDER`, or `CONTENT`. Content appears only
  when the business allows it (`policy.pushContentAllowed`, default off); otherwise it is
  reduced to `SENDER`. Emergency alerts always notify registered devices.
- Registration: `PUT /devices/current/push` with `WEB_PUSH` (a browser `PushSubscription`),
  `FCM` or `APNS` token; `GET /notifications/config` says which providers this server supports
  and returns the VAPID public key. Tokens are encrypted at rest (AES-256-GCM, bound to the
  device id) and de-duplicated per physical device.
- Delivery (worker, queue `push`): after a message is emitted, people who are **not
  connected**, have not muted the chat, have not read it and have push enabled get a
  notification on each registered device; emergency alerts go to every alerted person's
  devices with high urgency. Expired subscriptions (404/410) are removed; failures are recorded
  per device and never block other devices. Metric: `sma_push_notifications_total`.
- **Implemented provider:** Web Push (VAPID, RFC 8030/8291/8292) with an SSRF guard: HTTPS only,
  allow-listed push-service hosts (`WEB_PUSH_ALLOWED_HOSTS`).
- **Not yet implemented:** FCM and APNs adapters (they need provider credentials). The server
  reports them as unsupported and refuses registrations for them, so nothing is silently
  dropped. Adding one = implementing `PushGateway.send` for that provider.
- The web app is an installable PWA (manifest + service worker `public/sw.js`), so desktop
  users get OS notifications today without a native app.

## Building the clients (next phases)

| Client | Suggested stack | Reuses |
| --- | --- | --- |
| Desktop | Tauri or Electron wrapping the web app, native notifications through Web Push or the OS API | Web UI, native token flow, devices API |
| Mobile | React Native (Expo) | `@storeline/shared`, native token flow, devices API, FCM/APNs adapters (to add), socket.io-client |

Each client is a separate, testable phase: no core business logic needs to change.
