#!/usr/bin/env bash
# Backup → restore → verify drill against the local stack. Proves that a backup can actually be
# restored: every table's row count must match, and Prisma must see all migrations applied.
# Appends the result to docs/operations/restore-drill-log.md. Usage: scripts/ops/restore-drill.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER="${PG_CONTAINER:-storeline-postgres-1}"
SOURCE_DB="${PGDATABASE:-storeline}"
export PGUSER="${PGUSER:-storeline}"
DRILL_DB="sma_restore_drill_$(date -u +%Y%m%d%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -qc "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null 2>&1 || true' EXIT

counts() {
  docker exec "$CONTAINER" psql -U "$PGUSER" -d "$1" -qtA -c "
    SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
      SELECT c.relname AS t,
             (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r') x"
}

start=$(date +%s)
BACKUP="$(PG_CONTAINER="$CONTAINER" PGDATABASE="$SOURCE_DB" scripts/ops/backup.sh "$WORK")"
backup_done=$(date +%s)
size=$(stat -c %s "$BACKUP")
before="$(counts "$SOURCE_DB")"

PG_CONTAINER="$CONTAINER" scripts/ops/restore.sh "$BACKUP" "$DRILL_DB" >/dev/null
restore_done=$(date +%s)
after="$(counts "$DRILL_DB")"

status="PASS"
if [[ "$before" != "$after" ]]; then status="FAIL (row counts differ)"; fi
# Same server and credentials as the app's DATABASE_URL, pointed at the drill database.
base="${DATABASE_URL:-$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2- | tr -d '"')}"
url="$(echo "$base" | sed -E "s#/[^/?]+([?]|\$)#/${DRILL_DB}\1#")"
if ! (cd apps/api && DATABASE_URL="$url" npx prisma migrate status >/dev/null 2>&1); then
  status="FAIL (migrations not current)"
fi
tables=$(echo "$after" | wc -w)
rows=$(echo "$after" | tr ' ' '\n' | awk -F= '{ s += $2 } END { print s }')

line="| $(date -u +%Y-%m-%dT%H:%MZ) | ${SOURCE_DB} | ${size} B | ${tables} tables / ${rows} rows | $((backup_done - start)) s | $((restore_done - backup_done)) s | ${status} |"
log=docs/operations/restore-drill-log.md
if [[ ! -f "$log" ]]; then
  printf '# Restore drill log\n\nProduced by `scripts/ops/restore-drill.sh` (backup → restore into a new database → compare every table'"'"'s row count → `prisma migrate status`).\n\n| When (UTC) | Source | Backup size | Restored | Backup time | Restore time | Result |\n| --- | --- | --- | --- | --- | --- | --- |\n' > "$log"
fi
echo "$line" >> "$log"
echo "$line"
[[ "$status" == "PASS" ]]
