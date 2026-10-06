#!/usr/bin/env python3
"""Paper rule 'bank at +20%' (GRASSHOPPER 2026-09-26). For a closed clip, find the first 5-min venue mark
>= +20% vs entry; paper exit = that mark's pct, else the real exit pct. Writes meme_positions.meta.paper_bank20.
Usage: paper_bank20.py <position_id> [...]   (run after every close; no trading)."""
import argparse
import json
import os
import sys
from datetime import datetime
from decimal import Decimal

# Helpers (load_secrets, steward_rpc) resolve from this script's directory (the box copy in
# /workspace/bandit keeps its own load_secrets). Stdlib only: ledger I/O is HTTPS (steward_rpc).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

TH = Decimal(20)


def rpc(fn, args, idempotent=False):
    from steward_rpc import call
    return call("bandit", fn, args, idempotent=idempotent)


def run(pid):
    # public.bandit_shadow_exit_marks: the lot (opened_at, status, symbol) and its meme_pnl marks in as_of order.
    lot = rpc("bandit_shadow_exit_marks", {"position_id": pid}, idempotent=True)
    if not lot:
        return {"position_id": pid, "error": "no such position"}
    opened, sym = datetime.fromisoformat(str(lot["opened_at"])), lot["symbol"]
    marks = [(datetime.fromisoformat(str(a)), Decimal(str(p))) for a, p in lot.get("marks") or []]
    if not marks:
        return {"symbol": sym, "error": "no marks"}
    hit = next((m for m in marks if m[1] >= TH), None)
    real = marks[-1][1]
    out = {"rule": "bank_at_+20pct", "source": "5min venue marks (meme_pnl pnl_pct_vs_entry)",
           "real_exit_pct": str(round(real, 2)),
           "paper_exit_pct": str(round(hit[1] if hit else real, 2)),
           "triggered": bool(hit),
           "trigger_minute": round((hit[0]-opened).total_seconds()/60) if hit else None,
           "delta_pct_pts": str(round((hit[1] if hit else real) - real, 2)),
           "note": "real_exit_pct = last watch mark before exit, not fill; compare in pct points"}
    # public.bandit_write_shadow_exit: meme_positions.meta || {'paper_bank20': out} (only its own key).
    rpc("bandit_write_shadow_exit", {"position_id": pid, "key": 'paper_bank20', "value": out})
    out["symbol"] = sym
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Record the bank_at_+20pct shadow exit for closed BANDIT lots.")
    ap.add_argument("position_ids", nargs="+")
    for p in ap.parse_args().position_ids:
        print(json.dumps(run(p)))
