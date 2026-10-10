# Running the Load and Resilience Tests

The tests run against an **isolated** stack so development data is never touched:
database `storeline_load`, Redis DB 2, API on `:4200`, metrics on `:9474/:9475`.

```bash
npm run build -w @storeline/api
scripts/load/stack.sh up                       # create + migrate storeline_load, sync roles, start API + worker
export LOAD_DATABASE_URL="$(scripts/load/stack.sh url)"

node scripts/load/message-load.cjs --users 100 --group 10 --rate 40 --seconds 60
node scripts/load/campaign-benchmark.cjs --recipients 30000

scripts/load/stack.sh down                     # stop the processes
node scripts/resilience/resilience.cjs         # starts its own API/worker; stops/starts Redis and PostgreSQL
scripts/load/stack.sh drop                     # remove the load database
```

Tuning a run: `CAMPAIGN_BATCH_SIZE=1000 CAMPAIGN_DISPATCH_INTERVAL_MS=250 DB_POOL_SIZE=30
scripts/load/stack.sh up`.

Notes:

- Virtual users get a random password generated inside the test process (never printed).
- All virtual users share 127.0.0.1, so the scripts clear the per-IP **login** rate-limit keys
  in the load Redis DB before each sign-in. Message rate limits stay enforced (40 msg/s is
  below the 3,000/min per-business limit).
- The resilience script stops the shared `storeline-redis-1` and `storeline-postgres-1`
  containers for a few seconds; run it when nobody else is using the local stack.
- Results are recorded in [load-test-results.md](load-test-results.md).

## Connection pool sizing

Prisma opens `connection_limit` connections per process (default 2 × CPU + 1). Size it with
`?connection_limit=N&pool_timeout=10` in `DATABASE_URL` so that
`(API replicas + worker replicas) × N` stays below PostgreSQL's `max_connections` (default 100;
leave room for migrations and administration), or put PgBouncer (transaction mode) in front.
