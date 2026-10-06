#!/usr/bin/env python3
"""ODDSBORNE pm_exit: sell (or record the sell of) an open Polymarket US lot and close it in the ledger
with realized P&L (replaces watch_*_sell.py + watch_*_record.py + the hand-written MCP ledger close).

Usage (from /workspace/oddsborne):
  .venv/bin/python pm_exit.py --position-id <uuid> --reason invalidation [--dry-run]
  .venv/bin/python pm_exit.py --position-id <uuid> --reason take_profit --price 0.62 [--order-type gtc]
  .venv/bin/python pm_exit.py --position-id <uuid> --reason invalidation --record-only --venue-order-id CX3A2QTFJYG6

Flow:
  1. oddsborne_position_get (over HTTPS as oddsborne_worker): refuse unless the lot is open.
  2. Live market + BBO; print = outcome bid -> last -> mid (the watch scripts' print). --reason invalidation
     aborts when the print is above the lot's invalidation_price (ABORT_ABOVE_LINE) unless --force.
  3. Quantity = min(lot qty, venue netPosition on the slug); sell price = --price or the outcome bid.
     orders.preview (refuse if rejected). --dry-run stops here (also reports whether the close would be
     priced from fills). Live: orders.create once (never retried), IOC by default (pm_orders 'fak').
  4. portfolio.activities for the slug: the exit fills (this sell order) AND the lot's entry fills (fills on the
     buy orders pm_orders holds for this market/outcome, after the last earlier-lot sell). Cash from account.balances.
     The lot's quantity is the venue-backed one: when maker fills landed after pm_enter returned, the ledger lot
     is short and the exit sells (and links) the full position.
  5. oddsborne_exit_record (one transaction): the sell pm_orders row, entry fills inserted/linked (the
     10/4 TEN/MIA closes lacked them, so realized_pnl stayed null), exit fills linked, lot closed (or
     reduced), pm_pnl row. Closing needs linked buys = linked sells, so trade_outcomes gets realized_pnl
     with pnl_source 'fills'; otherwise it refuses (fills_incomplete) unless --allow-unpriced "<why>".
Then: close_lesson.py --position-id <uuid> --rationale "..." --new-confidence N.
Exit code: 0 closed/reduced/dry-run/order recorded, 2 refused or aborted, 1 error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

from pm_enter import (  # noqa: E402
    CALL_SLEEP, ORDER_TYPES, OUT_DIR, Refusal, _require_runtime, jsonable, make_client, make_rpc, market_view,
    outcome_book, status_from_venue, vcall,
)

EXIT_ORDER_TYPES = {k: ORDER_TYPES[k] for k in ("ioc", "fok", "gtc")}
REASONS = ("invalidation", "take_profit", "thesis_exit", "pre_settle", "edge_gone", "manual")
EPS = Decimal("0.000001")


# ----------------------------------------------------------------- venue parsing (pure; unit-tested)
def parse_trades(activities: list) -> list:
    """Our executions from portfolio.activities (pm_enter.record_fills' parse, for every order)."""
    rows = []
    for a in activities or []:
        if a.get("type") != "ACTIVITY_TYPE_TRADE":
            continue
        tr = a.get("trade") or {}
        ex = tr.get("aggressorExecution") if tr.get("isAggressor") else tr.get("passiveExecution")
        if not ex:
            continue
        o = ex.get("order") or {}
        outcome = {"OUTCOME_SIDE_YES": "yes", "OUTCOME_SIDE_NO": "no"}.get(o.get("outcomeSide"))
        side = {"ORDER_ACTION_BUY": "buy", "ORDER_ACTION_SELL": "sell"}.get(o.get("action"))
        if outcome is None or side is None:
            outcome, side = {"ORDER_INTENT_BUY_LONG": ("yes", "buy"), "ORDER_INTENT_SELL_LONG": ("yes", "sell"),
                             "ORDER_INTENT_BUY_SHORT": ("no", "buy"),
                             "ORDER_INTENT_SELL_SHORT": ("no", "sell")}.get(o.get("intent"), (None, None))
        if outcome is None:
            continue
        rows.append({
            "venue_fill_id": ex["id"], "venue_order_id": o.get("id"), "outcome": outcome, "side": side,
            "quantity": str(Decimal(str(ex["lastShares"]))), "price": str(Decimal(str(ex["lastPx"]["value"]))),
            "fee": str(Decimal(str((ex.get("commissionNotionalCollected") or {}).get("value") or 0))),
            "executed_at": ex.get("transactTime") or tr.get("createTime"),
            "payload": {"source": "portfolio.activities", "writer": "pm_exit", "trade_id": tr.get("id"),
                        "execution_id": ex["id"], "is_aggressor": bool(tr.get("isAggressor")),
                        "fee_field": "execution.commissionNotionalCollected (negative = maker rebate)"},
        })
    return rows


def exit_fills_for(trades: list, venue_order_id: str, outcome: str) -> list:
    return [t for t in trades if t["venue_order_id"] == venue_order_id and t["side"] == "sell" and t["outcome"] == outcome]


def entry_fills_for(trades: list, entry_order_ids: set, outcome: str) -> list:
    return [t for t in trades if t["venue_order_id"] in entry_order_ids and t["side"] == "buy" and t["outcome"] == outcome]


def _ts(v) -> datetime | None:
    """Venue timestamps carry nanoseconds ('...18:20:53.122572693Z'); keep microseconds."""
    if v is None or isinstance(v, datetime):
        return v
    s = str(v).replace("Z", "+00:00")
    m = re.match(r"^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", s)
    if m and m.group(2):
        s = m.group(1) + m.group(2)[:7] + m.group(3)
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def lot_entry_fills(trades: list, entry_order_ids: set, outcome: str, opened_at) -> tuple[list, str | None]:
    """This lot's buys: fills on its entry orders executed after the last sell on this outcome that predates
    the lot's opened_at (one open lot per market/outcome, so earlier sells closed an earlier lot)."""
    opened = _ts(opened_at)
    prior = [_ts(t["executed_at"]) for t in trades
             if t["outcome"] == outcome and t["side"] == "sell" and opened and _ts(t["executed_at"]) < opened]
    cutoff = max(prior) if prior else None
    fills = [t for t in entry_fills_for(trades, entry_order_ids, outcome)
             if cutoff is None or _ts(t["executed_at"]) > cutoff]
    return fills, (cutoff.isoformat() if cutoff else None)


def lot_quantities(pos: dict, entry: list) -> dict:
    """Ledger vs venue view of the lot. The ledger lags when maker fills landed after pm_enter returned
    (the 10/1 TEN/MIA case): the venue-backed quantity is what the lot really holds and what gets sold."""
    lf = pos.get("linked_fills") or {}
    lot_q = Decimal(str(pos.get("quantity") or 0))
    sold = Decimal(str(lf.get("sell_qty") or 0))
    bought = sum((Decimal(f["quantity"]) for f in entry), Decimal(0))
    true_q = max(lot_q, bought - sold)
    return {"ledger_qty": str(lot_q), "linked_sell_qty": str(sold), "linked_buy_qty": str(lf.get("buy_qty") or 0),
            "venue_entry_buy_qty": str(bought), "lot_qty": str(true_q),
            "ledger_behind": bought - sold > lot_q + EPS, "complete": bought + EPS >= lot_q + sold}


def print_price(book: dict):
    """The watch scripts' print: outcome bid, else last, else mid."""
    for k in ("bid", "last", "mid"):
        if book.get(k) is not None:
            return book[k], k
    return None, None


def net_position(positions_resp: dict, slug: str):
    raw = (positions_resp or {}).get("availablePositions") or (positions_resp or {}).get("positions") or {}
    hit = raw.get(slug) if isinstance(raw, dict) else next((p for p in raw if (p or {}).get("marketSlug") == slug or
                                                            ((p or {}).get("marketMetadata") or {}).get("slug") == slug), None)
    if not isinstance(hit, dict):
        return Decimal(0), None
    v = hit.get("netPosition") if hit.get("netPosition") is not None else hit.get("qtyAvailable")
    return (abs(Decimal(str(v))) if v is not None else Decimal(0)), hit


def venue_cash(balances_resp: dict) -> tuple:
    b0 = ((balances_resp or {}).get("balances") or [{}])[0]
    cash = b0.get("currentBalance")
    return (None if cash is None else Decimal(str(cash))), b0.get("assetNotional")


def sell_params(slug: str, outcome: str, price: float, qty: int, order_type: str) -> dict:
    tif, _pdi, _lt = EXIT_ORDER_TYPES[order_type]
    long_px = price if outcome == "yes" else round(1.0 - price, 6)  # price.value is always the long (yes) price
    return {"marketSlug": slug, "intent": "ORDER_INTENT_SELL_LONG" if outcome == "yes" else "ORDER_INTENT_SELL_SHORT",
            "type": "ORDER_TYPE_LIMIT", "price": {"value": f"{long_px:.4f}", "currency": "USD"}, "quantity": int(qty),
            "tif": tif, "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC", "participateDontInitiate": False}


# ----------------------------------------------------------------- venue I/O
def venue_trades(c, slug: str) -> list:
    r = vcall(c.portfolio.activities, {"limit": 100, "marketSlug": slug, "types": ["ACTIVITY_TYPE_TRADE"],
                                       "sortOrder": "SORT_ORDER_DESCENDING"})
    return parse_trades((r or {}).get("activities") or [])


def build_record_args(pos: dict, vo: str, ret: dict | None, params: dict | None, order_type: str, price, xf: list,
                      ef: list, reason: str, cash, rationale: str, allow_unpriced: str | None, extra: dict) -> dict:
    """Arguments for public.oddsborne_exit_record (pure; unit-tested). xf = this sell's fills, ef = the lot's buys."""
    now = datetime.now(timezone.utc).isoformat()
    args = {
        "position_id": str(pos["id"]), "exit_reason": reason,
        "order": {"venue_order_id": vo, "order_type": EXIT_ORDER_TYPES.get(order_type, ORDER_TYPES["ioc"])[2],
                  "size": (params or {}).get("quantity") or (ret or {}).get("quantity"),
                  "price": None if price is None else str(price), "status": status_from_venue((ret or {}).get("state")),
                  "rationale": rationale or f"pm_exit {reason}", "submitted_at": (ret or {}).get("createTime"),
                  "gate_results": jsonable(extra.get("gate_results") or {}),
                  "payload": jsonable({"params": params, "retrieve": ret, "writer": "pm_exit", **(extra.get("payload") or {})})},
        "entry_fills": ef, "exit_fills": xf,
        "exit_meta": {"exit_writer": "pm_exit", "exit_recorded_at": now},
        "pnl_notes": f"pm_exit {reason} {pos.get('market', {}).get('slug')}",
        "pnl_payload": {"source": "account.balances", "writer": "pm_exit"},
    }
    if cash is not None:
        args["cash"], args["as_of"] = str(cash), now
    if allow_unpriced:
        args["allow_unpriced"], args["unpriced_reason"] = True, allow_unpriced
    return args


def run(a) -> tuple[int, dict]:
    rpc = make_rpc()
    out: dict = {"position_id": a.position_id, "reason": a.reason, "mode": "dry_run" if a.dry_run else
                 ("record_only" if a.record_only else "live")}
    try:
        pos = rpc("oddsborne_position_get", {"position_id": a.position_id}, idempotent=True)
        if pos is None:
            raise Refusal("input", f"pm position {a.position_id} not found")
        out["lot"] = {k: pos.get(k) for k in ("status", "outcome", "quantity", "average_cost", "mark", "invalidation_price",
                                              "thesis_id", "linked_fills")}
        out["slug"] = slug = (pos.get("market") or {}).get("slug")
        if pos.get("status") != "open":
            raise Refusal("state", f"lot is {pos.get('status')}")
        outcome = pos["outcome"]
        entry_ids = {o["venue_order_id"] for o in pos.get("entry_orders") or [] if o.get("venue_order_id")}
        if a.entry_order_ids:
            entry_ids = set(a.entry_order_ids.split(","))
        out["entry_order_ids"] = sorted(entry_ids)
        c = make_client()

        if a.record_only:
            if not a.venue_order_id:
                raise Refusal("input", "--record-only needs --venue-order-id")
            vo, params, price = a.venue_order_id, None, None
            ret = (vcall(c.orders.retrieve, vo) or {}).get("order")
            if ret and ret.get("marketSlug") not in (None, slug):
                raise Refusal("input", f"venue order {vo} is on {ret.get('marketSlug')}, not {slug}")
            order_type = "ioc" if (ret or {}).get("tif") == ORDER_TYPES["ioc"][0] else "gtc"
            extra = {"gate_results": {"record_only": True}}
        else:
            mv = market_view(c, slug)
            m = mv["market"]
            if m.get("closed") or any(k in str(m.get("status")) for k in ("RESOLVED", "CLOSED", "SETTLED", "HALT")):
                raise Refusal("market", f"market not tradable: status={m.get('status')} closed={m.get('closed')} "
                                        "(settled lots close via settlement, not pm_exit)")
            book = outcome_book(mv, outcome)
            px, px_src = print_price(book)
            inval = None if pos.get("invalidation_price") is None else float(pos["invalidation_price"])
            out["book"] = {**book, "print": px, "print_source": px_src, "invalidation_price": inval}
            if a.reason == "invalidation" and not a.force:
                if px is None:
                    raise Refusal("no_print", "no bid/last/mid to compare with the invalidation line")
                if inval is not None and px > inval:
                    out["decision"] = "ABORT_ABOVE_LINE"
                    out["why"] = f"print {px} > invalidation {inval}: no sell (use --force to override)"
                    return 2, out
            price = a.price if a.price is not None else book["bid"]
            if price is None or not (0 < price < 1):
                raise Refusal("market", f"no usable sell price (outcome bid {book['bid']}); pass --price")
            pos_resp = vcall(c.portfolio.positions)
            held, hit = net_position(pos_resp, slug)
            pre_entry, cutoff = lot_entry_fills(venue_trades(c, slug), entry_ids, outcome, pos.get("opened_at"))
            lq = lot_quantities(pos, pre_entry)
            out["lot_quantities"] = {**lq, "entry_cutoff": cutoff}
            if lq["ledger_behind"]:
                out.setdefault("warnings", []).append(
                    f"ledger lot {lq['ledger_qty']} < venue-backed {lq['lot_qty']} (late entry fills); the exit links them")
            lot_q = Decimal(lq["lot_qty"])
            qty = int(min(lot_q, held).to_integral_value(rounding=ROUND_FLOOR))
            out["venue_position"] = {"net": str(held), "raw": jsonable(hit)}
            if qty < 1:
                raise Refusal("venue", f"venue holds {held} on {slug} (lot {lot_q}); nothing to sell. If it was already "
                                       "sold, use --record-only --venue-order-id <sell order>")
            if held + EPS < lot_q:
                out.setdefault("warnings", []).append(f"venue holds {held} < lot {lot_q}")
            if Decimal(qty) + EPS < lot_q:
                out.setdefault("warnings", []).append(f"selling {qty} of {lot_q}: the lot stays open (reduced)")
            order_type = a.order_type
            params = sell_params(slug, outcome, float(price), qty, order_type)
            out["params"] = params
            try:
                preview = vcall(c.orders.preview, {"request": params})
            except Exception as e:
                raise Refusal("preview", f"venue preview failed: {type(e).__name__}: {str(e)[:300]}")
            po = (preview or {}).get("order") or {}
            if not po or po.get("state") == "ORDER_STATE_REJECTED":
                raise Refusal("preview", f"venue preview not accepted: {json.dumps(preview, default=str)[:300]}")
            out["preview"] = {k: po.get(k) for k in ("state", "intent", "action", "outcomeSide", "quantity", "tif")}
            extra = {"gate_results": {"reason": a.reason, "print": px, "print_source": px_src, "invalidation_price": inval,
                                      "book": book, "forced": bool(a.force)}}
            if a.dry_run:
                out["entry_fills"] = [{k: f[k] for k in ("venue_fill_id", "venue_order_id", "quantity", "price", "fee")}
                                      for f in pre_entry]
                out["would_close_priced"] = lq["complete"] and Decimal(qty) + EPS >= lot_q
                out["decision"] = "DRY_RUN_OK"
                out["note"] = "dry-run: no orders.create, no ledger write"
                return 0, out
            try:  # LIVE: exactly once (never retried: non-idempotent)
                create = c.orders.create(params)
                time.sleep(CALL_SLEEP)
            except Exception as e:
                out["decision"] = "ERROR"
                out["error"] = f"orders.create failed: {type(e).__name__}: {str(e)[:300]}; check venue orders before retrying"
                return 1, out
            vo = (create or {}).get("id") or ((create or {}).get("order") or {}).get("id")
            out["venue_order_id"], out["create"] = vo, jsonable(create)
            if not vo:
                out["decision"] = "ERROR"
                out["error"] = "orders.create returned no id; check venue open orders manually"
                return 1, out
            ret = None
            for _ in range(4):
                ret = (vcall(c.orders.retrieve, vo) or {}).get("order")
                if (ret or {}).get("state") not in ("ORDER_STATE_PENDING_NEW", "ORDER_STATE_PENDING_RISK", None):
                    break
                time.sleep(1.0)
            extra["payload"] = {"create": jsonable(create)}

        # ---- fills (exit + entry) and cash, then the ledger close
        trades, want = [], Decimal(str((ret or {}).get("cumQuantity") or 0))
        for i in range(6):  # activities can lag the order by a few seconds
            trades = venue_trades(c, slug)
            got = sum((Decimal(t["quantity"]) for t in exit_fills_for(trades, vo, outcome)), Decimal(0))
            if got + EPS >= want and (got > 0 or want == 0):
                break
            time.sleep(1.5)
        ef, cutoff = lot_entry_fills(trades, entry_ids, outcome, pos.get("opened_at"))
        out["entry_fills_check"] = {**lot_quantities(pos, ef), "entry_cutoff": cutoff, "n_entry_fills": len(ef)}
        cash, asset_notional = venue_cash(vcall(c.account.balances))
        args = build_record_args(pos, vo, ret, params, order_type, price, exit_fills_for(trades, vo, outcome), ef,
                                 a.reason, cash, a.rationale, a.allow_unpriced, extra)
        try:
            res = rpc("oddsborne_exit_record", args)
        except Exception as e:
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            fb = OUT_DIR / f"pm_exit_orphan_{vo}.json"
            fb.write_text(json.dumps({"out": out, "args": args}, indent=1, default=str))
            out["saved"] = str(fb)
            if getattr(e, "refusal", None):
                out["decision"] = "SOLD_LEDGER_REFUSED" if not a.record_only else "REFUSED"
                out["refused"] = {"gate": e.refusal[0], "reason": e.refusal[1]}
                out["next"] = (f"fix the fills, then: pm_exit.py --position-id {a.position_id} --reason {a.reason} "
                               f"--record-only --venue-order-id {vo}")
                return 2, out
            out["decision"] = "ERROR"
            out["error"] = f"ledger write failed: {type(e).__name__}: {str(e)[:300]}; venue order {vo}"
            return 1, out
        out["ledger"] = jsonable(res)
        out["cash"], out["asset_notional"] = None if cash is None else str(cash), asset_notional
        act = res.get("action")
        out["decision"] = {"closed": "CLOSED", "reduced": "REDUCED", "order_only": "ORDER_RECORDED"}.get(act, str(act))
        if act == "closed":
            out["next"] = (f'.venv/bin/python close_lesson.py --position-id {a.position_id} '
                           '--rationale "<what this close taught>" --new-confidence <1-100>')
        return 0, out
    except Refusal as r:
        out["decision"] = "REFUSED"
        out["refused"] = {"gate": r.gate, "reason": r.reason}
        return 2, out
    except Exception as e:
        if getattr(e, "refusal", None):
            out["decision"] = "REFUSED"
            out["refused"] = {"gate": e.refusal[0], "reason": e.refusal[1]}
            return 2, out
        out["decision"] = "ERROR"
        out["error"] = f"{type(e).__name__}: {str(e)[:400]}"
        return 1, out


def main(argv=None) -> int:
    _require_runtime("oddsborne", ("polymarket_us",))
    ap = argparse.ArgumentParser(prog="pm_exit.py", description="ODDSBORNE exit + ledger close. LIVE unless --dry-run.")
    ap.add_argument("--position-id", required=True)
    ap.add_argument("--reason", required=True, choices=REASONS)
    ap.add_argument("--price", type=float, default=None, help="sell price of the held outcome (default: outcome bid)")
    ap.add_argument("--order-type", default="ioc", choices=sorted(EXIT_ORDER_TYPES))
    ap.add_argument("--rationale", default="")
    ap.add_argument("--force", action="store_true", help="invalidation exit even if the print is above the line")
    ap.add_argument("--record-only", action="store_true", help="no sell: record an existing sell order + its fills")
    ap.add_argument("--venue-order-id", default=None, help="with --record-only: the sell order to record")
    ap.add_argument("--entry-order-ids", default=None, help="comma list: this lot's buy order ids (default: the buy "
                                                             "orders pm_orders holds for the lot's market/outcome)")
    ap.add_argument("--allow-unpriced", default=None, metavar="REASON",
                    help="close even if the entry fills can't be found (realized_pnl stays null); say why")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    rc, out = run(a)
    print(json.dumps(jsonable(out), indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
