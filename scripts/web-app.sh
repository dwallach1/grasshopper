#!/usr/bin/env bash
# Run the Quantanamo dashboard locally with Bun + Next only.
# Workers stay on Cloudflare and hydrate Supabase; this app reads/writes the ledger.
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

db_url="$(read_env_value "$env_local" QUANTANAMO_DATABASE_URL)"
secret_key="$(read_env_value "$env_local" SUPABASE_SECRET_KEY)"
publishable="$(read_env_value "$env_local" SUPABASE_PUBLISHABLE_KEY)"
next_publishable="$(read_env_value "$env_local" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
next_anon="$(read_env_value "$env_local" NEXT_PUBLIC_SUPABASE_ANON_KEY)"
supabase_url="$(read_env_value "$env_local" SUPABASE_URL)"
next_supabase_url="$(read_env_value "$env_local" NEXT_PUBLIC_SUPABASE_URL)"
dashboard_token="$(read_env_value "$env_local" QUANTANAMO_DASHBOARD_TOKEN)"
manager_token="$(read_env_value "$env_local" QUANTANAMO_MANAGER_TOKEN)"
internal_token="$(read_env_value "$env_local" INTERNAL_SERVICE_TOKEN)"
knowledge_worker_url="$(read_env_value "$env_local" QUANTANAMO_KNOWLEDGE_WORKER_URL)"
research_worker_url="$(read_env_value "$env_local" QUANTANAMO_RESEARCH_WORKER_URL)"

if [[ -z "$supabase_url" && -n "$db_url" ]]; then
  ref="$(printf '%s' "$db_url" | sed -n 's#.*://[^./]*\.\([a-z0-9]*\):[^@]*@.*#\1#p')"
  if [[ -n "$ref" ]]; then
    supabase_url="https://${ref}.supabase.co"
  fi
fi

if [[ -z "$supabase_url" && -n "$next_supabase_url" ]]; then
  supabase_url="$next_supabase_url"
fi
if [[ -z "$next_supabase_url" && -n "$supabase_url" ]]; then
  next_supabase_url="$supabase_url"
fi

if [[ -z "$db_url" && -z "$secret_key" && -z "$publishable" && -z "$next_publishable" && -z "$next_anon" ]]; then
  echo "Need a Supabase credential in root .env.local:"
  echo "  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...  # required for operator sign-in"
  echo "  QUANTANAMO_DATABASE_URL=...               # optional, workers / postgres.js"
  echo "  or SUPABASE_SECRET_KEY=...                # service_role, server-only"
  exit 1
fi

export LOCAL_DEV_IDENTITY="${LOCAL_DEV_IDENTITY:-local@quantanamo.dev}"
export QUANTANAMO_MANAGER_USER_IDS="${QUANTANAMO_MANAGER_USER_IDS:-$LOCAL_DEV_IDENTITY}"
export SUPABASE_URL="${supabase_url:-}"
[[ -n "$next_supabase_url" ]] && export NEXT_PUBLIC_SUPABASE_URL="$next_supabase_url"
[[ -n "$next_publishable" ]] && export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$next_publishable"
[[ -n "$next_anon" ]] && export NEXT_PUBLIC_SUPABASE_ANON_KEY="$next_anon"
[[ -n "$db_url" ]] && export QUANTANAMO_DATABASE_URL="$db_url"
[[ -n "$secret_key" ]] && export SUPABASE_SECRET_KEY="$secret_key"
[[ -n "$publishable" ]] && export SUPABASE_PUBLISHABLE_KEY="$publishable"
[[ -n "$dashboard_token" ]] && export QUANTANAMO_DASHBOARD_TOKEN="$dashboard_token"
[[ -n "$manager_token" ]] && export QUANTANAMO_MANAGER_TOKEN="$manager_token"
[[ -n "$internal_token" ]] && export INTERNAL_SERVICE_TOKEN="$internal_token"
[[ -n "$knowledge_worker_url" ]] && export QUANTANAMO_KNOWLEDGE_WORKER_URL="$knowledge_worker_url"
[[ -n "$research_worker_url" ]] && export QUANTANAMO_RESEARCH_WORKER_URL="$research_worker_url"

if [[ -n "$next_publishable" || -n "$next_anon" ]]; then
  echo "→ Operator sign-in via Supabase Auth (publishable key)"
fi
if [[ -n "$db_url" ]]; then
  echo "→ Live Supabase via Postgres (server-only)"
elif [[ -n "$secret_key" ]]; then
  echo "→ Live Supabase via PostgREST service_role (server-only)"
fi
[[ -n "$supabase_url" ]] && echo "→ $supabase_url"
echo "→ http://127.0.0.1:5173"
echo

cd "$dashboard"
exec bun --bun next dev --hostname 127.0.0.1 --port 5173
