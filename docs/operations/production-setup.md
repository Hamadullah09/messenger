# Production setup — step by step

Everything below runs from `infrastructure/deployment/` on a Linux server (Ubuntu 24.04 LTS,
4 vCPU / 8 GB RAM / 80 GB SSD is a good start for a few hundred users) with Docker installed.
Do the same once more on a second, smaller server for **staging** (see the end).

## 1. Domain and DNS

Point these names at the server's public IP (A records):

| Name | Used for |
| --- | --- |
| `chat.example.com` | the app (web + API); Caddy gets its https certificate automatically |
| `livekit.chat.example.com` | only if you enable LiveKit (big group calls) |

## 2. Firewall

Allow only: `22/tcp` (SSH, ideally from your office IP), `80/tcp` and `443/tcp` (Caddy),
`3478/udp` and `3478/tcp` plus `49160-49200/udp` (calls relay). With LiveKit also `7881/tcp`
and `50000-50200/udp`. Everything else (PostgreSQL, Redis, metrics, Grafana) stays closed.

## 3. Secrets (never in git)

```bash
cp .env.example .env                       # domain, image tag, calls relay
cp .env.production.example .env.production # the app's settings and secrets
cp .env.postgres.example .env.postgres
cp .env.backup.example .env.backup
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 48 > secrets/backup-passphrase      # keep a copy in your password manager!
openssl rand -base64 24 > secrets/grafana-admin-password
chmod 600 .env* secrets/*
```

Fill in every `CHANGE_ME`. Generate `JWT_ACCESS_SECRET`, `DATA_ENCRYPTION_KEY` and
`TURN_SHARED_SECRET` with the commands in the files. **Store `DATA_ENCRYPTION_KEY` and the
backup passphrase in a password manager**: without them, backups cannot be restored and
encrypted settings cannot be read.

Object storage for files: create a private bucket (Cloudflare R2, Backblaze B2, AWS S3…)
with versioning on, and put its address and key in `.env.production` (`S3_*`).

## 4. First start

```bash
IMAGE_TAG=v1.0.0 ../../scripts/ops/deploy.sh v1.0.0      # migrations, api, worker, web, Caddy
docker compose -f compose.prod.yaml up -d coturn backup clamav
docker compose -f compose.prod.yaml --profile monitoring up -d   # after creating alertmanager.yml
```

Create the first Super Admin (the password is read from the environment, never typed on the
command line):

```bash
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD ADMIN_EMAIL=you@example.com
docker compose -f compose.prod.yaml run --rm -e ADMIN_PASSWORD -e ADMIN_EMAIL api \n  node dist/cli/create-super-admin.js admin "Your Name"
unset ADMIN_PASSWORD
```

Sign in, choose a new password and set up two-step login (required for administrators).

## 5. Calls across the internet (TURN)

The `coturn` service relays calls when devices cannot connect directly (mobile data, office
firewalls). Each signed-in user gets short-lived relay credentials from the API
(`TURN_URLS` + `TURN_SHARED_SECRET`), so no password is shared. Private address ranges are
blocked in the relay. Test: call between a phone on mobile data and a laptop on Wi-Fi.

## 6. Big group calls (LiveKit, optional)

```bash
cp .env.livekit.example .env.livekit        # LIVEKIT_KEYS
cp sites/livekit.caddy.example sites/livekit.caddy
# .env.production: LIVEKIT_URL=wss://livekit.chat.example.com, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
# web build: NEXT_PUBLIC_LIVEKIT_ORIGIN=wss://livekit.chat.example.com
docker compose -f compose.prod.yaml --profile livekit up -d livekit caddy
```

Groups with more than 8 members then call through LiveKit (up to `LIVEKIT_MAX_PARTICIPANTS`,
50 by default); smaller calls stay device to device.

## 7. Backups

The `backup` service makes an encrypted dump every `BACKUP_INTERVAL_HOURS`, checks that it can
be read back, uploads it to the off-site bucket and pings `BACKUP_HEARTBEAT_URL`. Make a free
check at healthchecks.io ("every 1 day, 2 hours grace") so you get an email if backups stop.
Files: turn on versioning (and replication if offered) on the media bucket, or set
`BACKUP_MEDIA_SOURCE_BUCKET`. **Do a restore drill before launch and then monthly**
(`scripts/ops/restore-drill.sh`, record it in `restore-drill-log.md`).

## 8. Monitoring and alerts

`cp ../monitoring/alertmanager.yml.example ../monitoring/alertmanager.yml` and fill in where
alerts go (email, Telegram or Slack). The 21 alert rules cover: site down from outside, API or
worker down, error rate, slow responses, message and campaign backlogs, unanswered
emergencies, database pressure, certificate expiry and suspicious sign-in activity.
Dashboards: `ssh -L 3001:127.0.0.1:3001 server` then open http://localhost:3001.
Crashes: set `SENTRY_DSN` (Sentry, or self-hosted GlitchTip) to get every server and browser
error with its request id.

## 9. Email, WhatsApp and SMS

See [email.md](email.md) and [messaging-channels.md](messaging-channels.md).

## 10. Map previews

OpenStreetMap's free tile servers are for light use only. For production set `MAP_TILE_URL`
to your own provider (e.g. MapTiler, Stadia Maps, Thunderforest) with its key.

## Staging

A second server (2 vCPU / 4 GB is enough) set up exactly like production with its own domain
(`staging.chat.example.com`), its own secrets, its own buckets and **demo data only**. Deploy
every release there first (`deploy.sh <tag>` on the staging host), test, then approve the
production deployment. The penetration test ([pentest-scope.md](../security/pentest-scope.md))
runs against staging.
