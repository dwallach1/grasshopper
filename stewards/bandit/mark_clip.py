#!/usr/bin/env python3
"""BANDIT mark_clip: one watch mark + rails decision for an open meme lot (replaces _<sym>_mark_once.py).

Usage (from /workspace/bandit):
  .venv/bin/python mark_clip.py --position-id <uuid>        # one lot
  .venv/bin/python mark_clip.py --all-open                  # every open lot
  add --dry-run to quote and decide without any ledger write.

Per lot (same as the clones): Jupiter Swap V2 /order quote for the full remaining qty (300 bps) gives
mark = outAmount / qty; pnl_pct vs average_cost_sol; cash from Helius getBalance; equity = cash + full-sell
out. Writes (public.bandit_mark_position over HTTPS, one transaction): the lot's mark_sol/mark_at and
meta.last_mark / last_watch_at / mark_source, meme_tokens.last_price_sol, one meme_pnl watch row (payload
source/position_id/mark_sol/pnl_pct_vs_entry/qty, read by paper_bank20.py), heartbeat when grants allow.

Rails, in the clones' order: past the 4h stop (opened_at + 4h) -> deadline_exit; pnl <= -40% -> kill_exit;
mark <= invalidation_price -> kill_exit; pnl >= +50% -> tp50_full_exit (FULL bank); -25% / +40% -> warn;
else hold. An exit action prints the exit_clip.py command; mark_clip never sells.
Exit code: 0 hold/warn, 10 an exit action is due (any lot), 1 error.
Then (not on --dry-run) pass_marks.sweep_quietly() prices any logged pass whose 4h horizon is up; its result is
under "pass_marks" and it never changes the exit code.
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


def mark_one(pos: dict, secrets: dict, dry_run: bool, now: datetime | None = None, cash=None) -> dict:
    pid = str(pos["id"])
    tok = pos.get("token") or {}
    mint, sym = tok.get("mint"), tok.get("symbol")
    if pos.get("status") != "open" or cc.D(pos.get("quantity")) is None or cc.D(pos["quantity"]) <= 0:
        return {"position_id": pid, "action": "delete_routine", "reason": "already_closed",
                "status": pos.get("status"), "qty": str(pos.get("quantity"))}
    qty = cc.D(pos["quantity"])
    entry = cc.D(pos["average_cost_sol"])
    decimals = cc.get_decimals(secrets["HELIUS_API_KEY"], mint)
    order = cc.jup_sell_order(secrets["JUPITER_API_KEY"], mint, cc.to_atoms(qty, decimals), cc.MARK_SLIPPAGE_BPS)
    out_raw = order.get("outAmount")
    if not out_raw:
        return {"position_id": pid, "symbol": sym, "action": "error", "where": "jupiter_order_empty",
                "err": order.get("errorMessage"), "code": order.get("errorCode")}
    out_sol = Decimal(str(out_raw)) / Decimal(10**9)
    mark = out_sol / qty
    pnl_pct = float((mark / entry - 1) * 100)
    now = now or datetime.now(timezone.utc)
    deadline = cc.deadline_for(pos["opened_at"])
    past_deadline = now >= deadline
    if cash is None:
        lamports, _slot = cc.get_balance_lamports(secrets["HELIUS_API_KEY"])
        cash = Decimal(lamports) / Decimal(10**9)
    unrealized = (mark - entry) * qty
    realized = Decimal(str((pos.get("meta") or {}).get("tp50_realized_sol") or "0"))
    equity = cash + out_sol
    inval = cc.D(pos.get("invalidation_price"))
    action, reason = cc.decide(pnl_pct, mark, inval, past_deadline)

    last_mark = {
        "source": "jupiter_swap_v2_order", "router": order.get("router"), "inAmount": order.get("inAmount"),
        "outAmount": order.get("outAmount"), "slippageBps": order.get("slippageBps"),
        "priceImpactPct": order.get("priceImpactPct"), "implied_sol_per_token": str(mark),
        "full_sell_out_sol": str(out_sol), "full_sell_out_lamports": str(out_raw),
        "pnl_pct_vs_entry": round(pnl_pct, 4), "sample": "full_remaining_qty", "decimals": decimals,
    }
    args = {
        "position_id": pid, "mark_sol": str(mark), "mark_at": now.isoformat(),
        "meta_patch": {"last_mark": last_mark, "last_watch_at": now.isoformat(),
                       "mark_source": "jupiter_swap_v2_order", "last_watch_action": action},
        "pnl": {"cash_sol": str(cash), "equity_sol": str(equity), "unrealized": str(unrealized),
                "realized": str(realized),
                "payload": {"source": "mark_clip", "position_id": pid, "symbol": sym, "mark_sol": str(mark),
                            "pnl_pct_vs_entry": round(pnl_pct, 4), "qty": str(qty), "action": action}},
    }
    res = {
        "position_id": pid, "symbol": sym, "mint": mint, "action": action, "reason": reason,
        "pnl_pct": round(pnl_pct, 4), "mark_sol": str(mark), "entry_sol": str(entry), "qty": str(qty),
        "invalidation_price": str(inval) if inval is not None else None,
        "full_sell_out_sol": str(out_sol), "unrealized_sol": str(unrealized), "realized_sol": str(realized),
        "cash_sol": str(cash), "equity_sol": str(equity), "tp_rails": "full_bank_at_+50pct",
        "now_pt": now.astimezone(cc.PT).isoformat(timespec="seconds"),
        "deadline_pt": deadline.astimezone(cc.PT).isoformat(timespec="seconds"),
        "past_deadline": past_deadline, "router": order.get("router"),
        "priceImpactPct": order.get("priceImpactPct"),
    }
    if action in cc.ACTION_TRIGGER:
        trig = "invalidation" if reason == "hit_invalidation_price" else cc.ACTION_TRIGGER[action]
        res["exit_command"] = f".venv/bin/python exit_clip.py --position-id {pid} --trigger {trig}"
    if dry_run:
        res["dry_run"] = True
        res["would_write"] = {"fn": "bandit_mark_position", "args": args}
        return res
    w = cc.ledger("bandit_mark_position", args)
    res["pnl_id"] = str(w.get("pnl_id")) if w.get("pnl_id") else None
    res["ledger_updated"] = w.get("updated")
    res["heartbeat"] = "ok" if w.get("heartbeat_updated") else f"skipped: {str(w.get('heartbeat_skipped'))[:120]}"
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mark_clip.py", description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--position-id")
    g.add_argument("--all-open", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="quote + decide only; no ledger write")
    a = ap.parse_args(argv)
    secrets = require("JUPITER_API_KEY", "HELIUS_API_KEY", "BANDIT_WORKER_DB_PASSWORD")
    if a.all_open:
        lots = [cc.ledger("bandit_position_get", {"position_id": str(x["id"])}, idempotent=True)
                for x in cc.ledger("bandit_open_positions", {}, idempotent=True) or []]
    else:
        lot = cc.ledger("bandit_position_get", {"position_id": a.position_id}, idempotent=True)
        if lot is None:
            print(json.dumps({"action": "delete_routine", "reason": "position_missing", "position_id": a.position_id}))
            return 0
        lots = [lot]
    results, rc = [], 0
    for lot in lots:
        try:
            r = mark_one(lot, secrets, a.dry_run)
        except Exception as e:
            r = {"position_id": str(lot.get("id")), "action": "error", "error": f"{type(e).__name__}: {str(e)[:300]}"}
        results.append(r)
        if r.get("action") == "error":
            rc = max(rc, 1)
        elif r.get("exit_command"):
            rc = 10
    out = results[0] if not a.all_open else {"open_lots": len(lots), "results": results}
    if not a.dry_run:
        # Score any logged pass whose 4h horizon is up (never changes this script's exit code).
        try:
            import pass_marks
            out = {**out, "pass_marks": pass_marks.sweep_quietly()}
        except Exception as e:  # e.g. pass_marks.py not synced yet: the marks above already landed
            out = {**out, "pass_marks": {"error": f"{type(e).__name__}: {str(e)[:200]}"}}
    print(cc.jdump(out))
    return rc


if __name__ == "__main__":
    sys.exit(main())
