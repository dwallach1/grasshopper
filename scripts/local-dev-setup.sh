#!/usr/bin/env bash
# Prepare local .dev.vars files for Cloudflare Workers (not the webapp).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

copy_if_missing() {
  local example="$1"
  local target="$2"
  if [[ -f "$target" ]]; then
    echo "keep  $target"
    return
  fi
  cp "$example" "$target"
  echo "wrote $target"
}

copy_if_missing \
  "$root/workers/knowledge/.dev.vars.example" \
  "$root/workers/knowledge/.dev.vars"
copy_if_missing \
  "$root/workers/research/.dev.vars.example" \
  "$root/workers/research/.dev.vars"
copy_if_missing \
  "$root/workers/broker/.dev.vars.example" \
  "$root/workers/broker/.dev.vars"

echo
echo "Local webapp (reads Supabase; Workers stay in Cloudflare):"
echo "  bun run web:app"
echo "  # uses THESISFORGE_DATABASE_URL from root .env.local"
echo
echo "Worker local secrets for deploy/sync tooling:"
echo "  fill workers/*/.dev.vars as needed"
echo
echo "Optional local Supabase e2e:"
echo "  1. bunx supabase start --exclude storage-api,imgproxy"
echo "  2. bunx supabase db reset"
echo "  3. bun run test:e2e"
echo
echo "Open http://127.0.0.1:5173"
