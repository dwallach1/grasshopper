#!/usr/bin/env bash
# Prepare local .dev.vars files for the dashboard + knowledge Worker.
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
  "$root/apps/dashboard/.dev.vars.example" \
  "$root/apps/dashboard/.dev.vars"
copy_if_missing \
  "$root/workers/knowledge/.dev.vars.example" \
  "$root/workers/knowledge/.dev.vars"
copy_if_missing \
  "$root/workers/research/.dev.vars.example" \
  "$root/workers/research/.dev.vars"

echo
echo "Live production data (Bun + Next, no Docker / Workers):"
echo "  bun run web:app"
echo "  # uses THESISFORGE_DATABASE_URL from root .env.local"
echo
echo "Local Supabase + Miniflare (Docker; for Worker binding tests):"
echo "  1. bunx supabase start --exclude storage-api,imgproxy"
echo "  2. bunx supabase db reset"
echo "  3. bunx supabase functions serve   # optional"
echo "  4. bun run local:web"
echo "  5. bun run test:e2e"
echo
echo "Open http://127.0.0.1:5173"
