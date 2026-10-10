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

## Open items (tracked)

- External penetration test and dependency review before production.
- Nonce-based CSP for the web app (remove `'unsafe-inline'`).
- Key rotation procedure for `DATA_ENCRYPTION_KEY` / `JWT_ACCESS_SECRET` with dual-key support.
- Web application firewall / bot protection at the edge (deployment-specific).
- Alertmanager routing and on-call configuration (environment-specific).
