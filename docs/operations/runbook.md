# Operations Runbook

> Metrics export, dashboards and alert rules are phase 7 work. Until then the signals below
> are read from logs and database/Redis queries.

## Health

- `GET /api/v1/health/live` — process is up.
- `GET /api/v1/health/ready` — PostgreSQL and Redis reachable (2 s timeout each). 503 otherwise.
  Neither endpoint exposes versions, hostnames or error details.

## Key signals and what to do

| Signal | How to check | Action |
| --- | --- | --- |
| Outbox backlog | `SELECT count(*), min("createdAt") FROM "OutboxEvent" WHERE status='PENDING';` | Pending rows older than ~5 s: check worker replicas are running and Redis is reachable. Rows are retried with backoff, never dropped. |
| Dead-lettered deliveries | `SELECT * FROM "OutboxEvent" WHERE status='FAILED' ORDER BY "createdAt" DESC LIMIT 50;` and BullMQ failed set of queue `delivery` | Inspect `lastError`. After fixing the cause, set the row back to `PENDING` (`UPDATE "OutboxEvent" SET status='PENDING', attempts=0 WHERE id=...`) and remove the failed job; the relay re-enqueues it with the same id (no duplicate messages). Messages remain readable by recipients via sync even while FAILED. |
| Messages stuck in ACCEPTED | `SELECT count(*) FROM "Message" WHERE state='ACCEPTED' AND "createdAt" < now() - interval '1 minute';` | Same as outbox backlog. |
| Media stuck in VERIFYING | `SELECT count(*) FROM "MediaAsset" WHERE status='VERIFYING' AND "updatedAt" < now() - interval '10 minutes';` | Usually ClamAV down or still loading signatures (`docker exec … clamdcheck.sh`). Jobs retry with backoff, then the asset becomes FAILED and the uploader is told to retry. Never bypass the scanner. |
| Quarantined uploads | Audit `action='media.quarantined'` (metadata has the signature name) | Objects are kept under `quarantine/`; review with the security team before deleting. Check whether the uploader's device is compromised. |
| Login abuse | Audit log `action='auth.login' AND outcome='FAILURE'`, rate-limit 429s in API logs | Rate limits and lockout apply automatically; block offending IPs at the edge if sustained. |
| Authorization denials | Audit `action='authz.denied'` | Investigate repeated denials for the same actor (possible probing). |

## Emergency alerts

- **Escalation runs in the worker** (`EmergencySweeper`, every `EMERGENCY_SWEEP_INTERVAL_MS`).
  If no worker is running, alerts are still saved and shown to the first level, but nothing
  escalates. Keep at least one worker up at all times; several replicas are safe.
- **Overdue alerts** (should be empty):
  `SELECT id, level, "ackDeadlineAt" FROM "EmergencyIncident" WHERE status IN ('OPEN','ESCALATED') AND "ackDeadlineAt" < now() - interval '1 minute';`
  Rows here mean the sweeper is not running or failing — check worker logs for
  `Emergency sweep failed`.
- **Nobody responded**: audit action `emergency.incident.chain_exhausted` (outcome FAILURE) and
  the error log `Emergency alert unacknowledged after the whole escalation chain`. Page the
  business contact; the incident remains open and visible in the app.
- **Alerts not delivered**: recipients in state `FAILED` (`gateway_unavailable`) mean the
  delivery job exhausted its retries (Redis/socket fan-out problem). Escalation continues
  regardless, because it does not depend on delivery.
- **Store with nobody to alert**: audit action `emergency.incident.no_contact`. Ask the business
  admin to set contacts in Admin → Emergency, or assign a store manager.
- Live check against a running stack with demo data: `node scripts/emergency-smoke.cjs`.

## Security incidents

- **Compromised account:** `POST /api/v1/users/:id/deactivate` (revokes all sessions and
  closes sockets immediately), then rotate the password with the user.
- **Suspected token theft:** reuse of a refresh token already revokes the session
  automatically (`revokeReason = 'refresh_token_reuse'`). Review sessions for the user.
- **Compromised `JWT_ACCESS_SECRET`:** rotate the secret and restart the API; all access tokens
  become invalid within one deploy, and clients obtain new ones with their refresh cookie.
- **Compromised `DATA_ENCRYPTION_KEY`:** MFA secrets must be re-enrolled. Key rotation with
  re-encryption is not implemented yet (tracked in roadmap).

## Backup and restore

Full procedure: [backup-restore.md](backup-restore.md).

- Managed PostgreSQL: daily snapshots + point-in-time recovery (≥ 7 days), encrypted.
- Logical, encrypted off-site copies: `scripts/ops/backup.sh` (pg_dump custom format,
  SHA-256 checksum, optional AES-256 with `BACKUP_PASSPHRASE_FILE`).
- Restore into a **new** database: `scripts/ops/restore.sh <backup> <new_db>` (verifies the
  checksum, refuses to overwrite an existing database).
- Drill: `scripts/ops/restore-drill.sh` backs up, restores into a scratch database, compares
  every table's row count and checks migrations; results in
  [restore-drill-log.md](restore-drill-log.md). Run monthly and after schema changes.
- Redis holds no system-of-record data (queues are rebuilt from the outbox; presence and rate
  limits are ephemeral), so losing Redis delays delivery but loses no messages (verified by the
  resilience test).
- Media: versioned, encrypted bucket with cross-region replication; database rows reference
  object keys, so a database restore must use the same (or a replicated) bucket.

## Alerts → actions

Rules: `infrastructure/monitoring/alerts.yml`. Dashboard: Grafana "SMA — Operations overview".

| Alert | First steps |
| --- | --- |
| SmaApiDown / SmaWorkerDown | Check the container/process logs and restart; with no worker, deliveries, media checks, campaigns and **emergency escalation** stop. |
| SmaRedisDown | Restore Redis. Sends keep being accepted; delivery resumes within seconds of recovery. |
| SmaOutboxBacklog / SmaDeliveryDeadLetters | See "Key signals" above; check Redis and worker logs; replay dead letters after fixing the cause. |
| SmaQueueBacklog / SmaDeliveryLatency | Add worker replicas; check database latency. |
| SmaEmergencyEscalationOverdue | **Page immediately.** The sweeper is not running: start a worker. |
| SmaEmergencyUnanswered | Contact the business; the incident remains open in the app. |
| SmaCampaignStalled | Check worker logs for "Campaign batch failed"; pause the campaign if it is failing. |
| SmaHighErrorRate / SmaHighLatency / SmaDbSlowQueries / SmaDbConnectionsHigh | Check recent deploys (roll back), database load and pool sizing (load-testing.md). |
| SmaMediaVerificationBacklog / SmaMalwareQuarantined | ClamAV health; quarantined files → security review. |
| SmaLoginFailureSpike / SmaAuthorizationDenialSpike | Security incident procedure below; block abusive IPs at the edge. |

## Disaster recovery targets

RPO ≤ 5 minutes (managed PITR), RTO ≤ 1 hour. The local drill restores a `~126 KB` development
database in ~3 s; production timing must be measured with a production-sized snapshot.
