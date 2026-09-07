#!/usr/bin/env bash
# Static-export the Next desk in public mode for the Cloudflare Worker assets binding.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dashboard="$root/apps/dashboard"
dist="$root/workers/desk/dist"
stash="$(mktemp -d)"

restore() {
  if [[ -d "$stash/api" ]]; then mv "$stash/api" "$dashboard/app/api"; fi
  if [[ -d "$stash/callback" ]]; then mv "$stash/callback" "$dashboard/app/auth/callback"; fi
  if [[ -f "$stash/sign-out-route.ts" ]]; then mv "$stash/sign-out-route.ts" "$dashboard/app/auth/sign-out/route.ts"; fi
  if [[ -f "$stash/proxy.ts" ]]; then mv "$stash/proxy.ts" "$dashboard/proxy.ts"; fi
  if [[ -f "$stash/load.tsx" ]]; then mv "$stash/load.tsx" "$dashboard/app/terminal/load.tsx"; fi
  rm -rf "$stash"
}
trap restore EXIT

mv "$dashboard/app/api" "$stash/api"
mv "$dashboard/app/auth/callback" "$stash/callback"
mv "$dashboard/app/auth/sign-out/route.ts" "$stash/sign-out-route.ts"
mv "$dashboard/proxy.ts" "$stash/proxy.ts"
cp "$dashboard/app/terminal/load.tsx" "$stash/load.tsx"
cat > "$dashboard/app/terminal/load.tsx" <<'EOF'
export { PublicTerminal as TerminalShell } from './public-shell';
export const dynamic = 'force-static';
EOF

export NEXT_PUBLIC_DESK_MODE=public
export DESK_PUBLIC_EXPORT=1
unset NEXT_PUBLIC_SUPABASE_URL || true
unset NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || true
unset NEXT_PUBLIC_SUPABASE_ANON_KEY || true

cd "$dashboard"
bun --bun next build

rm -rf "$dist"
mkdir -p "$dist"
cp -R "$dashboard/out/." "$dist/"
echo "Public desk assets → $dist"
