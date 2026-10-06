#!/usr/bin/env bash
# Set up (or repair) the steward runtimes on the box. Safe to re-run any time.
#   bash /workspace/grasshopper/stewards/sync_box.sh [--env] [--force]
# 1. Copies the versioned steward scripts and requirements to the box paths the stewards invoke
#    (skipped with --env, or when this checkout isn't on main). Refuses when a box copy differs from both
#    the repo version and its last synced copy (a local edit that would be lost); --force overwrites.
# 2. Creates or repairs each steward venv (/workspace/<steward>/.venv) from the pinned requirements.
# 3. Runs doctor.sh and exits with its status.
#
# Why this exists: the box's durable store deliberately skips `.venv/`, `venv/` and `.cache/` (the box
# default ignore list), so a box refresh wipes every venv and the pip cache while /workspace files survive.
# The requirements (here and /workspace/<steward>/requirements.txt) and the wheel cache
# (/workspace/.steward-wheelhouse) are plain files that survive, so a rebuild is one command and needs no network.
# STEWARD_BOX_ROOT overrides /workspace and STEWARD_PYTHON the base interpreter (tests).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
box="${STEWARD_BOX_ROOT:-/workspace}"
base_py="${STEWARD_PYTHON:-python3}"
wheelhouse="$box/.steward-wheelhouse"
force="" env_only=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --env) env_only=1 ;;
    *) echo "usage: sync_box.sh [--env] [--force]" >&2; exit 2 ;;
  esac
done
stewards=(bandit oddsborne)

# 1. scripts
branch="$(git -C "$here" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ -n "$env_only" ]; then
  echo "scripts: skipped (--env)"
elif [ "$branch" != "main" ] && [ -z "$force" ]; then
  echo "scripts: skipped (checkout is on '$branch', not main; --force to copy anyway)"
else
  pairs=(
    "$here/bandit/live_trade_clip.py:$box/bandit/live_trade_clip.py"
    "$here/bandit/paper_bank20.py:$box/bandit/paper_bank20.py"
    "$here/bandit/steward_rpc.py:$box/bandit/steward_rpc.py"
    "$here/bandit/requirements.txt:$box/bandit/requirements.txt"
    "$here/oddsborne/pm_enter.py:$box/oddsborne/pm_enter.py"
    "$here/oddsborne/steward_rpc.py:$box/oddsborne/steward_rpc.py"
    "$here/oddsborne/requirements.txt:$box/oddsborne/requirements.txt"
  )
  for pair in "${pairs[@]}"; do
    src="${pair%%:*}"; dst="${pair#*:}"
    [ -d "$(dirname "$dst")" ] || { echo "skip $dst (no box dir)"; continue; }
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      cp "$src" "$dst.synced"
      continue
    fi
    if [ -f "$dst" ]; then
      stamp="$dst.synced"
      if [ -f "$stamp" ] && ! cmp -s "$stamp" "$dst" && [ -z "$force" ]; then
        echo "refuse: $dst has local edits not in the repo (diff against $stamp); port them, or --force" >&2
        exit 1
      fi
      cp -p "$dst" "$dst.bak_$(date +%Y%m%d%H%M%S)"
    fi
    cp "$src" "$dst"
    cp "$src" "$dst.synced"
    echo "synced $dst"
  done
fi

# 2. venvs
py_version() { "$1" -c 'import sys; print(sys.version.split()[0])' 2>/dev/null || true; }
want_py="$(py_version "$base_py")"
[ -n "$want_py" ] || { echo "no base interpreter: $base_py" >&2; exit 1; }
pip_q=(-q --disable-pip-version-check)
# Keep every pinned wheel in the persisted cache (a satisfied install downloads nothing, so fill it explicitly).
fill_wheelhouse() { # <python> <requirements> <steward>
  local mark="$wheelhouse/.$3.requirements"
  mkdir -p "$wheelhouse"
  [ "$(cat "$mark" 2>/dev/null)" = "$want" ] && return 0
  if ! "$1" -m pip download "${pip_q[@]}" --no-index --find-links "$wheelhouse" -d "$wheelhouse" -r "$2" >/dev/null 2>&1; then
    "$1" -m pip download "${pip_q[@]}" -d "$wheelhouse" -r "$2" || { echo "$3: wheel cache not refreshed (offline?)" >&2; return 0; }
  fi
  echo "$want" > "$mark"
}
for steward in "${stewards[@]}"; do
  dir="$box/$steward"
  [ -d "$dir" ] || { echo "$steward: skip env (no $dir)"; continue; }
  req="$here/$steward/requirements.txt"
  [ -f "$req" ] || req="$dir/requirements.txt"
  [ -f "$req" ] || { echo "$steward: no requirements.txt" >&2; exit 1; }
  venv="$dir/.venv"; py="$venv/bin/python"; stamp="$venv/.grasshopper-requirements"
  want="$(sha256sum "$req" | cut -d' ' -f1) python-$want_py"
  have_py="$(py_version "$py")"
  imports_ok() { DOCTOR_IMPORTS_ONLY=1 bash "$here/doctor.sh" "$steward" >/dev/null 2>&1; }
  if [ "$have_py" = "$want_py" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ] && imports_ok; then
    echo "$steward: env current ($venv)"
    fill_wheelhouse "$py" "$req" "$steward"
    continue
  fi
  if [ "$have_py" != "$want_py" ] || [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
    # No venv, a different Python, or a venv that claims to be current but can't import: start clean.
    echo "$steward: creating $venv (python $want_py${have_py:+, replacing a broken or stale venv})"
    rm -rf "$venv"
    "$base_py" -m venv "$venv"
  else
    echo "$steward: repairing $venv against $req"
  fi
  # Offline from the persisted wheel cache (PyPI only when a pinned wheel isn't cached yet).
  fill_wheelhouse "$py" "$req" "$steward"
  if ! "$py" -m pip install "${pip_q[@]}" --no-index --find-links "$wheelhouse" -r "$req" >/dev/null 2>&1; then
    "$py" -m pip install "${pip_q[@]}" --find-links "$wheelhouse" -r "$req"
  fi
  imports_ok || { echo "$steward: imports still broken after install" >&2; bash "$here/doctor.sh" "$steward" >&2 || true; exit 1; }
  echo "$want" > "$stamp"
  echo "$steward: env ready"
done

# 3. doctor
exec bash "$here/doctor.sh"
