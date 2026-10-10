# REST API Outline — `/api/v1`

Live OpenAPI: `GET /api/docs` (non-production) and `GET /api/docs-json`.

Conventions:

- JSON only, `Content-Type: application/json`, body limit 256 KB (media goes to storage).
- Auth: `Authorization: Bearer <access JWT>` except `/auth/login`, `/auth/refresh`,
  `/auth/mfa/verify`, `/health/*`.
- Errors: `{ "error": { "code": "FORBIDDEN", "message": "...", "requestId": "..." } }`.
  Codes: `VALIDATION_FAILED 400`, `UNAUTHENTICATED 401`, `MFA_REQUIRED 403`,
  `FORBIDDEN 403`, `NOT_FOUND 404`, `CONFLICT 409`, `RATE_LIMITED 429`, `INTERNAL 500`.
- Pagination: cursor-based `?cursor=&limit=` (max 100) returning `{items, nextCursor}`;
  messages use `?beforeSeq=` / `?afterSeq=`.
- Idempotency: message send uses `clientMessageId`; campaign and incident creation use
  `Idempotency-Key` / `clientIncidentId`.
- Every response carries `X-Request-Id`.

| Module | Endpoints | Phase |
| --- | --- | --- |
| Health | `GET /health/live`, `GET /health/ready` | 1 |
| Auth | `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/mfa/setup`, `POST /auth/mfa/enable`, `POST /auth/password` (change) | 2 |
| Me / sessions | `GET /me`, `PATCH /me`, `GET /me/sessions`, `DELETE /me/sessions/:id` | 2 |
| Businesses | `GET/POST /businesses`, `GET/PATCH /businesses/:id`, `POST /businesses/:id/suspend`, `/reactivate`, `/archive` | 2 |
| Stores | `GET/POST /businesses/:id/stores`, `GET/PATCH /stores/:id`, `POST /stores/:id/archive` | 2 |
| Users | `GET/POST /businesses/:id/users`, `GET/PATCH /users/:id`, `POST /users/:id/deactivate`, `POST /users/:id/reactivate`, `POST /users/:id/sessions/revoke`, `PUT /users/:id/stores` | 2 |
| Roles | `GET /businesses/:id/roles`, `POST /businesses/:id/roles`, `GET /permissions`, `POST /users/:id/role-assignments`, `DELETE /role-assignments/:id` | 2 |
| Directory | `GET /directory?query=` (users the caller may message) | 3 |
| Conversations | `GET /conversations`, `POST /conversations/direct`, `POST /conversations/groups`, `GET/PATCH /conversations/:id`, `POST /conversations/:id/members`, `DELETE /conversations/:id/members/:userId`, `PATCH /conversations/:id/members/:userId` (admin), `PATCH /conversations/:id/me` (mute, pin, archive, mark unread) | 3 |
| Messages | `GET /conversations/:id/messages`, `POST /conversations/:id/messages`, `PATCH /messages/:id`, `DELETE /messages/:id`, `PUT/DELETE /messages/:id/reaction`, `POST /messages/:id/forward`, `PUT/DELETE /messages/:id/star`, `PUT/DELETE /messages/:id/pin`, `GET /messages/:id/info`, `GET /messages/starred`, `GET /search/messages?q=` | 3 |
| Media | `POST /media/uploads`, `POST /media/uploads/:id/parts` (resume), `POST /media/uploads/:id/complete`, `DELETE /media/uploads/:id`, `GET /media/:id`, `GET /media/:id/url?variant=original\|thumbnail`; messages accept `mediaId` | 4 ✅ |
| Emergency | `GET /emergency/stores`, `POST/GET /emergency/incidents`, `GET /emergency/incidents/:id`, `POST .../acknowledge`, `.../join`, `.../resolve`, `.../cancel`, `.../receipt`, `GET/PUT /emergency/stores/:storeId/settings` (see docs/architecture/emergency.md) | 5 ✅ |
| Campaigns | `GET /businesses/:id/campaigns`, `POST /campaigns`, `GET/PATCH /campaigns/:id`, `GET /campaigns/:id/preview`, `POST .../send`, `/schedule`, `/unschedule`, `/pause`, `/resume`, `/cancel`, `/retry-failed`, `GET .../recipients`, `GET .../report.csv`, `/businesses/:id/campaign-suppressions`, `/businesses/:id/announcements/opt-out` (docs/architecture/campaigns.md) | 6 ✅ |
| Devices & notifications | `POST/GET /devices`, `DELETE /devices/:id`, `PUT/DELETE /devices/current/push`, `GET /notifications/config`, `GET/PUT /notifications/preferences`, `DELETE /me/sessions` (all others); native clients send `X-SMA-Client: native` (docs/architecture/clients.md) | 8 ✅ |

The complete, machine-readable v1 contract is [openapi.json](openapi.json).
| Notifications | `GET /notifications`, `POST /notifications/read`, `GET/PUT /me/notification-preferences` | 6 |
| Audit | `GET /audit?businessId=&action=&actorId=&from=&to=` | 2 |
| Admin / ops | `GET /admin/queues`, `GET /admin/outbox/failed`, `POST /admin/outbox/:id/replay`, `GET/PUT /admin/config` | 7 |

Compatibility policy: additive changes within `v1`; breaking changes ship as `v2` with a
minimum 6-month overlap and a `Deprecation` + `Sunset` header on old routes.
