#!/usr/bin/env python3
"""ODDSBORNE pm_watch: one invalidation-watch pass over open lots (replaces watch_<mkt>_*_run.py and the
*_bbo_only.py fallbacks). Marks the lot from the venue print; never sells.

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_watch.py --position-id <uuid>
  .venv/bin/python pm_watch.py --all-open [--dry-run]

Per lot: live BBO; print = outcome bid -> last -> mid (as the watch scripts did). print <= invalidation_price
-> TRIP (prints the pm_exit.py command; exit code 10). Otherwise hold. Either way (unless --dry-run) the lot
gets mark = print, mark_at, and meta (watch_at, watch_result, print_px, bbo_*, mark_source venue_best_bid,
invalidation_price, market_state, writer pm_watch) via public.oddsborne_mark_position over HTTPS; the
pm_positions trigger touches the ODDSBORNE heartbeat. Settled/closed markets are reported, not marked.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

from pm_enter import _require_runtime, jsonable, make_client, make_rpc, market_view, outcome_book  # noqa: E402
from pm_exit import print_price  # noqa: E402


def watch_decision(px, inval) -> str:
    if px is None:
        return "no_print"
    if inval is not None and px <= inval:
        return "trip"
    return "hold_above_line"


def watch_one(c, rpc, pos: dict, dry_run: bool, routine: str = "") -> dict:
    pid = str(pos["id"])
    slug = (pos.get("market") or {}).get("slug")
    res = {"position_id": pid, "slug": slug, "outcome": pos.get("outcome"), "qty": pos.get("quantity")}
    if pos.get("status") != "open":
        return {**res, "watch_result": "not_open", "status": pos.get("status"), "delete_routine": True}
    mv = market_view(c, slug)
    m = mv["market"]
    state = (mv.get("bbo_raw") or {}).get("state") or m.get("status")
    book = outcome_book(mv, pos["outcome"])
    px, src = print_price(book)
    inval = None if pos.get("invalidation_price") is None else float(pos["invalidation_price"])
    settled = bool(m.get("closed")) or any(k in str(m.get("status")) for k in ("RESOLVED", "SETTLED"))
    result = "settled" if settled else watch_decision(px, inval)
    now = datetime.now(timezone.utc)
    res.update({"watch_result": result, "print_px": px, "print_source": src, "invalidation_price": inval,
                "bbo": {k: book.get(k) for k in ("bid", "ask", "mid", "last")}, "market_state": state,
                "watch_at_pt": now.astimezone().isoformat(timespec="seconds")})
    if result == "trip":
        res["exit_command"] = f".venv/bin/python pm_exit.py --position-id {pid} --reason invalidation"
    if settled or px is None:
        return res
    meta = {"watch_at": now.isoformat(), "watch_result": result, "action": "trip" if result == "trip" else "hold",
            "trip": result == "trip", "print_px": px, "print_source": src, "bbo_bid": book.get("bid"),
            "bbo_ask": book.get("ask"), "bbo_mid": book.get("mid"), "bbo_last": book.get("last"),
            "mark_source": "venue_best_bid" if src == "bid" else f"venue_{src}", "invalidation_price": inval,
            "market_state": state, "writer": "pm_watch", "watch_routine": routine or None}
    args = {"position_id": pid, "mark": str(px), "mark_at": now.isoformat(), "meta_patch": jsonable(meta)}
    if dry_run:
        res["would_write"] = {"fn": "oddsborne_mark_position", "args": args}
        return res
    res["ledger_updated"] = rpc("oddsborne_mark_position", args).get("updated")
    return res


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_watch.py", description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--position-id")
    g.add_argument("--all-open", action="store_true")
    ap.add_argument("--routine", default="", help="routine name stamped in meta.watch_routine")
    ap.add_argument("--dry-run", action="store_true", help="read the venue only; no ledger write")
    a = ap.parse_args(argv)
    rpc = make_rpc()
    if a.all_open:
        ids = [str(x["id"]) for x in rpc("oddsborne_open_positions", {}, idempotent=True) or []]
    else:
        ids = [a.position_id]
    c = make_client() if ids else None
    results, rc = [], 0
    for pid in ids:
        try:
            pos = rpc("oddsborne_position_get", {"position_id": pid}, idempotent=True)
            r = {"position_id": pid, "watch_result": "missing", "delete_routine": True} if pos is None else \
                watch_one(c, rpc, pos, a.dry_run, a.routine)
        except Exception as e:
            r = {"position_id": pid, "watch_result": "error", "error": f"{type(e).__name__}: {str(e)[:300]}"}
            rc = max(rc, 1)
        if r.get("watch_result") == "trip":
            rc = 10
        results.append(r)
    out = results[0] if not a.all_open and results else {"open_lots": len(ids), "results": results}
    print(json.dumps(jsonable(out), indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
