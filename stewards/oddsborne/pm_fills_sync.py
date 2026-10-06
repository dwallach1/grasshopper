#!/usr/bin/env python3
"""ODDSBORNE pm_fills_sync: record the fills of a resting BUY order that filled after pm_enter returned
(maker GTC), and open or add to its lot, so the lot can be marked and later closed with realized P&L.

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_fills_sync.py --venue-order-id CV44MW19GYH4 [--dry-run]

Why: pm_enter records only the fills present when it returns. The 10/1 TEN/MIA maker orders filled later,
their buy fills never reached pm_fills, and the 10/4 closes were left with realized_pnl null.
Flow: oddsborne_order_get (the pm_orders row pm_enter wrote: thesis, invalidation, market) -> venue order
state + portfolio.activities for that order -> the same entry RPCs pm_enter uses (oddsborne_entry_record_fills,
oddsborne_entry_upsert_position, linked to the lot) -> pm_orders status from the venue -> heartbeat.
Refuses when the venue no longer holds the shares (the lot was already sold: record that exit with
pm_exit.py --record-only instead of opening a new lot). Sell orders: use pm_exit.py --record-only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import Decimal

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

from pm_enter import (  # noqa: E402
    ACCOUNT, Refusal, _require_runtime, jsonable, make_client, make_rpc, record_fills, status_from_venue,
    upsert_position, vcall,
)
from pm_exit import EPS, net_position, venue_trades  # noqa: E402


def plan(order: dict, venue_fills: list, held: Decimal) -> dict:
    """What a sync would do (pure; unit-tested). venue_fills = this order's parsed executions."""
    db_qty = Decimal(str((order.get("fills") or {}).get("qty") or 0))
    venue_qty = sum((Decimal(f["quantity"]) for f in venue_fills), Decimal(0))
    new_qty = venue_qty - db_qty
    p = {"venue_fill_qty": str(venue_qty), "ledger_fill_qty": str(db_qty), "new_qty": str(new_qty),
         "venue_net_position": str(held)}
    if order.get("side") != "buy":
        p["refuse"] = ("input", f"order {order.get('venue_order_id')} is a {order.get('side')}; "
                                "record sells with pm_exit.py --record-only")
    elif new_qty <= EPS:
        p["action"] = "none"
    elif held + EPS < new_qty:
        p["refuse"] = ("venue", f"venue holds {held} on the market but {new_qty} fills are unrecorded: the shares were "
                                "already sold, so opening a lot now would be wrong. Record the entry fills with the exit "
                                "(pm_exit.py --record-only --venue-order-id <sell>) or by hand.")
    elif order.get("invalidation_price") in (None, ""):
        p["refuse"] = ("input", "the pm_orders row has no gate_results.invalidation_price; pass --invalidation")
    else:
        p["action"] = "record_and_open_or_add"
    return p


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_fills_sync.py", description=__doc__.split("\n")[0])
    ap.add_argument("--venue-order-id", required=True)
    ap.add_argument("--invalidation", type=float, default=None, help="only if the order row lacks one")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    rpc = make_rpc()
    out = {"venue_order_id": a.venue_order_id, "mode": "dry_run" if a.dry_run else "live"}
    try:
        order = rpc("oddsborne_order_get", {"venue_order_id": a.venue_order_id, "account_key": ACCOUNT}, idempotent=True)
        if order is None:
            raise Refusal("input", f"no pm_orders row for venue order {a.venue_order_id} (pm_enter writes it)")
        if a.invalidation is not None:
            order["invalidation_price"] = a.invalidation
        out["order"] = {k: order.get(k) for k in ("slug", "side", "outcome", "size", "price", "status", "thesis_id",
                                                  "invalidation_price", "fills")}
        c = make_client()
        ret = (vcall(c.orders.retrieve, a.venue_order_id) or {}).get("order") or {}
        out["venue_state"] = vstate = ret.get("state")
        fills = [t for t in venue_trades(c, order["slug"]) if t["venue_order_id"] == a.venue_order_id]
        held, _hit = net_position(vcall(c.portfolio.positions), order["slug"])
        p = plan(order, fills, held)
        out["plan"] = p
        out["venue_fills"] = [{k: f[k] for k in ("venue_fill_id", "quantity", "price", "fee", "executed_at")} for f in fills]
        if p.get("refuse"):
            raise Refusal(*p["refuse"])
        if a.dry_run:
            out["decision"] = "DRY_RUN_OK"
            print(json.dumps(jsonable(out), indent=1))
            return 0
        if p["action"] != "none":
            rec = record_fills(c, rpc, order["slug"], a.venue_order_id, str(order["pm_order_id"]), str(order["market_id"]))
            out["fills"] = rec
            out["position"] = upsert_position(rpc, str(order["market_id"]), order["outcome"], order["thesis_id"],
                                              float(order["invalidation_price"]), order.get("invalidation_note") or "",
                                              order.get("kill_criteria") or "", str(order["pm_order_id"]), rec)
        if vstate:
            out["status"] = rpc("oddsborne_order_set_status", {
                "venue_order_id": a.venue_order_id, "account_key": ACCOUNT, "status": status_from_venue(vstate),
                "payload_patch": {"synced_by": "pm_fills_sync", "venue_state": vstate,
                                  "cum_quantity": ret.get("cumQuantity")}})
        out["heartbeat_at"] = str(rpc("oddsborne_entry_heartbeat", {})["heartbeat_at"])
        out["decision"] = "SYNCED" if p["action"] != "none" else "NOTHING_NEW"
        print(json.dumps(jsonable(out), indent=1))
        return 0
    except Refusal as r:
        out["decision"], out["refused"] = "REFUSED", {"gate": r.gate, "reason": r.reason}
        print(json.dumps(jsonable(out), indent=1))
        return 2
    except Exception as e:
        ref = getattr(e, "refusal", None)
        out["decision"] = "REFUSED" if ref else "ERROR"
        out["refused" if ref else "error"] = {"gate": ref[0], "reason": ref[1]} if ref else f"{type(e).__name__}: {str(e)[:400]}"
        print(json.dumps(jsonable(out), indent=1))
        return 2 if ref else 1


if __name__ == "__main__":
    sys.exit(main())
