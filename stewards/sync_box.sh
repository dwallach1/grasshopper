#!/usr/bin/env bash
# Copy the versioned steward scripts to the box paths the stewards invoke.
# Refuses when a box copy differs from both the repo version and its last synced copy
# (a local edit that would be lost); pass --force to overwrite anyway.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
force="${1:-}"
pairs=(
  "$here/bandit/live_trade_clip.py:/workspace/bandit/live_trade_clip.py"
  "$here/oddsborne/pm_enter.py:/workspace/oddsborne/pm_enter.py"
)
for pair in "${pairs[@]}"; do
  src="${pair%%:*}"; dst="${pair#*:}"
  [ -d "$(dirname "$dst")" ] || { echo "skip $dst (no box dir)"; continue; }
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    stamp="$dst.synced"
    if [ -f "$stamp" ] && ! cmp -s "$stamp" "$dst" && [ "$force" != "--force" ]; then
      echo "refuse: $dst has local edits not in the repo (diff against $stamp); port them, or --force" >&2
      exit 1
    fi
    cp -p "$dst" "$dst.bak_$(date +%Y%m%d%H%M%S)"
  fi
  cp "$src" "$dst"
  cp "$src" "$dst.synced"
  echo "synced $dst"
done
