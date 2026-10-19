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
When a non-trip pass marks at least one lot it also writes one pm_pnl row through pm_pnl_snapshot.refresh_snapshot
(cash + open lots at the venue mark from account.balances + portfolio.positions, writer pm_watch), so the book
row keeps up with the marks. A pass that trips (exit 10) writes no pm_pnl: the exit comes first, and pm_exit's
oddsborne_exit_record writes the pm_pnl row with post-sell venue cash. A refused or failed refresh prints
'WARN pm_pnl refresh failed' and never changes the watch result or exit code (no invented marks; no
pm_decision_markets sweep). --dry-run reports the would-write.
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

from pm_enter import _require_runtime, jsonable, make_client, make_rpc, market_view, outcome_book, vcall  # noqa: E402
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


def marked(r: dict) -> bool:
    """True when watch_one marked the lot from the venue (live: ledger updated; dry-run: a mark would be written)."""
    return bool(r.get("ledger_updated")) or "would_write" in r


def refresh_pnl(c, rpc, n_marked: int, dry_run: bool, routine: str = "") -> dict | None:
    """One pm_pnl row after the watch marked lot(s): pm_pnl_snapshot.refresh_snapshot on the venue balances and
    positions (same valuation as session_daily/session_pm), writer pm_watch. Nothing when no lot was marked.
    Never raises: a refusal (unvalued venue position) or any failure is a WARN and the watch carries on."""
    if not n_marked:
        return None
    try:
        import pm_pnl_snapshot as PS
        bal = vcall(c.account.balances, tries=2)
        pos = vcall(c.portfolio.positions, tries=2)
        notes = f"pm_watch {routine or 'manual'}: marked {n_marked} open lot(s) from the venue"
        res = PS.refresh_snapshot(rpc, bal, pos, notes, dry_run=dry_run, writer="pm_watch")
        if dry_run:
            return res
        return {"decision": res["decision"], "pm_pnl_id": res.get("pm_pnl_id"), "equity": res["args"]["equity"],
                "cash": res["args"]["cash"], "asset_source": res["args"]["payload"]["asset_source"]}
    except Exception as e:
        msg = f"WARN pm_pnl refresh failed: {type(e).__name__}: {str(e)[:300]}"
        print(msg, file=sys.stderr, flush=True)
        return {"decision": "WARN", "warn": msg}


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
    if rc == 10:  # trip: exit first; pm_exit writes pm_pnl after the sell, so a hung ledger can't delay the exit
        pnl = {"decision": "SKIPPED_TRIP", "why": "pass tripped: pm_exit writes the pm_pnl row after the sell"}
    else:
        pnl = refresh_pnl(c, rpc, sum(1 for r in results if marked(r)), a.dry_run, a.routine)
    out = results[0] if not a.all_open and results else {"open_lots": len(ids), "results": results}
    if pnl is not None:
        out["pm_pnl_refresh"] = pnl
    print(json.dumps(jsonable(out), indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
