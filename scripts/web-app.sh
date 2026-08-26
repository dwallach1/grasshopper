#!/usr/bin/env bash
# Run the ThesisForge dashboard locally with Bun + Next only.
# No Docker, no Cloudflare Workers/Miniflare — just read live Supabase data.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_local="$root/.env.local"
dashboard="$root/apps/dashboard"

read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- || true
}

db_url="$(read_env_value "$env_local" THESISFORGE_DATABASE_URL)"
secret_key="$(read_env_value "$env_local" SUPABASE_SECRET_KEY)"
publishable="$(read_env_value "$env_local" SUPABASE_PUBLISHABLE_KEY)"
supabase_url="$(read_env_value "$env_local" SUPABASE_URL)"

if [[ -z "$supabase_url" && -n "$db_url" ]]; then
  ref="$(printf '%s' "$db_url" | sed -n 's#.*://[^./]*\.\([a-z0-9]*\):[^@]*@.*#\1#p')"
  if [[ -n "$ref" ]]; then
    supabase_url="https://${ref}.supabase.co"
  fi
fi

if [[ -z "$db_url" && -z "$secret_key" ]]; then
  echo "Need a Supabase credential in root .env.local:"
  echo "  THESISFORGE_DATABASE_URL=...   # preferred (already set for most setups)"
  echo "  or SUPABASE_SECRET_KEY=...     # Supabase → Project Settings → API → service_role"
  exit 1
fi

export THESISFORGE_LOCAL_WEB=1
export CF_ACCESS_AUD=local-dev
export LOCAL_DEV_IDENTITY="${LOCAL_DEV_IDENTITY:-local@thesisforge.dev}"
export THESISFORGE_MANAGER_USER_IDS="${THESISFORGE_MANAGER_USER_IDS:-$LOCAL_DEV_IDENTITY}"
export SUPABASE_URL="${supabase_url:-}"
[[ -n "$db_url" ]] && export THESISFORGE_DATABASE_URL="$db_url"
[[ -n "$secret_key" ]] && export SUPABASE_SECRET_KEY="$secret_key"
[[ -n "$publishable" ]] && export SUPABASE_PUBLISHABLE_KEY="$publishable"

if [[ -n "$db_url" ]]; then
  echo "→ Live Supabase via Postgres (no Workers)"
elif [[ -n "$secret_key" ]]; then
  echo "→ Live Supabase via PostgREST service_role (no Workers)"
fi
[[ -n "$supabase_url" ]] && echo "→ $supabase_url"
echo "→ http://127.0.0.1:5173"
echo

cd "$dashboard"
exec bun --bun next dev --hostname 127.0.0.1 --port 5173
