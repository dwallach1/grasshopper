#!/usr/bin/env bash
# Steward runtime check: every steward venv exists and its imports work. Exit 0 = healthy, 1 = broken.
#   bash /workspace/grasshopper/stewards/doctor.sh [steward ...]   (fix anything it reports with sync_box.sh)
# STEWARD_BOX_ROOT overrides /workspace (tests); DOCTOR_IMPORTS_ONLY=1 skips the file checks (sync_box.sh probe).
set -uo pipefail
box="${STEWARD_BOX_ROOT:-/workspace}"
fix="bash $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync_box.sh"
# steward | modules the scripts import (helpers resolve from the steward dir) | files the stewards invoke
checks=(
  "bandit|base58 requests solders.keypair solders.transaction psycopg db_connect load_secrets|live_trade_clip.py paper_bank20.py db_connect.py load_secrets.py requirements.txt"
  "oddsborne|polymarket_us psycopg db_connect load_secrets|pm_enter.py db_connect.py load_secrets.py requirements.txt"
)
broken=0
for row in "${checks[@]}"; do
  IFS='|' read -r steward modules files <<<"$row"
  dir="$box/$steward"; py="$dir/.venv/bin/python"
  if [ $# -gt 0 ] && [[ " $* " != *" $steward "* ]]; then continue; fi
  [ -d "$dir" ] || { echo "$steward: skip (no $dir on this box)"; continue; }
  problems=()
  if [ -z "${DOCTOR_IMPORTS_ONLY:-}" ]; then
    for f in $files; do [ -f "$dir/$f" ] || problems+=("missing $f"); done
  fi
  if [ ! -x "$py" ] || ! "$py" -c 'pass' >/dev/null 2>&1; then
    problems+=("no working venv at $dir/.venv")
  else
    # shellcheck disable=SC2086
    [ -z "${DOCTOR_IMPORTS_ONLY:-}" ] || modules="${modules// db_connect load_secrets/}"
    bad="$(cd "$dir" && "$py" - $modules <<'PY' 2>&1
import importlib, sys
bad = []
for name in sys.argv[1:]:
    try:
        importlib.import_module(name)
    except Exception as exc:
        bad.append(f"{name} ({type(exc).__name__})")
print(", ".join(bad))
PY
)"
    [ -z "$bad" ] || problems+=("imports broken: $bad")
  fi
  if [ ${#problems[@]} -eq 0 ]; then
    echo "$steward: ok ($("$py" -c 'import sys; print(sys.version.split()[0])'), $dir/.venv)"
  else
    broken=1
    printf '%s: BROKEN: %s\n' "$steward" "$(IFS='; '; echo "${problems[*]}")"
  fi
done
if [ "$broken" -ne 0 ]; then echo "doctor: broken. Fix with: $fix"; exit 1; fi
echo "doctor: ok"
