#!/usr/bin/env bash
# Starts an isolated API + worker for load tests: database storeline_load, Redis DB 2,
# API on :4200, metrics on :9474/:9475. The dev stack (:4000) is untouched.
#   scripts/load/stack.sh up     # create/migrate DB, start processes (logs in .load/)
#   scripts/load/stack.sh down   # stop processes
#   scripts/load/stack.sh drop   # stop and drop the load database
# Tuning for a run: CAMPAIGN_BATCH_SIZE=1000 CAMPAIGN_DISPATCH_INTERVAL_MS=250 scripts/load/stack.sh up
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE=.load
mkdir -p "$STATE"
base="$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2- | tr -d '"')"
LOAD_DB_URL="$(echo "$base" | sed -E 's#/[^/?]+([?]|$)#/storeline_load\1#')"
# Prisma pool per process (default 2 × CPU + 1). See docs/operations/load-testing.md.
POOL="connection_limit=${DB_POOL_SIZE:-20}&pool_timeout=10"
case "$LOAD_DB_URL" in *\?*) LOAD_DB_URL="$LOAD_DB_URL&$POOL" ;; *) LOAD_DB_URL="$LOAD_DB_URL?$POOL" ;; esac

stop() {
  for f in "$STATE"/*.pid; do
    [[ -f "$f" ]] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
}

case "${1:-up}" in
  up)
    stop
    docker exec storeline-postgres-1 psql -U storeline -d postgres -qtAc \
      "SELECT 1 FROM pg_database WHERE datname='storeline_load'" | grep -q 1 ||
      docker exec storeline-postgres-1 psql -U storeline -d postgres -qc 'CREATE DATABASE storeline_load'
    (cd apps/api && DATABASE_URL="$LOAD_DB_URL" npx prisma migrate deploy >/dev/null &&
      DATABASE_URL="$LOAD_DB_URL" npx tsx src/cli/sync-roles.ts)
    export DATABASE_URL="$LOAD_DB_URL" REDIS_URL="redis://127.0.0.1:16379/2" PORT=4200 \
      METRICS_PORT=9474 METRICS_WORKER_PORT=9475 LOG_LEVEL=warn
    cd apps/api
    nohup node dist/main.js < /dev/null > "../../$STATE/api.log" 2>&1 &
    echo $! > "../../$STATE/api.pid"
    nohup node dist/worker.js < /dev/null > "../../$STATE/worker.log" 2>&1 &
    echo $! > "../../$STATE/worker.pid"
    cd ../..
    for _ in $(seq 1 60); do
      curl -sf http://127.0.0.1:4200/api/v1/health/ready >/dev/null && break
      sleep 1
    done
    curl -sf http://127.0.0.1:4200/api/v1/health/ready >/dev/null && echo "load stack ready on :4200"
    echo 'next: LOAD_DATABASE_URL="$(scripts/load/stack.sh url)" node scripts/load/message-load.cjs'
    ;;
  url) echo "$LOAD_DB_URL" ;;
  down) stop ;;
  drop)
    stop
    docker exec storeline-postgres-1 psql -U storeline -d postgres -qc 'DROP DATABASE IF EXISTS storeline_load'
    ;;
esac
