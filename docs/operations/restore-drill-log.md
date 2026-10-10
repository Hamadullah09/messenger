# Restore drill log

Produced by `scripts/ops/restore-drill.sh` (backup → restore into a new database → compare every table's row count → `prisma migrate status`).

| When (UTC) | Source | Backup size | Restored | Backup time | Restore time | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-10T18:32Z | storeline | 126129 B | 32 tables / 358 rows | 1 s | 3 s | PASS |
