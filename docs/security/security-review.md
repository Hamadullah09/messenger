# Security Review (phase 7)

Internal review on 2026-10-11 against the threat model ([threat-model.md](threat-model.md))
and the OWASP ASVS 4.0 level-2 areas relevant to this system. This is a self-review by the
development team; it is **not** an external penetration test or a compliance certification.
An independent assessment is required before production.

## Method

- Code review of authentication, authorization, tenancy, messaging, media, emergency and
  campaign modules (every endpoint checks permissions server-side; non-members get 404).
- Automated evidence: 121 API integration tests (tenant isolation, authorization denials, MFA
  gates, privacy payload assertions, IDOR attempts across tenants), 33 unit tests, 25 shared
  authorization tests, `npm audit`, header probes against a running API and web app, load and
  resilience tests (docs/operations/load-test-results.md).

## Results by area

| Area | Status | Evidence / notes |
| --- | --- | --- |
| Authentication | ✅ | argon2id; lockout + per-IP/per-username rate limits; 15-min JWT (HS256 pinned, issuer/audience checked; `alg=none` rejected → 401) bound to a revocable server session; rotating refresh tokens with reuse detection; TOTP MFA required for privileged permissions |
| Session management | ✅ | Refresh cookie `HttpOnly`, `SameSite=Strict`, `Secure` (enforced in production), path-scoped; refresh requires `X-Storeline-CSRF` (missing → 403); deactivation/revocation closes sockets |
| Access control | ✅ | Central evaluator + per-resource checks; platform roles have no implicit tenant content access (incidents, campaigns, messages); campaign audiences resolved server-side within one business |
| Input validation | ✅ | Zod on every body/query; raw SQL only through Prisma tagged templates (parameterised); no `$queryRawUnsafe` in application code |
| Output encoding | ✅ | React escaping; the only `dangerouslySetInnerHTML` is a static theme constant; CSV export neutralises formula cells |
| Privacy of contact data | ✅ | Separate table, public selects only, privileged + audited endpoint; payload tests for messaging, emergency and campaigns |
| Files | ✅ | Allow-list, magic-byte check, ClamAV (fail closed), quarantine, `Content-Disposition: attachment` + `nosniff`, short-lived signed URLs after an access re-check |
| HTTP security headers | ✅ API / 🟡 web | API: CSP `default-src 'none'`, HSTS, COOP/CORP, `nosniff`, no `X-Powered-By`. Web: CSP without third-party origins, `frame-ancestors`/`X-Frame-Options DENY`, `no-referrer`, Permissions-Policy; `script-src 'unsafe-inline'` remains for Next.js hydration (nonce-based CSP planned) |
| Rate limiting / abuse | ✅ | Login, refresh, messages (per user and per business), search, directory, uploads, emergency alerts; campaigns are privileged, MFA-gated, size-confirmed and quota-bound |
| Logging and monitoring | ✅ | Structured logs with redaction; audit log for administrative and security events; metrics on a private port with bounded labels; alert rules for auth failures and authorization-denial spikes |
| Secrets | ✅ | Validated at boot; production refuses insecure cookie/MFA settings; `.env*` files git-ignored; CI uses ephemeral values; deployment reads `.env.production` (mode 600) / secret store |
| Dependencies | 🟡 | `npm audit`: 0 critical/moderate; 3 high in the Prisma **CLI** chain (`deepmerge-ts`), accepted until 2027-01-31 ([dependency-exceptions.md](dependency-exceptions.md)) — dev/migration tooling, not reachable from requests. OpenTelemetry upgraded to 0.222 to fix 24 advisories introduced in this phase |
| Containers | ✅ | Non-root (`node`), minimal Debian slim base, production dependencies only (API image 986 MB → was 1.64 GB), health checks, SBOM + provenance in the release workflow |
| Availability | ✅ | Durable outbox; resilience tests for worker crash, Redis outage, PostgreSQL restart and emergency escalation |

## Findings fixed during this review

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High (availability) | During a Redis outage, message sends hung indefinitely (post-commit enqueue waited on a retry-forever connection) | Fail-fast producer/command connections + 2 s bound on the fast path; relay backoff capped at 5 s |
| 2 | High (availability) | Database pool exhaustion at ~30 msg/s caused 13 % 500 errors | `relationJoins`, explicit pool sizing, documentation |
| 3 | Medium | 24 OpenTelemetry advisories (incl. 2 high DoS) from an outdated pinned line | Upgraded to 0.222.x |
| 4 | Medium (operations) | Production image could not run migrations or create system roles (no seed in production) | `sma-api-migrate` image target and compiled `sync-roles` job run on every deploy |
| 5 | Medium (packaging) | Runtime image dropped workspace-local dependencies (`@opentelemetry/resources`) and shipped the web app's dependencies | Copy workspace `node_modules`; install/prune only api + shared |
| 6 | Low | CI did not pin background-timer intervals for integration tests (possible flaky races) | Intervals and `METRICS_ENABLED=false` set in CI |

## Follow-up review (2026-10-14): per-business CRM and new public surfaces

Scope: Sales & Marketing for every business (`tenantId` on every CRM table), public quote and
pay links, payment claims, website lead forms per business, lead import, store work photos,
disappearing messages, chat export, calls (one-to-one and group), map tile proxy and
follow-up reminders.

| Area | Status | Evidence / notes |
| --- | --- | --- |
| CRM tenant isolation | ✅ | Every CRM query filters by the tenant resolved server-side. `X-Business-Id` is only a hint, used only when the actor holds Sales rights granted **in** that business (platform-wide admins never open a business's CRM through it). `test/crm-tenancy.e2e-spec.ts`: listing, reading and changing another business's leads, deals, quotes, invoices, payments, subscriptions, services, targets and commission return empty/404/400; cross-business references (leads, deals, services, people) are refused |
| Public quote / pay links | ✅ | 192-bit random tokens; drafts and voided invoices not served; rate-limited per IP hash; company details from the issuing business only |
| Payment claims | ✅ | Honeypot, rate limit, at most 5 pending per invoice, amount ≤ balance; a payment is recorded only when a manager confirms |
| Website lead forms | ✅ | Business chosen by public short name; unknown or inactive businesses → 404; honeypot and per-IP rate limit |
| Lead import | ✅ fixed | 4 MB file, 2,000 rows. **Fixed:** an .xlsx is a zip, so a small file could unpack to gigabytes; the central directory is checked first (≤ 40 MB unpacked, ≤ 400 entries, no ZIP64) — `lead-import.spec.ts` |
| Store work photos | ✅ | Upload context `forOps` requires `task.work` in that store; photos readable only by people with access to the checklist run |
| Calls | ✅ | Signalling relayed only between participants of the call (group: the addressed participant's sessions); media is peer-to-peer and never stored |
| Map tiles | ✅ | Integer z/x/y validated; provider URL from configuration only (no user-controlled URL); rate-limited; bounded cache |
| Reminders | ✅ | Sent once per planned time (atomic claim); lock-screen text follows the user's preview setting and the business privacy policy |
| Dependencies | ✅ fixed | `uuid` < 11.1.1 via `exceljs` (moderate) fixed with an override; the Prisma CLI exception is unchanged |

| Online payments (JazzCash/Easypaisa) | ✅ | Merchant credentials AES-256-GCM encrypted per business, never returned; an invoice is paid only from a signed JazzCash answer (HMAC-SHA256, constant-time compare) or a server-side Easypaisa inquiry, with the amount matching; one settlement per attempt (atomic claim); form posts accepted only on the callback paths; anything unconfirmed goes to a manager (`test/online-payments.e2e-spec.ts`, `gateways.spec.ts`) |
| FBR Digital Invoicing | ✅ | PRAL token encrypted per business; billing managers only; outbound to the fixed FBR host only |
| SMA plans | ✅ | Only the platform changes plans (`business.create`, MFA); outsiders get 404 on a business's billing (`test/sma-plans.e2e-spec.ts`) |
| Data export / erasure | ✅ | Export: owners/admins with two-step login, audited, 3 a day, secrets (pay/quote tokens) left out. Erasure 30 days after deletion in one transaction; people in another business keep their account; SMA's own invoices and the audit log are kept (`test/business-data.e2e-spec.ts`) |
| Calls relay / LiveKit / errors | ✅ | TURN credentials short-lived per user (HMAC), private ranges denied in coturn; LiveKit tokens only for joined participants of a big group call; error reports carry no bodies, cookies, query strings or user details |

The external penetration test is scoped in [pentest-scope.md](pentest-scope.md).

## Open items (tracked)

- External penetration test and dependency review before production.
- Nonce-based CSP for the web app (remove `'unsafe-inline'`).
- Key rotation procedure for `DATA_ENCRYPTION_KEY` / `JWT_ACCESS_SECRET` with dual-key support.
- Web application firewall / bot protection at the edge (deployment-specific).
- Alertmanager routing and on-call configuration (environment-specific).
