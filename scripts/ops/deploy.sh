#!/usr/bin/env bash
# Zero-surprise deployment on a single host using infrastructure/deployment/compose.prod.yaml.
#   REGISTRY=ghcr.io/acme SMA_DOMAIN=chat.example.com scripts/ops/deploy.sh v1.4.0
# Steps: pull images → run migrations (one-shot) → roll api/worker/web → health gate.
# If the new version is not healthy within the gate, the previous version is restored.
# Migrations are forward-only, so every migration must be backward compatible with the
# previous release (expand → migrate → contract across two releases); see deployment.md.
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")/../../infrastructure/deployment" && pwd)}"
cd "$DIR"
STATE=".deploy"
mkdir -p "$STATE"
PREVIOUS="$(cat "$STATE/current" 2>/dev/null || true)"
compose() { docker compose -f compose.prod.yaml "$@"; }

health() {
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "https://${SMA_DOMAIN}/api/v1/health/ready" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

echo "deploying ${TAG} (previous: ${PREVIOUS:-none})"
export IMAGE_TAG="$TAG"
compose pull migrate api worker web
compose run --rm migrate
compose up -d --wait --no-deps api worker web
compose up -d caddy

if health; then
  echo "$TAG" > "$STATE/current"
  echo "$(date -u +%FT%TZ) ${TAG} ok" >> "$STATE/history"
  echo "deployed ${TAG}"
  exit 0
fi

echo "health gate failed for ${TAG}" >&2
echo "$(date -u +%FT%TZ) ${TAG} failed" >> "$STATE/history"
if [[ -n "$PREVIOUS" ]]; then
  echo "rolling back to ${PREVIOUS}" >&2
  IMAGE_TAG="$PREVIOUS" compose up -d --wait --no-deps api worker web
fi
exit 1
