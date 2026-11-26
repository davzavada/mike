#!/usr/bin/env bash
# Build and start the checked-out branch, then wait for the web app to answer.
# Run on the host that serves Mike, from anywhere inside the checkout.
#   deploy/proxmox/deploy.sh          build what is checked out
#   deploy/proxmox/deploy.sh --pull   fast-forward the branch first
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ ! -f .env ]; then
  echo "no .env here: run deploy/proxmox/init-env.sh first" >&2
  exit 1
fi

if [ "${1:-}" = "--pull" ]; then
  git pull --ff-only
fi

# Release identity baked into the images (docs/observability.md).
MIKE_VERSION="$(cat VERSION)"
GIT_SHA="$(git rev-parse HEAD)"
export MIKE_VERSION GIT_SHA

docker compose build --pull
docker compose up -d --remove-orphans

bind_ip="$(sed -n 's/^MIKE_BIND_IP=//p' .env)"
port="$(sed -n 's/^FRONTEND_PORT=//p' .env)"
url="http://${bind_ip}:${port:-3000}/"
echo "waiting for $url"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
  case "$code" in
    2*|3*)
      echo "web app answers ($code) at $GIT_SHA"
      docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
      exit 0
      ;;
  esac
  sleep 5
done

echo "web app did not answer within 5 minutes" >&2
docker compose ps
exit 1
