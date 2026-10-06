#!/usr/bin/env python3
"""BANDIT pnl_snapshot: one meme_pnl book row from the wallet's SOL balance (replaces the per-day
_standup_write_2026MMDD.py meme_pnl + heartbeat writes).

Usage (from /workspace/bandit):
  .venv/bin/python pnl_snapshot.py --notes "standup 10/06" [--realized 0.12] [--payload-file extra.json] [--dry-run]

cash_sol = Helius getBalance of the BANDIT wallet; unrealized = sum(quantity x coalesce(mark_sol, avg cost))
over open lots (computed in public.bandit_pnl_snapshot, over HTTPS as bandit_worker); equity = cash + unrealized.
Heartbeat (desk_agents status active) is attempted and reported as skipped when grants don't allow it.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal

import clip_common as cc

cc.require_runtime(("requests",))

from load_secrets import require  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pnl_snapshot.py", description=__doc__.split("\n")[0])
    ap.add_argument("--notes", default="")
    ap.add_argument("--realized", default="0", help="realized SOL to stamp on the row (default 0)")
    ap.add_argument("--payload-file", default=None, help="JSON object merged into the row payload")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    secrets = require("HELIUS_API_KEY", "BANDIT_WORKER_DB_PASSWORD")
    lamports, slot = cc.get_balance_lamports(secrets["HELIUS_API_KEY"])
    now = datetime.now(timezone.utc)
    payload = {"source": "helius_getBalance", "wallet": cc.WALLET, "lamports": lamports, "context_slot": slot,
               "writer": "pnl_snapshot"}
    if a.payload_file:
        extra = json.load(open(a.payload_file))
        if not isinstance(extra, dict):
            raise SystemExit("--payload-file must hold a JSON object")
        payload.update(extra)
    args = {"account_key": cc.ACCOUNT_KEY, "cash_sol": str(Decimal(lamports) / Decimal(10**9)),
            "realized": str(Decimal(a.realized)), "as_of": now.isoformat(), "notes": a.notes, "payload": payload}
    if a.dry_run:
        opn = cc.ledger("bandit_open_positions", {}, idempotent=True) or []
        print(cc.jdump({"decision": "DRY_RUN_OK", "would_write": {"fn": "bandit_pnl_snapshot", "args": args},
                        "open_lots": len(opn)}))
        return 0
    res = cc.ledger("bandit_pnl_snapshot", args)
    print(cc.jdump({"decision": "WRITTEN", **res}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
