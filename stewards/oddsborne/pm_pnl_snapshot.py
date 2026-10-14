#!/usr/bin/env python3
"""ODDSBORNE pm_pnl_snapshot: one pm_pnl book row from the venue balance (replaces the pm_pnl insert in
bidness_standup_2026MMDD.py / session_*_daily.py).

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_pnl_snapshot.py --notes "standup 10/06" [--realized 0] [--dry-run]

cash = account.balances currentBalance; equity = cash + open lots at the venue's mark (venue_valuation: assetNotional,
else portfolio.positions cashValue), the same valuation the sessions' write_pnl_safe uses. Written over HTTPS
(public.oddsborne_pnl_snapshot as oddsborne_worker). Open venue positions with no reported value -> refuse.
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


def venue_valuation(balances: dict, positions=None) -> dict:
    """cash + open lots at the venue's mark: the one valuation write_pnl_safe (session_daily/session_pm) and this
    script use. asset = balances.assetNotional when the venue reports it non-zero, else the sum of
    portfolio.positions cashValue. Never invents a mark: open venue positions with no reported value raise."""
    b0 = ((balances or {}).get("balances") or [{}])[0]
    if b0.get("currentBalance") is None:
        raise ValueError("account.balances returned no currentBalance; nothing written")
    cash = Decimal(str(b0["currentBalance"]))
    notional = b0.get("assetNotional")
    if notional is not None and Decimal(str(notional)) != 0:
        asset, source = Decimal(str(notional)), "account.balances.assetNotional"
    else:
        raw = (positions or {}).get("availablePositions") or (positions or {}).get("positions") or []
        rows = [v for v in (raw.values() if isinstance(raw, dict) else raw) if isinstance(v, dict)]
        asset, missing = Decimal("0"), []
        for v in rows:
            cv = v.get("cashValue")
            val = cv.get("value") if isinstance(cv, dict) else None
            if val is None:
                missing.append((v.get("marketMetadata") or {}).get("slug") or v.get("marketSlug") or v.get("slug") or "?")
            else:
                asset += Decimal(str(val))
        if missing:
            raise ValueError(f"venue reports {len(missing)} open position(s) with no cashValue ({', '.join(map(str, missing[:5]))}) "
                             "and no assetNotional; refusing to value open lots at an invented mark")
        source = "portfolio.positions.cashValue" if rows else "no_open_positions"
    return {"cash": cash, "asset": asset, "equity": cash + asset, "asset_source": source,
            "buying_power": b0.get("buyingPower"), "asset_notional": notional}


def snapshot_args(balances: dict, notes: str, realized: str, now: datetime, positions=None, writer="pm_pnl_snapshot") -> dict:
    try:
        v = venue_valuation(balances, positions)
    except ValueError as e:
        raise SystemExit(str(e))
    return {"account_key": ACCOUNT, "cash": str(v["cash"]), "equity": str(v["equity"]),
            "realized": str(Decimal(realized)), "as_of": now.isoformat(), "notes": notes,
            "payload": {"source": "account.balances+portfolio.positions", "writer": writer,
                        "asset": str(v["asset"]), "asset_source": v["asset_source"],
                        "buying_power": v["buying_power"], "asset_notional": v["asset_notional"]}}


def refresh_snapshot(rpc, balances: dict, positions, notes: str, *, dry_run: bool, writer: str,
                     now: datetime | None = None) -> dict:
    """Write one pm_pnl row over HTTPS (oddsborne_pnl_snapshot via steward-rpc). dry_run writes nothing.
    Raises RuntimeError on any failure so callers can fail loudly."""
    try:
        args = snapshot_args(balances, notes, "0", now or datetime.now(timezone.utc), positions, writer)
    except SystemExit as e:
        raise RuntimeError(str(e)) from None
    if dry_run:
        return {"decision": "DRY_RUN_OK", "would_write": {"fn": "oddsborne_pnl_snapshot", "args": args}}
    try:
        res = rpc("oddsborne_pnl_snapshot", args)
    except Exception as e:
        raise RuntimeError(f"oddsborne_pnl_snapshot over steward-rpc failed: {type(e).__name__}: {str(e)[:300]}") from e
    if not isinstance(res, dict) or not res.get("pm_pnl_id"):
        raise RuntimeError(f"oddsborne_pnl_snapshot returned no pm_pnl_id: {str(res)[:300]}")
    return {"decision": "WRITTEN", **res, "args": args}


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_pnl_snapshot.py", description=__doc__.split("\n")[0])
    ap.add_argument("--notes", default="")
    ap.add_argument("--realized", default="0")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    c, rpc = make_client(), make_rpc()
    args = snapshot_args(vcall(c.account.balances), a.notes, a.realized, datetime.now(timezone.utc),
                         vcall(c.portfolio.positions))
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
