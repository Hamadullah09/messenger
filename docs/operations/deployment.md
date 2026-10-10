# Deployment

## Topology

| Component | Image / service | Scaling | Notes |
| --- | --- | --- | --- |
| `api` | `infrastructure/docker/api.Dockerfile`, `node dist/main.js` | Horizontal, stateless | Behind a TLS-terminating load balancer. WebSocket-only transport, so no sticky sessions are needed. |
| `worker` | same image, `node dist/worker.js` | Horizontal | Outbox relay uses `FOR UPDATE SKIP LOCKED`; delivery uses BullMQ concurrency 16 per replica. |
| `web` | `infrastructure/docker/web.Dockerfile` | Horizontal | Proxies `/api/*` to the API (`API_ORIGIN`) so the refresh cookie stays first-party. |
| PostgreSQL 17 | Managed (RDS / Cloud SQL / Azure Flexible Server) | Primary + standby | Encryption at rest, PITR enabled. |
| Redis 7 | Managed, persistence on | Single primary + replica | `maxmemory-policy noeviction` (BullMQ requirement). |
| Object storage | S3 / R2 | — | Private bucket, Block Public Access on, SSE enabled, CORS limited to the web origins (PUT/GET/HEAD), lifecycle rules: abort incomplete multipart uploads after 1 day, expire `incoming/` after 2 days. |
| ClamAV (clamd) | `clamav/clamav:1.4` | 1+ replicas next to workers | `StreamMaxLength`/`MaxFileSize`/`MaxScanSize` above `MEDIA_PLATFORM_MAX_MB`, `AlertExceedsMax yes`, freshclam enabled. Workers fail closed if it is down. |

## Configuration

All configuration comes from environment variables validated at boot
(`apps/api/src/infra/config/config.ts`). Production refuses to start with
`COOKIE_SECURE=false` or `MFA_REQUIRED_FOR_PRIVILEGED=false`. Secrets
(`JWT_ACCESS_SECRET`, `DATA_ENCRYPTION_KEY`, database and Redis URLs) must come from the
platform secret store, never from files in the image. Set `TRUST_PROXY_HOPS` to the number of
proxies in front of the API so rate limits see real client IPs. Set `OPENAPI_ENABLED=false`
unless the docs endpoint is protected.

## Release procedure (automated)

`.github/workflows/release.yml` runs on a `v*` tag: CI (reused) → build and push
`sma-api`, `sma-api-migrate` and `sma-web` to GHCR with SBOM and build provenance →
**manual approval** on the `production` environment → `scripts/ops/deploy.sh <tag>` on the
host over SSH. The single-host topology is `infrastructure/deployment/compose.prod.yaml`
(Caddy with automatic TLS → api replicas / web; PostgreSQL, Redis with `noeviction` and AOF,
ClamAV); for larger installations use managed PostgreSQL/Redis/S3 and the same images.

`deploy.sh`: pull → `migrate` job → `up --wait` api/worker/web → health gate on
`/api/v1/health/ready` → on failure, roll back to the previous tag automatically.

Manual equivalent:

1. CI green on the commit (lint, format, typecheck, unit + integration tests, build, audit).
2. Build and push images tagged with the commit SHA.
3. **Migrate:** run the `sma-api-migrate` image once (`prisma migrate deploy` + `node
   dist/cli/sync-roles.js`, which keeps the system roles in sync — production has no seed)
   before rolling out. Migrations must be backward compatible with the previous release
   (expand → migrate → contract across two releases).
4. Roll out `worker`, then `api`, then `web` (rolling update, readiness gate on
   `GET /api/v1/health/ready`).
5. Watch error rate, outbox lag and DLQ size for 15 minutes.

## Rollback

Redeploy the previous image tag. Because migrations are expand-only within a release, the
previous version runs against the new schema. Never roll back a migration that dropped data;
contract migrations ship a release after the code that stopped using the column.

## Graceful shutdown

Both processes handle SIGTERM: the API stops accepting connections and closes sockets
(clients reconnect to another replica and resync by `seq`); the worker stops the relay loop
and waits for in-flight BullMQ jobs. Allow a 30 s termination grace period.
