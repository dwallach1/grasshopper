#!/usr/bin/env bash
# Run the ThesisForge dashboard locally with Bun + Next only.
# Workers stay on Cloudflare and hydrate Supabase; this app only reads it.
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
dashboard_token="$(read_env_value "$env_local" THESISFORGE_DASHBOARD_TOKEN)"
manager_token="$(read_env_value "$env_local" THESISFORGE_MANAGER_TOKEN)"
internal_token="$(read_env_value "$env_local" INTERNAL_SERVICE_TOKEN)"
knowledge_worker_url="$(read_env_value "$env_local" THESISFORGE_KNOWLEDGE_WORKER_URL)"
research_worker_url="$(read_env_value "$env_local" THESISFORGE_RESEARCH_WORKER_URL)"

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

export LOCAL_DEV_IDENTITY="${LOCAL_DEV_IDENTITY:-local@thesisforge.dev}"
export THESISFORGE_MANAGER_USER_IDS="${THESISFORGE_MANAGER_USER_IDS:-$LOCAL_DEV_IDENTITY}"
export SUPABASE_URL="${supabase_url:-}"
[[ -n "$db_url" ]] && export THESISFORGE_DATABASE_URL="$db_url"
[[ -n "$secret_key" ]] && export SUPABASE_SECRET_KEY="$secret_key"
[[ -n "$publishable" ]] && export SUPABASE_PUBLISHABLE_KEY="$publishable"
[[ -n "$dashboard_token" ]] && export THESISFORGE_DASHBOARD_TOKEN="$dashboard_token"
[[ -n "$manager_token" ]] && export THESISFORGE_MANAGER_TOKEN="$manager_token"
[[ -n "$internal_token" ]] && export INTERNAL_SERVICE_TOKEN="$internal_token"
[[ -n "$knowledge_worker_url" ]] && export THESISFORGE_KNOWLEDGE_WORKER_URL="$knowledge_worker_url"
[[ -n "$research_worker_url" ]] && export THESISFORGE_RESEARCH_WORKER_URL="$research_worker_url"

if [[ -n "$db_url" ]]; then
  echo "→ Live Supabase via Postgres"
elif [[ -n "$secret_key" ]]; then
  echo "→ Live Supabase via PostgREST service_role"
fi
[[ -n "$supabase_url" ]] && echo "→ $supabase_url"
echo "→ http://127.0.0.1:5173"
echo

cd "$dashboard"
exec bun --bun next dev --hostname 127.0.0.1 --port 5173
