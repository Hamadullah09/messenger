# Alpha Test Report

**Date:** 2026-10-11 · **Build:** all eight phases · **Result: PASS** (after fixes listed below)

## Scope and method

Alpha testing exercised the complete product the way users do: a real browser (Microsoft Edge,
headless, via Playwright) against the **production build** of the web app, the API, the worker,
PostgreSQL, Redis, SeaweedFS (S3) and ClamAV running locally. Each run creates its own
"Alpha QA …" tenant (two stores; admin with two-step verification, store manager with private
contact details, security, two employees, one employee at the second store) with a password
generated inside the test process. Suite: `e2e/` — run with `npm run test:alpha` (needs the
stack running and the web app on :3000; see below).

| # | Scenario | Roles | Result |
| --- | --- | --- | --- |
| 1 | Wrong password shows one generic error | — | ✅ |
| 2 | Employee lands on the dashboard; navigation and Emergency help visible; no admin features | Employee | ✅ |
| 3 | Admin signs in with a two-step code; Campaigns and Emergency setup visible | Admin | ✅ |
| 4 | New chat → live message → reply in real time → photo upload, safety scan (ClamAV), delivery and caption | 2 employees | ✅ |
| 5 | Emergency: raise (category + description) → security sees the banner → manager gets the full-screen alert on another screen → "I'm responding" → reporter sees "Help is on the way" live → conversation → resolve with note; **no contact details in any page** | Employee, manager, security | ✅ |
| 6 | Emergency setup: order contacts, response time, save | Admin | ✅ |
| 7 | Campaign: draft → counts-only preview (5 people) → confirm → completed → employee receives it in a read-only Announcements chat → CSV export (no contact data) → do-not-send list | Admin, employee | ✅ |
| 8 | Settings: notification preferences persist; another signed-in browser is signed out remotely and lands on the sign-in page | Employee (2 browsers) | ✅ |
| 9–11 | Sign-in, dashboard, chats, emergency, settings, campaigns, people, emergency setup at **phone (390 px), tablet (820 px) and desktop (1440 px)**, light and dark: no horizontal scrolling, SOS and bottom tabs on phones; **axe-core WCAG 2 A/AA scan** on every page | All | ✅ 0 critical, 0 serious |

38 screenshots per run are written to `e2e/results/screens/` for visual review; an HTML report
is in `e2e/report/`.

## Defects found and fixed

| # | Severity | Found by | Defect | Fix |
| --- | --- | --- | --- | --- |
| A1 | High | Alpha (admin sign-ins) | The two-step limit was keyed by **IP address** and counted successful sign-ins: in an office behind one public IP, the 6th person to sign in within 5 minutes was locked out ("Too many attempts") | Limits per sign-in attempt (5 guesses per MFA token, each attempt now has a unique token id), per user (10 failed codes / 15 min — blocks brute force even with a correct code) and a generous per-IP ceiling (60 / 5 min); regression test added |
| A2 | Medium | Alpha (responsive) | On phones, the dashboard's Recent conversations overflowed horizontally once message previews were long | Grid items constrained (`grid-cols-1`, `minmax(0,1fr)`) across all responsive grids |
| A3 | Low | Alpha (axe) | Copyright text on the sign-in brand panel had 4.48:1 contrast (needs 4.5:1) | Full-white text (≈ 5.2:1) |
| A4 | — | Alpha | First visit to a page on the **development** server took up to 70 s to compile, making flows look stuck | Not a product defect; alpha runs use the production build (`next build && next start`) |

Earlier verification in phases 6–7 also found and fixed: database pool exhaustion under load,
a hang on message send during a Redis outage, slow recovery after Redis returned, a runtime image
missing a dependency, and outdated OpenTelemetry packages (see load-test-results.md and
security-review.md).

## Totals

| Layer | Tests | Result |
| --- | --- | --- |
| Shared (authorization evaluator, schemas) | 25 unit | ✅ |
| API unit | 33 | ✅ |
| API integration (real PostgreSQL, Redis, S3, ClamAV, worker) | 95 | ✅ |
| Alpha (browser, production build) | 11 scenarios | ✅ |
| Load / resilience | 3 load runs, 4 resilience scenarios | ✅ (see load-test-results.md) |

## Known limitations (not defects)

- Push notifications in the browser were verified at the API level (encrypted payloads decrypted
  in tests); a real browser subscription needs internet access to the browser vendor's push
  service and was not exercised by the headless alpha run.
- Mobile push (FCM/APNs) and native desktop/mobile apps are future phases.
- Alpha tenants ("Alpha QA …") accumulate in the development database; reset it with
  `npm run db:reset -w @storeline/api && npm run db:seed -w @storeline/api` when needed.
- Production-hardware load tests and an external security review are still required before
  general availability.

## Running the alpha suite

```bash
docker compose up -d
npm run build -w @storeline/api && npm run build -w @storeline/web
npm run start -w @storeline/api &      # API :4000
npm run start:worker -w @storeline/api &
npm run start -w @storeline/web &      # web :3000 (production build)
npm run test:alpha
```
