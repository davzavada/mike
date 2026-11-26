#!/usr/bin/env bash
# Save this deployment's Google OAuth client and restart the backend, so the
# Google Drive, Gmail and Google Calendar connectors can be added
# (docs/google-workspace.md). The secret is read without being shown and is
# written only to the compose-root .env.
#
# Usage: deploy/proxmox/set-google-oauth.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [ ! -f .env ]; then
  echo "no .env here: run deploy/proxmox/init-env.sh first" >&2
  exit 1
fi

read -r -p "Google OAuth client ID: " client_id
read -r -s -p "Google OAuth client secret (not shown): " client_secret
echo

case "$client_id" in
  *.apps.googleusercontent.com) ;;
  *)
    echo "that does not look like a client ID (…apps.googleusercontent.com)" >&2
    exit 1
    ;;
esac
if [ -z "$client_secret" ] || printf '%s' "$client_id$client_secret" | grep -q '[[:space:]]'; then
  echo "the client ID and secret must be non-empty and contain no spaces" >&2
  exit 1
fi

umask 077
tmp="$(mktemp .env.XXXXXX)"
grep -vE '^GOOGLE_MCP_OAUTH_CLIENT_(ID|SECRET)=' .env > "$tmp" || true
{
  echo "GOOGLE_MCP_OAUTH_CLIENT_ID=$client_id"
  echo "GOOGLE_MCP_OAUTH_CLIENT_SECRET=$client_secret"
} >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env

docker compose up -d --no-deps --force-recreate backend
echo "saved; the backend restarted with the Google client"
