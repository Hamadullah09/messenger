#!/usr/bin/env bash
# Logical PostgreSQL backup (pg_dump custom format) with a SHA-256 checksum and optional
# encryption. Usage:
#   DATABASE_URL=postgresql://... scripts/ops/backup.sh [output-dir]
#   PG_CONTAINER=storeline-postgres-1 PGUSER=storeline PGDATABASE=storeline scripts/ops/backup.sh
# Optional: BACKUP_PASSPHRASE_FILE=/run/secrets/backup-key  → AES-256 encrypted .dump.enc
# Production: run on a schedule (see docs/operations/backup-restore.md) and copy the output to
# separate, versioned, encrypted storage in another region.
set -euo pipefail

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/sma-${STAMP}.dump"

if [[ -n "${PG_CONTAINER:-}" ]]; then
  docker exec "$PG_CONTAINER" pg_dump -U "${PGUSER:?PGUSER required}" -d "${PGDATABASE:?PGDATABASE required}" \
    --format=custom --no-owner --no-privileges > "$FILE"
else
  pg_dump "${DATABASE_URL:?DATABASE_URL or PG_CONTAINER required}" --format=custom --no-owner --no-privileges -f "$FILE"
fi

if [[ ! -s "$FILE" ]]; then
  echo "backup failed: empty dump" >&2
  exit 1
fi

if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:${BACKUP_PASSPHRASE_FILE}" \
    -in "$FILE" -out "${FILE}.enc"
  rm -f "$FILE"
  FILE="${FILE}.enc"
fi

sha256sum "$FILE" > "${FILE}.sha256"
echo "$FILE"
