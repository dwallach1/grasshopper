#!/usr/bin/env python3
"""ODDSBORNE pm_pnl_snapshot: one pm_pnl book row from the venue balance (replaces the pm_pnl insert in
bidness_standup_2026MMDD.py / session_*_daily.py).

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_pnl_snapshot.py --notes "standup 10/06" [--realized 0] [--dry-run]

cash = account.balances currentBalance; equity = cash + assetNotional when the venue reports it (as the
standups did), else cash + open lots at mark (public.oddsborne_pnl_snapshot, over HTTPS as oddsborne_worker).
The pm_pnl trigger touches the ODDSBORNE heartbeat.
After the write it runs pm_decision_markets.sweep_quietly(): venue ids and settlement for the markets its
logged decisions name, so passes on markets nobody holds resolve (ODDSBORNE_DECISION_MARKETS=0 skips it).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

from pm_enter import ACCOUNT, _require_runtime, jsonable, make_client, make_rpc, vcall  # noqa: E402


def snapshot_args(balances: dict, notes: str, realized: str, now: datetime) -> dict:
    b0 = ((balances or {}).get("balances") or [{}])[0]
    if b0.get("currentBalance") is None:
        raise SystemExit("account.balances returned no currentBalance; nothing written")
    cash = Decimal(str(b0["currentBalance"]))
    args = {"account_key": ACCOUNT, "cash": str(cash), "realized": str(Decimal(realized)), "as_of": now.isoformat(),
            "notes": notes, "payload": {"source": "account.balances", "writer": "pm_pnl_snapshot",
                                        "buying_power": b0.get("buyingPower"), "asset_notional": b0.get("assetNotional")}}
    if b0.get("assetNotional") is not None:
        args["equity"] = str(cash + Decimal(str(b0["assetNotional"])))
    return args


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_pnl_snapshot.py", description=__doc__.split("\n")[0])
    ap.add_argument("--notes", default="")
    ap.add_argument("--realized", default="0")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    c, rpc = make_client(), make_rpc()
    args = snapshot_args(vcall(c.account.balances), a.notes, a.realized, datetime.now(timezone.utc))
    if a.dry_run:
        n = len(rpc("oddsborne_open_positions", {}, idempotent=True) or [])
        print(json.dumps(jsonable({"decision": "DRY_RUN_OK", "open_lots": n,
                                   "would_write": {"fn": "oddsborne_pnl_snapshot", "args": args}}), indent=1))
        return 0
    res = rpc("oddsborne_pnl_snapshot", args)
    # Venue ids + settlement for the markets ODDSBORNE's logged decisions name (never changes this exit code).
    try:
        import pm_decision_markets
        swept = pm_decision_markets.sweep_quietly()
    except Exception as e:  # e.g. pm_decision_markets.py not synced yet: the snapshot above already landed
        swept = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
    print(json.dumps(jsonable({"decision": "WRITTEN", **res, "decision_markets": swept}), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
