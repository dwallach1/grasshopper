#!/usr/bin/env python3
"""BANDIT exit_clip: market-sell an open meme lot via Jupiter Swap V2 and record the close
(replaces _<sym>_kill_exit.py / _<sym>_deadline_exit.py / _<sym>_tp50_full_exit.py).

Usage (from /workspace/bandit):
  .venv/bin/python exit_clip.py --position-id <uuid> --trigger kill_-40pct|invalidation|deadline_4h_stop|tp50_full_bank|thesis_invalid|manual [--dry-run]
  mark_clip.py prints the exact command when a rail trips.

Flow (the YAP exit template, parametrized by the lot):
  1. bandit_position_get: refuse unless open and no meta.deadline_exit (an exit already ran).
  2. Keypair must be the BANDIT wallet. Sell min(ledger qty, on-chain atoms) of the mint.
  3. --dry-run stops here: prints the lot, atoms, a live Jupiter quote and the would-be realized P&L; no
     order row, no swap.
  4. bandit_exit_open_order: meme_orders sell / market / submitted (re-checked under a row lock).
  5. Jupiter /order + /execute at 300 then 500 bps, Helius sendTransaction fallback. All failed ->
     the order row is marked rejected (bandit_entry_reject_order) and nothing else changes.
  6. exit_price = out SOL / tokens in; realized = (exit_price - average_cost_sol) x tokens; poll the
     remaining balance; network + tip fee from getTransaction.
  7. bandit_exit_record_fill (one transaction): order -> filled, the sell fill linked to the lot, the lot
     closed (or reduced if tokens remain) with meta.deadline_exit + exit_reason, meme_pnl row. The
     trade_outcomes trigger prices the close from the linked fills (pnl_source 'fills', realized_pnl set).
  8. Close the emptied token account (burn+close dust), annotate the meme_pnl row; print REPORT.
Then write the close lesson: close_lesson.py --position-id <uuid> --rationale "..." --new-confidence N.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

import clip_common as cc

cc.require_runtime(("base58", "requests", "solders.keypair", "solders.transaction"))

from load_secrets import require  # noqa: E402

ORDER_META_KEYS = ("requestId", "inAmount", "outAmount", "otherAmountThreshold", "router", "mode", "feeBps",
                   "slippageBps", "priceImpactPct", "errorCode", "errorMessage")


def swap_sell(secrets: dict, kp, mint: str, sell_atoms: int) -> tuple[dict | None, dict | None, int | None, str | None, str | None]:
    """Jupiter sell with the clones' retry ladder. Returns (result, order_meta, slippage, path, last_err)."""
    last_err = order_meta = None
    for slip in cc.SLIPPAGE_TRIES:
        try:
            order = cc.jup_sell_order(secrets["JUPITER_API_KEY"], mint, sell_atoms, slip)
            order_meta = {k: order.get(k) for k in ORDER_META_KEYS if order.get(k) is not None}
            order_meta["transaction"] = "set" if order.get("transaction") else None
            tx_b64 = order.get("transaction")
            if not tx_b64:
                last_err = f"/order no transaction: {order_meta}"
                continue
            signed_b64 = cc.sign_order_tx(kp, tx_b64)
            fallback = {"status": "Success", "totalInputAmount": order.get("inAmount"),
                        "totalOutputAmount": order.get("outAmount"), "fallback": "helius_send"}
            try:
                ex = cc.jup_execute(secrets["JUPITER_API_KEY"], signed_b64, order["requestId"])
                if ex.get("status") == "Success" or ex.get("code") == 0:
                    return ex, order_meta, slip, "jupiter_execute", None
                last_err = f"/execute failed: {json.dumps(ex)[:800]}"
                sig = cc.helius_send_fallback(secrets["HELIUS_API_KEY"], signed_b64)
                return {**fallback, "signature": sig}, order_meta, slip, "helius_send_fallback", None
            except Exception as e:
                last_err = f"/execute error: {e}"
                try:
                    sig = cc.helius_send_fallback(secrets["HELIUS_API_KEY"], signed_b64)
                    return {**fallback, "signature": sig}, order_meta, slip, "helius_send_fallback", None
                except Exception as e2:
                    last_err = f"helius fallback failed: {e2}"
                    continue
        except Exception as e:
            last_err = f"slippage {slip} failed: {e}"
            continue
    return None, order_meta, None, None, last_err


def run(position_id: str, trigger: str, dry_run: bool) -> tuple[int, dict]:
    import base58
    from solders.keypair import Keypair

    need = ["HELIUS_API_KEY", "JUPITER_API_KEY", "BANDIT_WORKER_DB_PASSWORD"]
    secrets = require(*(need if dry_run else ["BANDIT_SOLANA_PRIVATE_KEY", *need]))
    pos = cc.ledger("bandit_position_get", {"position_id": position_id}, idempotent=True)
    if pos is None:
        return 2, {"ok": False, "reason": "position_missing", "position_id": position_id}
    if pos.get("status") != "open":
        return 0, {"ok": False, "reason": "not_open", "status": pos.get("status"), "position_id": position_id}
    if (pos.get("meta") or {}).get("deadline_exit"):
        return 0, {"ok": False, "reason": "deadline_exit_already_done", "position_id": position_id}
    tok = pos.get("token") or {}
    mint, sym = tok["mint"], tok.get("symbol")
    kp = None
    if not dry_run:
        kp = Keypair.from_bytes(base58.b58decode(secrets["BANDIT_SOLANA_PRIVATE_KEY"]))
        if str(kp.pubkey()) != cc.WALLET:
            return 1, {"ok": False, "reason": "keypair_pubkey_mismatch"}
    hk = secrets["HELIUS_API_KEY"]
    decimals = cc.get_decimals(hk, mint)
    qty_db, avg = cc.D(pos["quantity"]), cc.D(pos["average_cost_sol"])
    onchain_atoms = cc.get_token_atoms(hk, mint)
    if onchain_atoms <= 0:
        return 1, {"ok": False, "reason": f"wallet has 0 {sym} atoms", "ledger_qty": str(qty_db)}
    sell_atoms = min(onchain_atoms, cc.to_atoms(qty_db, decimals))
    if sell_atoms < 1:
        return 1, {"ok": False, "reason": "sell_atoms < 1"}
    sell_tokens = Decimal(sell_atoms) / Decimal(10**decimals)
    bal0, slot0 = cc.get_balance_lamports(hk)
    base = {"position_id": position_id, "symbol": sym, "mint": mint, "trigger": trigger, "decimals": decimals,
            "ledger_qty": str(qty_db), "onchain_atoms": onchain_atoms, "sell_atoms": sell_atoms,
            "sell_tokens": str(sell_tokens), "entry_avg_sol": str(avg), "pre_sol_lamports": bal0}

    if dry_run:
        q = cc.jup_sell_order(secrets["JUPITER_API_KEY"], mint, sell_atoms, cc.SLIPPAGE_TRIES[0])
        out = q.get("outAmount")
        quote = {k: q.get(k) for k in ORDER_META_KEYS if q.get(k) is not None}
        est = {}
        if out:
            out_sol = Decimal(str(out)) / Decimal(10**9)
            px = out_sol / sell_tokens
            est = {"exit_price_sol": str(px), "out_sol": str(out_sol), "realized_sol_est": str((px - avg) * sell_tokens),
                   "pnl_pct_est": round(float((px / avg - 1) * 100), 4)}
        return 0, {"ok": True, "decision": "DRY_RUN_OK", **base, "quote": quote, "estimate": est,
                   "note": "dry-run: no meme_orders row, no swap, no ledger write"}

    o = cc.ledger("bandit_exit_open_order", {
        "position_id": position_id, "size_sol": str(sell_tokens * avg), "size_tokens": str(sell_tokens),
        "kill_criteria": cc.KILL, "rationale": f"{sym} exit ({trigger}: {cc.TRIGGERS[trigger]}) — market-sell remaining",
        "gate_results": {"trigger": trigger, "pre_balance_lamports": bal0},
        "payload": {"mint": mint, "symbol": sym, "wallet": cc.WALLET, "sell_atoms": sell_atoms, "position_id": position_id,
                    "slippage_plan_bps": cc.SLIPPAGE_TRIES, "writer": "exit_clip"}})
    order_id = str(o["order_id"])

    result, order_meta, slip, path, last_err = swap_sell(secrets, kp, mint, sell_atoms)
    if not result:
        cc.ledger("bandit_entry_reject_order", {"order_id": order_id,
                                                "payload": {"error": str(last_err), "order_meta": order_meta}})
        return 1, {"ok": False, "decision": "FAILED", **base, "order_id": order_id, "error": str(last_err)}

    sig = result.get("signature")
    in_raw = result.get("totalInputAmount") or result.get("inputAmountResult") or sell_atoms
    out_raw = result.get("totalOutputAmount") or result.get("outputAmountResult") or (order_meta or {}).get("outAmount")
    if out_raw is None:
        return 1, {"ok": False, "decision": "SOLD_UNPRICED", **base, "order_id": order_id, "signature": sig,
                   "error": "no SOL out amount from venue; record by hand (order row is 'submitted')"}
    remain_atoms = bal1 = slot1 = None
    for _ in range(30):  # Jupiter Success can precede the Helius balance
        time.sleep(1.5)
        try:
            remain_atoms = cc.get_token_atoms(hk, mint)
            bal1, slot1 = cc.get_balance_lamports(hk)
            if remain_atoms == 0 or remain_atoms < sell_atoms:
                break
        except Exception:
            continue
    if remain_atoms is None:
        remain_atoms = cc.get_token_atoms(hk, mint)
    if bal1 is None:
        bal1, slot1 = cc.get_balance_lamports(hk)
    fee_sol, fee_bd = cc.fetch_fee_breakdown(hk, sig)
    now = datetime.now(timezone.utc)
    args = cc.exit_fill_args(pos, order_id, trigger, sig, int(in_raw), int(out_raw), decimals, remain_atoms, bal1, slot1,
                          fee_sol, fee_bd, order_meta, path, slip, result, now)
    comp = args.pop("_computed")
    try:
        w = cc.ledger("bandit_exit_record_fill", args)
    except Exception as e:
        from pathlib import Path
        fb = Path(os.environ.get("BANDIT_STATE_DIR") or cc._HERE) / f"exit_clip_orphan_{position_id}_{int(time.time())}.json"
        fb.write_text(cc.jdump({"args": args, "base": base}))
        return 1, {"ok": False, "decision": "SOLD_LEDGER_FAILED", **base, "signature": sig, "order_id": order_id,
                   "error": f"{type(e).__name__}: {str(e)[:300]}", "saved": str(fb),
                   "retry": "the swap landed; replay the saved args with bandit_exit_record_fill (idempotent on the fill)"}
    closed = bool(w.get("closed"))
    close_info = cc.close_token_accounts_safe(hk, kp, mint, closed, comp["exit_price"])
    try:
        if w.get("pnl_id"):
            cc.ledger("bandit_annotate_pnl", {"pnl_id": str(w["pnl_id"]), "payload": {
                "token_account_close": close_info, "close_sig": close_info.get("close_sig"),
                "rent_reclaimed_lamports": close_info.get("rent_reclaimed_lamports"),
                "close_error": close_info.get("error")}})
    except Exception as e:
        close_info["annotate_error"] = type(e).__name__
    report = {
        "ok": True, "decision": "EXITED", "trigger": trigger, "signature": sig, "path": path, "slippage_bps": slip,
        "sold_tokens": str(comp["in_tokens"]), "out_sol": str(comp["out_sol"]),
        "exit_price_sol_per_token": str(comp["exit_price"]), "entry_avg_sol": str(avg),
        "realized_this_sol": comp["realized_this_sol"], "realized_total_sol": comp["realized_total_sol"],
        "remaining_tokens": str(comp["remain_tokens"]), "remaining_onchain_atoms": remain_atoms,
        "ending_sol_balance": str(comp["cash_sol"]), "closed": closed,
        "trade_outcome": {"realized_pnl": w.get("realized_pnl"), "pnl_source": w.get("pnl_source")},
        "ledger": {"token_id": (pos.get("token") or {}).get("id"), "order_id": order_id, "fill_id": w.get("fill_id"),
                   "position_id": position_id, "pnl_id": w.get("pnl_id")},
        "heartbeat": "ok" if w.get("heartbeat_updated") else f"skipped: {str(w.get('heartbeat_skipped'))[:120]}",
        "solscan": f"https://solscan.io/tx/{sig}", "delete_routine": closed, "token_account_close": close_info,
        "next": (f'.venv/bin/python close_lesson.py --position-id {position_id} --rationale "<what this close taught>" '
                 "--new-confidence <1-100>") if closed else None,
    }
    return 0, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="exit_clip.py", description=__doc__.split("\n")[0])
    ap.add_argument("--position-id", required=True)
    ap.add_argument("--trigger", required=True, choices=sorted(cc.TRIGGERS))
    ap.add_argument("--dry-run", action="store_true", help="lot + on-chain atoms + Jupiter quote only; no order, no swap")
    a = ap.parse_args(argv)
    rc, out = run(a.position_id, a.trigger, a.dry_run)
    print("REPORT=" + json.dumps(out, indent=2, default=str))
    return rc


if __name__ == "__main__":
    sys.exit(main())
