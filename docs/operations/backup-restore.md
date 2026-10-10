# Backup and Restore

## What must be backed up

| Data | System of record | Backup |
| --- | --- | --- |
| Users, tenants, messages, incidents, campaigns, audit log | PostgreSQL | Managed snapshots + PITR (≥ 7 days) **and** encrypted logical dumps off-site |
| Files (photos, videos, documents) | Object storage | Bucket versioning + cross-region replication; lifecycle keeps non-current versions 30 days |
| Queues, presence, rate limits | Redis | Not backed up: rebuilt from the outbox / ephemeral |
| Secrets (`JWT_ACCESS_SECRET`, `DATA_ENCRYPTION_KEY`, …) | Secret store | Secret-store backup. **Losing `DATA_ENCRYPTION_KEY` makes stored MFA secrets unreadable** (users must re-enrol). |

## Scripts

```bash
# Logical backup (custom format) + SHA-256; encrypted when a passphrase file is given.
DATABASE_URL=postgresql://... BACKUP_PASSPHRASE_FILE=/run/secrets/backup-key scripts/ops/backup.sh /backups
# Local stack: PG_CONTAINER=storeline-postgres-1 PGUSER=storeline PGDATABASE=storeline scripts/ops/backup.sh

# Restore into a NEW database (never over an existing one), verifying the checksum first.
BACKUP_PASSPHRASE_FILE=/run/secrets/backup-key PGHOST=... PGUSER=... scripts/ops/restore.sh /backups/sma-<stamp>.dump.enc sma_restored

# Drill: backup → restore → compare every table's row count → prisma migrate status.
scripts/ops/restore-drill.sh
```

Schedule `backup.sh` (e.g. every 6 hours, keep 14 days locally and 90 days off-site in a
separate account with object lock). Encrypted dumps use AES-256-CBC with PBKDF2
(200,000 iterations); keep the passphrase in the secret store, not next to the backups.

## Restoring production

1. Declare an incident; stop writes if the data is corrupt (scale `api` and `worker` to 0).
2. Restore the snapshot / PITR target **into a new instance** (or `restore.sh` into a new DB).
3. Run the migrate job against it (`sma-api-migrate`) — it is a no-op when already current.
4. Verify: `prisma migrate status`, row counts of key tables against expectations, sign in to
   a staging API pointed at it.
5. Point `DATABASE_URL` at the restored database and scale up. Clients resync by `seq`.
6. Media referenced by restored rows must exist in the bucket: restore the bucket versions to
   the same point in time if objects were deleted.
7. Record RTO/RPO in the incident report.

## Drill results

See [restore-drill-log.md](restore-drill-log.md). The encrypted path was verified on
2026-10-10: the dump is ciphertext (`Salted__` header), restore refuses to run without the
key and succeeds with it.
