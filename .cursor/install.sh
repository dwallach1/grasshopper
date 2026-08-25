#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for ThesisForge.
# Installs the Bun toolchain + JS deps (core dev loop) and the system packages
# the local Supabase stack needs (Docker configured for a nested Cloud Agent VM).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

log() { printf '\n[install] %s\n' "$1"; }

# --- Bun (pinned to package.json packageManager) ---------------------------
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun 1.4.0"
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
fi
bun --version

# --- JavaScript dependencies (workspace install) ---------------------------
log "Installing workspace dependencies"
bun install --frozen-lockfile

# --- Local dev secret files (.dev.vars placeholders, git-ignored) ----------
log "Preparing local .dev.vars files"
bun run local:setup

# --- Docker for the local Supabase stack -----------------------------------
# Supabase local development runs in Docker. The Cloud Agent VM is itself a
# container, so the daemon needs fuse-overlayfs (nested overlay is rejected)
# and the legacy iptables backend (nf_tables breaks container networking).
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine"
  curl -fsSL https://get.docker.com | sudo sh
fi

log "Installing fuse-overlayfs"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  -o Dpkg::Options::=--force-confold \
  -o Dpkg::Options::=--force-confdef \
  fuse-overlayfs

log "Configuring Docker for the nested VM"
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "storage-driver": "fuse-overlayfs",
  "features": { "containerd-snapshotter": false }
}
JSON
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
sudo usermod -aG docker "$USER" || true

log "install complete"
