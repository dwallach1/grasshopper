"""Load BANDIT credentials without echoing values. Nothing secret lives in this repo.

Order: process environment, then an optional JSON secrets file outside git
(`STEWARD_SECRETS_FILE`, default /home/box/sand-data/box-secrets.json when it exists;
shape {"secrets": {NAME: value}} or {NAME: value}).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

NAMES = ("JUPITER_API_KEY", "HELIUS_API_KEY", "BANDIT_WORKER_DB_PASSWORD", "BANDIT_SOLANA_PRIVATE_KEY")
DEFAULT_SECRETS_FILE = "/home/box/sand-data/box-secrets.json"


def _file_secrets() -> dict:
    path = Path(os.environ.get("STEWARD_SECRETS_FILE") or DEFAULT_SECRETS_FILE)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    inner = data.get("secrets", data)
    return inner if isinstance(inner, dict) else {}


def load_secrets() -> dict[str, str]:
    out = {name: os.environ[name] for name in NAMES if os.environ.get(name)}
    missing = [name for name in NAMES if name not in out]
    if missing:
        stored = _file_secrets()
        for name in missing:
            if stored.get(name):
                out[name] = str(stored[name])
    return out


def require(*names: str) -> dict[str, str]:
    found = load_secrets()
    missing = [name for name in names if not found.get(name)]
    if missing:
        raise RuntimeError("missing secrets: " + ", ".join(missing))
    return {name: found[name] for name in names}


if __name__ == "__main__":
    found = load_secrets()
    print("present:", sorted(found))
    print("missing:", [name for name in NAMES if name not in found])
