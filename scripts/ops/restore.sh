#!/usr/bin/env bash
# Restores a backup made by backup.sh into a NEW database. It refuses to overwrite an existing
# database: restore next to production, verify, then switch the application over (see
# docs/operations/backup-restore.md). Usage:
#   PG_CONTAINER=storeline-postgres-1 PGUSER=storeline scripts/ops/restore.sh <backup> <target_db>
#   PGHOST=... PGUSER=... PGPASSWORD=... scripts/ops/restore.sh <backup> <target_db>
set -euo pipefail

BACKUP="${1:?backup file required}"
TARGET="${2:?target database name required}"
[[ "$TARGET" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid database name" >&2; exit 1; }

if [[ -f "${BACKUP}.sha256" ]]; then
  sha256sum --check --status "${BACKUP}.sha256" || { echo "checksum mismatch: refusing to restore" >&2; exit 1; }
fi

DUMP="$BACKUP"
if [[ "$BACKUP" == *.enc ]]; then
  DUMP="$(mktemp)"
  trap 'rm -f "$DUMP"' EXIT
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE required}" \
    -in "$BACKUP" -out "$DUMP"
fi

psql_cmd() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 -qtA "$@";
  else psql -v ON_ERROR_STOP=1 -qtA "$@"; fi
}
exists="$(psql_cmd -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '${TARGET}'")"
if [[ "$exists" == "1" ]]; then
  echo "database ${TARGET} already exists: refusing to overwrite" >&2
  exit 1
fi
psql_cmd -d postgres -c "CREATE DATABASE \"${TARGET}\""

if [[ -n "${PG_CONTAINER:-}" ]]; then
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PGUSER" -d "$TARGET" --no-owner --no-privileges --exit-on-error < "$DUMP"
else
  pg_restore -d "$TARGET" --no-owner --no-privileges --exit-on-error "$DUMP"
fi
echo "restored into ${TARGET}"
