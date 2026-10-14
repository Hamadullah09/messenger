#!/bin/sh
# Scheduled database backups (the "backup" service in compose.prod.yaml).
# Every BACKUP_INTERVAL_HOURS: pg_dump (custom format) → AES-256 encrypted → checked by reading
# it back (pg_restore --list) → copied off the server to S3-compatible storage → old local
# copies pruned → a heartbeat URL pinged (dead man's switch: alerts if backups stop).
# Restores: scripts/ops/restore.sh (into a NEW database), drill: scripts/ops/restore-drill.sh.
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-/run/secrets/backup-passphrase}"
OUT=/backups

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
[ -s "$PASS_FILE" ] || { echo "backup: passphrase file $PASS_FILE is missing" >&2; exit 1; }

apk add --no-cache aws-cli openssl curl >/dev/null

upload() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] || return 0
  aws s3 cp "$1" "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-sma}/db/$(basename "$1")" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} --only-show-errors
}

run_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump="$OUT/sma-$stamp.dump"
  pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges -f "$dump"
  [ -s "$dump" ] || { echo "backup: empty dump" >&2; return 1; }
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASS_FILE" -in "$dump" -out "$dump.enc"
  rm -f "$dump"
  # Prove the encrypted file can be read back as a valid dump before trusting it.
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE" -in "$dump.enc" | pg_restore --list >/dev/null
  (cd "$OUT" && sha256sum "sma-$stamp.dump.enc" > "sma-$stamp.dump.enc.sha256")
  upload "$dump.enc"
  upload "$dump.enc.sha256"
  # Optional: copy uploaded files (media) to the backup bucket when both use the same provider.
  if [ -n "${BACKUP_MEDIA_SOURCE_BUCKET:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    aws s3 sync "s3://${BACKUP_MEDIA_SOURCE_BUCKET}" "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-sma}/media" \
      ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} --only-show-errors
  fi
  echo "backup: $(basename "$dump.enc") ok ($(du -h "$dump.enc" | cut -f1))"
}

while true; do
  if run_once; then
    date -u +%FT%TZ > "$OUT/last-success"
    [ -z "${BACKUP_HEARTBEAT_URL:-}" ] || curl -fsS --max-time 10 "$BACKUP_HEARTBEAT_URL" >/dev/null || true
  else
    echo "backup: FAILED at $(date -u +%FT%TZ)" >&2
    [ -z "${BACKUP_HEARTBEAT_URL:-}" ] || curl -fsS --max-time 10 "${BACKUP_HEARTBEAT_URL}/fail" >/dev/null || true
  fi
  find "$OUT" -name 'sma-*' -mtime +"$KEEP_DAYS" -delete
  sleep $((INTERVAL_HOURS * 3600))
done
