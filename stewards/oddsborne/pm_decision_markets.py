#!/usr/bin/env python3
"""ODDSBORNE pm_decision_markets: venue ids and settlement for the markets ODDSBORNE's logged decisions name.

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_decision_markets.py            # sync every due market
  .venv/bin/python pm_decision_markets.py --dry-run  # read the venue and print; no ledger write

It also runs on its own at the end of pm_pnl_snapshot.py (the standup script), so a pass on a market
nobody holds resolves without a separate routine. ODDSBORNE_DECISION_MARKETS=0 turns that off.

Why: a pass whose slug had no pm_markets row never resolved (resolve_status no_market), and even with a
row, only markets ODDSBORNE traded ever got a resolution. Logging a pass now creates a 'watch' row
(supabase/schemas/59_decision_sides_markets.sql); this fills it from Polymarket US:
  1. public.oddsborne_decision_markets lists the markets named by unresolved, scoreable decisions.
  2. Venue reads only: markets.retrieve_by_slug (side ids, endDate, gameStartTime, status) and, when the
     status is MARKET_STATUS_RESOLVED, markets.settlement (the long / yes side's settlement value).
  3. public.oddsborne_sync_decision_market stores them. It records resolution_outcome only for a venue-
     resolved market whose long side settled at exactly 1 (yes) or 0 (no); a tie or anything else stays
     unresolved. A 404 is noted (venue_status not_found) and re-checked daily. Nothing is inferred.
A market is re-read when it has no venue ids yet, or its game has started and it was not read in the last
RECHECK_MINUTES. Markets with an open lot are left to the exit path (the database refuses them anyway).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

from pm_enter import _require_runtime, jsonable, make_client, make_rpc, vcall  # noqa: E402

RECHECK_MINUTES = 30
NOT_FOUND_RECHECK = timedelta(hours=24)
RESOLVED = "MARKET_STATUS_RESOLVED"


def _ts(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def is_due(row: dict, now: datetime) -> bool:
    checked = _ts(row.get("venue_checked_at"))
    if row.get("venue_status") == "not_found":
        return checked is None or now - checked >= NOT_FOUND_RECHECK
    if not row.get("has_venue_ids") or checked is None:
        return True
    start = _ts(row.get("game_start_at"))
    if start is not None and start > now:
        return False  # nothing settles before the game starts
    return now - checked >= timedelta(minutes=RECHECK_MINUTES)


def _not_found(e: Exception) -> bool:
    return type(e).__name__ == "NotFoundError" or getattr(e, "status_code", None) == 404


def venue_args(c, slug: str) -> dict:
    """What Polymarket US says about one market, as oddsborne_sync_decision_market args (venue reads only)."""
    try:
        m = (vcall(c.markets.retrieve_by_slug, slug) or {}).get("market") or {}
    except Exception as e:
        if _not_found(e):
            return {"slug": slug, "found": False}
        raise
    if not m or m.get("slug") not in (None, slug):
        return {"slug": slug, "found": False}
    sides = m.get("marketSides") or []
    long_side = next((s for s in sides if s.get("long") is True), None)
    short_side = next((s for s in sides if s.get("long") is False), None)
    if not long_side or not short_side:
        raise RuntimeError(f"cannot identify long/short marketSides for {slug}")
    args = {
        "slug": slug, "found": True, "question": m.get("question") or slug,
        "venue_market_id": str(m.get("id")), "yes_side_id": str(long_side.get("id")),
        "no_side_id": str(short_side.get("id")), "close_time": m.get("endDate"),
        "game_start_at": m.get("gameStartTime"), "venue_status": m.get("status"),
        "venue_ids": {"market_id": str(m.get("id")), "yes_side_id": str(long_side.get("id")),
                      "no_side_id": str(short_side.get("id")),
                      "side_map": f"yes=long side {long_side.get('description')}, no={short_side.get('description')}",
                      "note": "Polymarket US has no CLOB token ids; yes/no_token_id hold marketSides ids",
                      "upserted_by": "pm_decision_markets"},
    }
    if m.get("status") == RESOLVED:
        s = vcall(c.markets.settlement, slug) or {}
        if s.get("settlement") is not None:
            # Cross-check: the long side's final price on the market itself must say the same thing.
            lp = long_side.get("price")
            if lp is not None and Decimal(str(lp)) != Decimal(str(s["settlement"])):
                raise RuntimeError(f"{slug}: settlement {s['settlement']} != long side price {lp}; not recorded")
            args["settlement"] = str(s["settlement"])
            args["source"] = "polymarket_us markets.settlement"
            args["venue_ids"]["long_side_final_price"] = lp
    return args


def sweep(dry_run: bool = False, limit: int = 60) -> dict:
    rpc = make_rpc()
    rows = rpc("oddsborne_decision_markets", {"limit": 300}, idempotent=True) or []
    now = datetime.now(timezone.utc)
    due = [r for r in rows if is_due(r, now)][:limit]
    out = {"open_markets": len(rows), "checked": len(due), "results": []}
    if not due:
        return out
    c = make_client()
    for r in due:
        slug = r["slug"]
        try:
            args = venue_args(c, slug)
            if dry_run:
                res = {"action": "would_sync", "args": args}
            else:
                res = {"action": "synced", **rpc("oddsborne_sync_decision_market", args)}
        except Exception as e:
            res = {"action": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"}
        out["results"].append({"slug": slug, **res})
    out["resolved_now"] = sum(1 for x in out["results"] if x.get("resolved_now"))
    return out


def sweep_quietly() -> dict:
    """For the scheduled scripts: never raises, never changes their exit code."""
    if os.environ.get("ODDSBORNE_DECISION_MARKETS", "1").strip() in ("0", "false", "no", "off"):
        return {"skipped": "ODDSBORNE_DECISION_MARKETS=0"}
    try:
        res = sweep()
        res["results"] = [x for x in res["results"] if x.get("resolved_now") or x.get("action") == "error"]
        return res
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:300]}"}


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_decision_markets.py", description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="read the venue and print; no ledger write")
    ap.add_argument("--limit", type=int, default=60)
    a = ap.parse_args(argv)
    out = sweep(dry_run=a.dry_run, limit=a.limit)
    print(json.dumps(jsonable(out), indent=1))
    return 1 if any(r.get("action") == "error" for r in out["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
