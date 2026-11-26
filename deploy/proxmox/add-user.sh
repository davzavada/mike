#!/usr/bin/env bash
# Create a confirmed account while public sign-up is closed. Prints a one-time
# password once, here in the terminal; the person changes it after signing in.
# An address that already has an account is left exactly as it is.
#
# Usage: deploy/proxmox/add-user.sh person@example.com
set -euo pipefail

email="${1:?email address}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

password="$(openssl rand -base64 18)"
output="$(docker compose exec -T \
  -e MIKE_ADMIN_EMAIL="$email" \
  -e MIKE_ADMIN_PASSWORD="$password" \
  backend node scripts/vercel-admin-user.mjs)"

if printf '%s' "$output" | grep -q "created the admin account"; then
  echo "account created for $email"
  echo "one-time password: $password"
elif [ -z "$output" ]; then
  echo "$email already has an account; nothing was changed"
else
  echo "$output" >&2
  exit 1
fi
