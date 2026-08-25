#!/usr/bin/env bash
# Per-boot startup for ThesisForge: bring up the Docker daemon and the local
# Supabase stack. Safe to run repeatedly; each step is a no-op when already up.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

log() { printf '\n[start] %s\n' "$1"; }

# --- Docker daemon (no systemd in the Cloud Agent VM) ----------------------
if ! sudo docker info >/dev/null 2>&1; then
  log "Starting dockerd"
  sudo rm -f /var/run/docker.pid
  sudo nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    if sudo docker info >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
if ! sudo docker info >/dev/null 2>&1; then
  log "dockerd failed to start; see /tmp/dockerd.log"
  tail -n 40 /tmp/dockerd.log || true
  exit 1
fi
# Let the non-root agent user reach the daemon this boot.
sudo chmod 666 /var/run/docker.sock || true
log "Docker is ready"

# --- Local Supabase stack --------------------------------------------------
# `supabase start` applies migrations + seed and is idempotent. Best-effort so
# a DB hiccup never blocks the core (secret-free) dev loop from booting.
log "Starting local Supabase (migrations + seed)"
if bunx supabase start --exclude storage-api,imgproxy; then
  log "Supabase is ready at http://127.0.0.1:54321"
else
  log "Supabase failed to start; run 'bunx supabase start' manually for DB-backed flows"
fi
