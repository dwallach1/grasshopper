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

Pre-kickoff fair-drift scratch (GRASSHOPPER ruling 10/20): for an open sports YES lot whose market has a
gameStartTime in the future, the watch reads the current devig fair from the same multi-book line source the session
uses (lines.py: Bovada always + any enabled books; lines.fair_for_market -> side_fair(..., "yes")["used"], the
conservative fair the entry gate used). fair < entry (average_cost) - 0.01 -> TRIP with reason
prekickoff_fair_drift (exit code 10; exit_command = pm_exit.py --reason prekickoff_fair_drift, which sells the
full lot at the outcome best bid). Same ordering as an invalidation trip: exit first, no pm_pnl from the watch.
After kickoff (or no gameStartTime) only the invalidation stop applies. Fair unavailable (no date-matched,
fresh, pre-game book line) -> no scratch, logged as 'INFO prekickoff fair unavailable' + fair_drift.status.
Lines are fetched at most once per pass and only when a pre-kickoff YES lot exists. Never invents a fair.
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


FAIR_DRIFT_C = 0.01  # GRASSHOPPER 10/20: scratch when fair is more than 1c below entry


def _gst(m: dict):
    g = m.get("gameStartTime")
    if not g:
        return None
    try:
        return datetime.fromisoformat(str(g).replace("Z", "+00:00"))
    except ValueError:
        return None


def _teams(m: dict):
    lt = st = None
    for sd in m.get("marketSides") or []:
        nm = (sd.get("team") or {}).get("name") or sd.get("description")
        if sd.get("long"):
            lt = nm
        else:
            st = nm
    return lt, st


def load_games():
    """Fresh grouped quotes from every enabled book (the session's lines.py source). Raw JSON goes to a temp dir."""
    import tempfile
    import lines as LINES
    blockers: list = []
    out = tempfile.mkdtemp(prefix="pm_watch_lines_")
    games = LINES.group_games(LINES.fetch_all(out, "pm_watch", datetime.now().strftime("%Y-%m-%d"), blockers,
                                              log=lambda *a, **k: None))
    return games, blockers


def current_fair(m: dict, games, gst, now) -> dict:
    """YES-side conservative devig fair for the venue market from `games`; {"fair": None, "why": ...} if none."""
    import lines as LINES
    lt, st = _teams(m)
    if games is None:
        return {"fair": None, "why": "line fetch failed"}
    ffm = LINES.fair_for_market(games, lt, st, gst, now=now)
    if ffm["combo"] is None or not ffm["yes_team"]:
        return {"fair": None, "why": f"no date-matched pre-game line (long={lt}, short={st}, rejected="
                                     f"{[(x['book'], x['reason']) for x in ffm['rejected']]})"}
    cf = LINES.side_fair(ffm["combo"], ffm["yes_team"], "yes")
    if not cf or cf.get("used") is None:
        return {"fair": None, "why": f"no two-way devig for {lt}"}
    return {"fair": round(float(cf["used"]), 4), "method": cf.get("method"), "books": cf.get("books")}


def fair_drift_check(pos: dict, m: dict, now, get_games) -> dict | None:
    """None when the rule does not apply (not YES, no entry, no gameStartTime, or kickoff passed)."""
    if str(pos.get("outcome")).lower() != "yes" or pos.get("average_cost") is None:
        return None
    gst = _gst(m)
    if gst is None or gst <= now:
        return None
    entry = float(pos["average_cost"])
    games = get_games()
    f = current_fair(m, games, gst, now)
    out = {"entry": entry, "threshold": round(entry - FAIR_DRIFT_C, 4), "game_start": gst.isoformat(), **f}
    if f["fair"] is None:
        out["status"] = "fair_unavailable"
        print(f"INFO prekickoff fair unavailable for {pos.get('id')}: {f['why']} (no scratch)", file=sys.stderr, flush=True)
    else:
        out["status"] = "scratch" if f["fair"] < entry - FAIR_DRIFT_C - 1e-9 else "ok"
    return out


def watch_decision(px, inval) -> str:
    if px is None:
        return "no_print"
    if inval is not None and px <= inval:
        return "trip"
    return "hold_above_line"


def watch_one(c, rpc, pos: dict, dry_run: bool, routine: str = "", get_games=None) -> dict:
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
    reason = "invalidation"
    if not settled and result != "trip":
        fd = fair_drift_check(pos, m, now, get_games or (lambda: load_games()[0]))
        if fd is not None:
            res["fair_drift"] = fd
            if fd["status"] == "scratch":
                result, reason = "trip", "prekickoff_fair_drift"
    res.update({"watch_result": result, "print_px": px, "print_source": src, "invalidation_price": inval,
                "bbo": {k: book.get(k) for k in ("bid", "ask", "mid", "last")}, "market_state": state,
                "watch_at_pt": now.astimezone().isoformat(timespec="seconds")})
    if result == "trip":
        res["trip_reason"] = reason
        res["exit_command"] = f".venv/bin/python pm_exit.py --position-id {pid} --reason {reason}"
    if settled or px is None:
        return res
    meta = {"watch_at": now.isoformat(), "watch_result": result, "action": "trip" if result == "trip" else "hold",
            "trip": result == "trip", "trip_reason": reason if result == "trip" else None,
            "fair_drift": res.get("fair_drift"), "print_px": px, "print_source": src, "bbo_bid": book.get("bid"),
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
    cache: dict = {}

    def get_games():  # one line fetch per pass, only if a pre-kickoff YES lot asks
        if "g" not in cache:
            try:
                cache["g"], bl = load_games()
                if bl:
                    print(f"INFO line blockers: {bl}", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"INFO line fetch failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr, flush=True)
                cache["g"] = None
        return cache["g"]
    for pid in ids:
        try:
            pos = rpc("oddsborne_position_get", {"position_id": pid}, idempotent=True)
            r = {"position_id": pid, "watch_result": "missing", "delete_routine": True} if pos is None else \
                watch_one(c, rpc, pos, a.dry_run, a.routine, get_games)
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
