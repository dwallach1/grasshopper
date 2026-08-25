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
echo "Next:"
echo "  1. bunx supabase start --exclude storage-api,imgproxy"
echo "     # drop --exclude if you need Storage; first pulls can be slow"
echo "  2. bunx supabase db reset   # schemas + seed snapshot"
echo "  3. bunx supabase functions serve   # optional; RPC path is enough for most e2e"
echo "  4. bun run local:web    # dashboard + knowledge Worker"
echo "  5. bun run test:e2e     # publication / knowledge slice"
echo
echo "Open http://127.0.0.1:5173 (or the Vite URL printed by vinext)."
