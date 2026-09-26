#!/usr/bin/env python3
"""ODDSBORNE pm_enter: the single entry point for every Polymarket US BUY.

Pipeline (refuses at the first failing gate, never invents prices or ids):
  1. thesis_id required (refuse if missing).
  2. Live market (retrieve_by_slug -> marketSides) + live BBO. Yes = long:true side.
     edge_after_costs = my_probability - price - fee_per_contract,
     fee_per_contract = THETA * price * (1 - price)   (desk formula, THETA = 0.0695;
     "Fee = Θ × C × p × (1−p)" from afternoon_full_*/morning_full_* scripts, C = 1 contract).
     Refuse if edge_after_costs <= 0. That is the ONLY edge rule (no cent bar, no %-of-book cap).
  3. public.steward_sizing_guidance('oddsborne', thesis_id, slug, requested, invalidation). --invalidation
     (outcome price, 0 < inval < price) is required. Refuse if entry_allowed is false (unknown/rejected/killed
     thesis, missing_invalidation, stale_book). sized_notional = min(requested x multiplier, edge-scaled
     max_stake, cash). quantity = floor(sized_notional/price),
     capped so notional + est. fee <= spendable_cash (no margin). Refuse if quantity < 1.
  4. orders.preview at the venue (refuse on preview error). Live: orders.create (never retried),
     orders.retrieve, insert pm_orders (status from venue state, gate_results = guidance + edge),
     record immediate fills from portfolio.activities into pm_fills (idempotent on venue
     execution id), open or add to the pm_positions lot (thesis_id, invalidation_price/_note; the DB
     rejects a new open lot without an invalidation) and link the fills, public.oddsborne_touch_heartbeat(). Dry-run: everything except create /
     pm_orders / pm_fills / heartbeat (pm_markets side ids ARE upserted: reference data only).
  5. Prints a JSON summary.

Price convention: --price is the price of the outcome you are buying (yes or no). The venue's
price.value is always the LONG (yes) price, so a NO buy at p is sent as BUY_SHORT at 1-p.

Payload shape copied from the working 9/25-9/26 entries (session_2026092x_daily.py /
morning_full_20260926.py, Angels CQ9BGSCP6YBE):
  {"marketSlug", "intent": "ORDER_INTENT_BUY_LONG", "type": "ORDER_TYPE_LIMIT",
   "price": {"value": "0.3550", "currency": "USD"}, "quantity": int,
   "tif": "TIME_IN_FORCE_GOOD_TILL_CANCEL", "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC",
   "participateDontInitiate": True}
  preview is called as c.orders.preview({"request": params}).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path

# Helpers (load_secrets, db_connect) resolve from the invoking directory first (the box copy in
# /workspace/oddsborne keeps its own), then ODDSBORNE_HOME, then this repo directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("ODDSBORNE_HOME"), _HERE):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

STEWARD = "oddsborne"
ACCOUNT = "polymarket-us-primary"
THETA = 0.0695  # desk fee parameter: fee = THETA * C * p * (1 - p)
CALL_SLEEP = 0.8
OUT_DIR = Path(os.environ.get("ODDSBORNE_OUT_DIR") or os.path.join(_HERE, "deepdive_raw"))

ORDER_TYPES = {
    # name: (tif, participateDontInitiate, pm_orders.order_type)
    "maker_gtc": ("TIME_IN_FORCE_GOOD_TILL_CANCEL", True, "limit"),
    "gtc": ("TIME_IN_FORCE_GOOD_TILL_CANCEL", False, "limit"),
    "ioc": ("TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", False, "fak"),
    "fok": ("TIME_IN_FORCE_FILL_OR_KILL", False, "fok"),
}
VENUE_STATE_TO_STATUS = {
    "ORDER_STATE_NEW": "open",
    "ORDER_STATE_PENDING_NEW": "submitted",
    "ORDER_STATE_PENDING_RISK": "submitted",
    "ORDER_STATE_PENDING_REPLACE": "open",
    "ORDER_STATE_PENDING_CANCEL": "open",
    "ORDER_STATE_PARTIALLY_FILLED": "partial",
    "ORDER_STATE_FILLED": "filled",
    "ORDER_STATE_CANCELED": "cancelled",
    "ORDER_STATE_CANCELLED": "cancelled",
    "ORDER_STATE_REPLACED": "open",
    "ORDER_STATE_REJECTED": "rejected",
    "ORDER_STATE_EXPIRED": "expired",
}


class Refusal(Exception):
    def __init__(self, gate: str, reason: str, **ctx):
        super().__init__(f"{gate}: {reason}")
        self.gate, self.reason, self.ctx = gate, reason, ctx


# ----------------------------------------------------------------- pure helpers (unit-testable)
def fee_per_contract(price: float, theta: float = THETA) -> float:
    p = float(price)
    return theta * p * (1.0 - p)


def compute_edge(my_probability: float, price: float, theta: float = THETA) -> dict:
    fee = fee_per_contract(price, theta)
    edge = float(my_probability) - float(price) - fee
    return {
        "formula": "edge_after_costs = my_probability - price - THETA*price*(1-price)",
        "theta": theta,
        "my_probability": float(my_probability),
        "price": float(price),
        "fee_per_contract": round(fee, 6),
        "edge_after_costs": round(edge, 6) + 0.0,
        "passes": edge > 0,
    }


def check_edge(edge: dict) -> None:
    if not edge["passes"]:
        raise Refusal("edge", f"edge_after_costs {edge['edge_after_costs']} <= 0 "
                              f"(p={edge['my_probability']} - px={edge['price']} - fee={edge['fee_per_contract']})",
                      edge=edge)


def check_guidance(g: dict) -> None:
    if g is None:
        raise Refusal("sizing", "steward_sizing_guidance returned no row")
    if not g.get("entry_allowed"):
        raise Refusal("sizing", f"entry_allowed=false ({g.get('entry_blocked_reason')}; "
                                f"thesis_status={g.get('thesis_status')})", guidance=g)
    if g.get("thesis_status") is None:
        raise Refusal("sizing", f"thesis '{g.get('thesis_id')}' unknown to public.theses "
                                "(thesis_status null; pm_orders.thesis_id FK would fail)", guidance=g)
    if g.get("sized_notional") is None:
        raise Refusal("sizing", "sized_notional is null", guidance=g)


def compute_quantity(sized_notional, spendable_cash, price: float, theta: float = THETA) -> dict:
    px = Decimal(str(price))
    sized = Decimal(str(sized_notional))
    q_sized = int((sized / px).to_integral_value(rounding=ROUND_FLOOR))
    per_contract_cash = px + Decimal(str(fee_per_contract(price, theta)))  # no margin: include est. fee
    q_cash = None
    if spendable_cash is not None:
        q_cash = int((Decimal(str(spendable_cash)) / per_contract_cash).to_integral_value(rounding=ROUND_FLOOR))
    qty = q_sized if q_cash is None else min(q_sized, q_cash)
    qty = max(qty, 0)
    return {
        "qty_from_sized_notional": q_sized,
        "qty_cap_spendable_cash": q_cash,
        "quantity": qty,
        "capped_by_cash": q_cash is not None and q_cash < q_sized,
        "notional": float(px * qty),
        "est_fee_total": round(fee_per_contract(price, theta) * qty, 4),
    }


def check_quantity(q: dict) -> None:
    if q["quantity"] < 1:
        raise Refusal("sizing", f"quantity {q['quantity']} < 1", sizing=q)


def money(v):
    if isinstance(v, dict):
        v = v.get("value")
    if v in (None, ""):
        return None
    try:
        return float(v)
    except Exception:
        return None


def jsonable(o):
    return json.loads(json.dumps(o, default=lambda x: float(x) if isinstance(x, Decimal) else str(x)))


# ----------------------------------------------------------------- venue helpers
def _is_retryable(e: Exception) -> bool:
    name = type(e).__name__
    txt = str(e)[:400].lower()
    return (name in ("RateLimitError", "APIConnectionError", "APITimeoutError", "InternalServerError")
            or "1015" in txt or "cloudflare" in txt or "<html" in txt or "rate limit" in txt)


def vcall(fn, *a, tries: int = 6, **kw):
    """Read-only / idempotent venue call with ~0.8s spacing and exponential backoff."""
    last = None
    for i in range(tries):
        try:
            r = fn(*a, **kw)
            time.sleep(CALL_SLEEP)
            return r
        except Exception as e:
            last = e
            if not _is_retryable(e) or i == tries - 1:
                raise
            time.sleep(min(30.0, 1.5 * 2 ** i))
    raise last  # pragma: no cover


def make_client():
    from load_secrets import load_secrets
    s = load_secrets()
    os.environ.update(s)
    from polymarket_us import PolymarketUS
    return PolymarketUS(key_id=s["POLYMARKET_US_KEY_ID"], secret_key=s["POLYMARKET_US_SECRET_KEY"])


def make_conn():
    from load_secrets import load_secrets
    os.environ.update(load_secrets())
    from db_connect import connect
    return connect()


def market_view(c, slug: str) -> dict:
    m = (vcall(c.markets.retrieve_by_slug, slug) or {}).get("market") or {}
    if not m or m.get("slug") not in (None, slug):
        raise Refusal("market", f"market {slug} not found at venue")
    sides = m.get("marketSides") or []
    long_side = next((s for s in sides if s.get("long") is True), None)
    short_side = next((s for s in sides if s.get("long") is False), None)
    if not long_side or not short_side:
        raise Refusal("market", f"cannot identify long/short marketSides for {slug}: {sides}")
    b = vcall(c.markets.bbo, slug) or {}
    md = b.get("marketData") or b
    bid, ask = money(md.get("bestBid")), money(md.get("bestAsk"))
    return {"market": m, "long": long_side, "short": short_side, "bbo_raw": md,
            "long_bid": bid, "long_ask": ask, "last": money(md.get("lastTradePx")),
            "current": money(md.get("currentPx")), "bid_depth": md.get("bidDepth"),
            "ask_depth": md.get("askDepth")}


def outcome_book(mv: dict, outcome: str) -> dict:
    lb, la = mv["long_bid"], mv["long_ask"]
    if outcome == "yes":
        bid, ask = lb, la
    else:  # NO book is the mirror of the long book
        bid = round(1 - la, 6) if la is not None else None
        ask = round(1 - lb, 6) if lb is not None else None
    mid = round((bid + ask) / 2, 6) if bid is not None and ask is not None else None
    last = mv["last"] if outcome == "yes" or mv["last"] is None else round(1 - mv["last"], 6)
    return {"bid": bid, "ask": ask, "mid": mid, "last": last,
            "book_probability": mid if mid is not None else last}


def status_from_venue(state: str | None) -> str:
    return VENUE_STATE_TO_STATUS.get(state or "", "submitted")


# ----------------------------------------------------------------- DB helpers
def sizing_guidance(cur, thesis_id: str, instrument: str, requested: float, invalidation: float) -> dict:
    cur.execute("select * from public.steward_sizing_guidance(%s, %s, %s, %s, %s)",
                (STEWARD, thesis_id, instrument, Decimal(str(requested)), Decimal(str(invalidation))))
    row = cur.fetchone()
    if row is None:
        return None
    return jsonable(dict(zip([d.name for d in cur.description], row)))


def upsert_market(cur, mv: dict) -> str:
    m, lg, sh = mv["market"], mv["long"], mv["short"]
    slug = m.get("slug")
    venue_ids = {
        "market_id": str(m.get("id")), "yes_side_id": str(lg.get("id")), "no_side_id": str(sh.get("id")),
        "side_map": f"yes=long side {lg.get('description')}, no={sh.get('description')}",
        "note": "Polymarket US has no CLOB token ids; yes/no_token_id hold marketSides ids",
        "venue_status": m.get("status"), "fee_coefficient": m.get("feeCoefficient"),
        "upserted_by": "pm_enter", "upserted_at": datetime.now(timezone.utc).isoformat(),
    }
    cur.execute("select id, yes_token_id, no_token_id from public.pm_markets where slug=%s order by created_at limit 1",
                (slug,))
    row = cur.fetchone()
    if row:
        if (row[1] and row[1] != venue_ids["yes_side_id"]) or (row[2] and row[2] != venue_ids["no_side_id"]):
            raise Refusal("market", f"pm_markets side ids {row[1]}/{row[2]} disagree with venue "
                                    f"{venue_ids['yes_side_id']}/{venue_ids['no_side_id']} for {slug}")
        cur.execute("""update public.pm_markets set yes_token_id=%s, no_token_id=%s,
                         condition_id=coalesce(condition_id,%s), close_time=coalesce(close_time,%s::timestamptz),
                         meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('venue_ids', %s::jsonb),
                         updated_at=now() where id=%s""",
                    (venue_ids["yes_side_id"], venue_ids["no_side_id"], venue_ids["market_id"], m.get("endDate"),
                     json.dumps(venue_ids), row[0]))
        return str(row[0])
    cur.execute("""insert into public.pm_markets (venue, condition_id, slug, question, status, close_time,
                     yes_token_id, no_token_id, meta)
                   values ('polymarket', %s, %s, %s, 'open', %s::timestamptz, %s, %s, %s::jsonb) returning id""",
                (venue_ids["market_id"], slug, m.get("question") or slug, m.get("endDate"),
                 venue_ids["yes_side_id"], venue_ids["no_side_id"],
                 json.dumps({"venue_ids": venue_ids})))
    return str(cur.fetchone()[0])


def record_fills(c, cur, slug: str, venue_order_id: str, pm_order_id: str, market_id: str) -> list:
    """Pull our executions for this order from portfolio.activities (same source/shape as
    pm_fills_backfill_20260926.py) and insert idempotently on (account_key, venue_fill_id)."""
    r = vcall(c.portfolio.activities, {"limit": 100, "marketSlug": slug,
                                       "types": ["ACTIVITY_TYPE_TRADE"], "sortOrder": "SORT_ORDER_DESCENDING"})
    out = []
    for a in (r or {}).get("activities") or []:
        if a.get("type") != "ACTIVITY_TYPE_TRADE":
            continue
        tr = a["trade"]
        ex = tr.get("aggressorExecution") if tr.get("isAggressor") else tr.get("passiveExecution")
        if not ex or (ex.get("order") or {}).get("id") != venue_order_id:
            continue
        o = ex["order"]
        outcome = {"OUTCOME_SIDE_YES": "yes", "OUTCOME_SIDE_NO": "no"}.get(o.get("outcomeSide"))
        side = {"ORDER_ACTION_BUY": "buy", "ORDER_ACTION_SELL": "sell"}.get(o.get("action"))
        if outcome is None or side is None:
            outcome, side = {"ORDER_INTENT_BUY_LONG": ("yes", "buy"), "ORDER_INTENT_SELL_LONG": ("yes", "sell"),
                             "ORDER_INTENT_BUY_SHORT": ("no", "buy"),
                             "ORDER_INTENT_SELL_SHORT": ("no", "sell")}[o.get("intent")]
        cur.execute("select id from public.pm_positions where account_key=%s and market_id=%s and outcome=%s"
                    " and status='open'", (ACCOUNT, market_id, outcome))
        pos = cur.fetchall()
        pos_id = pos[0][0] if len(pos) == 1 else None
        payload = {"source": "portfolio.activities", "writer": "pm_enter", "trade_id": tr.get("id"),
                   "execution_id": ex["id"], "is_aggressor": bool(tr.get("isAggressor")),
                   "fee_field": "execution.commissionNotionalCollected (negative = maker rebate)", "activity": a}
        cur.execute(
            """insert into public.pm_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id, outcome,
                   side, quantity, price, fee, executed_at, payload)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::timestamptz,%s::jsonb)
               on conflict (account_key, venue_fill_id) do nothing returning id""",
            (pm_order_id, pos_id, ACCOUNT, ex["id"], venue_order_id, outcome, side, Decimal(str(ex["lastShares"])),
             Decimal(str(ex["lastPx"]["value"])),
             Decimal(str((ex.get("commissionNotionalCollected") or {}).get("value") or 0)),
             ex.get("transactTime") or tr.get("createTime"), json.dumps(payload, default=str)))
        row = cur.fetchone()
        out.append({"venue_fill_id": ex["id"], "qty": ex["lastShares"], "px": ex["lastPx"]["value"],
                    "inserted": bool(row), "pm_fill_id": str(row[0]) if row else None})
    return out


def upsert_position(cur, market_id: str, outcome: str, thesis_id: str, invalidation: float,
                    invalidation_note: str, kill_criteria: str, pm_order_id: str, fills: list) -> dict:
    """Open (or add to) the pm_positions lot for this order's newly inserted buy fills, carrying
    thesis_id and the entry invalidation, and link the order's unlinked fills to it."""
    new = [f for f in fills if f.get("inserted")]
    qty = sum(Decimal(str(f["qty"])) for f in new)
    if qty <= 0:
        return {"action": "none", "reason": "no newly inserted fills"}
    px = sum(Decimal(str(f["qty"])) * Decimal(str(f["px"])) for f in new) / qty
    cur.execute("""select id, quantity, average_cost, invalidation_price from public.pm_positions
                   where account_key=%s and market_id=%s and outcome=%s and status='open' for update""",
                (ACCOUNT, market_id, outcome))
    row = cur.fetchone()
    if row:
        pos_id, q0, a0, inv0 = row
        q0 = Decimal(str(q0 or 0))
        new_q = q0 + qty
        new_avg = ((q0 * Decimal(str(a0)) if a0 is not None else Decimal(0)) + qty * px) / new_q if a0 is not None or q0 == 0 else None
        cur.execute("""update public.pm_positions set quantity=%s, average_cost=coalesce(%s, average_cost),
                         invalidation_price=coalesce(invalidation_price, %s),
                         invalidation_note=coalesce(invalidation_note, %s),
                         thesis_id=coalesce(thesis_id, %s), updated_at=now() where id=%s""",
                    (new_q, new_avg, Decimal(str(invalidation)), invalidation_note or None, thesis_id, pos_id))
        action = "added"
    else:
        cur.execute("""insert into public.pm_positions (market_id, account_key, thesis_id, outcome, status, quantity,
                         average_cost, opened_at, kill_criteria, invalidation_price, invalidation_note, meta)
                       values (%s::uuid,%s,%s,%s,'open',%s,%s,now(),%s,%s,%s,%s::jsonb) returning id""",
                    (market_id, ACCOUNT, thesis_id, outcome, qty, px, kill_criteria or None,
                     Decimal(str(invalidation)), invalidation_note or None,
                     json.dumps({"writer": "pm_enter", "pm_order_id": pm_order_id})))
        pos_id = cur.fetchone()[0]
        action = "opened"
    cur.execute("update public.pm_fills set position_id=%s where order_id=%s and position_id is null",
                (pos_id, pm_order_id))
    return {"action": action, "position_id": str(pos_id), "fill_qty": str(qty), "fill_avg_px": str(px),
            "fills_linked": cur.rowcount}


# ----------------------------------------------------------------- main entry
def enter(slug: str, outcome: str, price: float, requested_usd: float, thesis_id: str | None,
          my_probability: float, fair_source: str = "", rationale: str = "", kill_criteria: str = "",
          order_type: str = "maker_gtc", dry_run: bool = True, theta: float = THETA,
          client=None, conn=None, invalidation: float | None = None, invalidation_note: str = "") -> dict:
    """Run the full entry pipeline. Returns a JSON-able summary dict with decision in
    {DRY_RUN_OK, PLACED, REFUSED, ERROR}. dry_run defaults to True when called as a function."""
    started = datetime.now(timezone.utc)
    summary = {"tool": "pm_enter", "at": started.isoformat(), "mode": "dry_run" if dry_run else "live",
               "inputs": {"slug": slug, "outcome": outcome, "price": price, "requested_usd": requested_usd,
                          "thesis_id": thesis_id, "my_probability": my_probability, "fair_source": fair_source,
                          "rationale": rationale, "kill_criteria": kill_criteria, "order_type": order_type,
                          "theta": theta, "invalidation": invalidation,
                          "invalidation_note": invalidation_note}}
    own_conn = False
    try:
        # ---- 1. input gates (no network)
        if not thesis_id or not str(thesis_id).strip():
            raise Refusal("input", "thesis_id is required")
        outcome = (outcome or "").lower().strip()
        if outcome not in ("yes", "no"):
            raise Refusal("input", f"outcome must be yes|no, got {outcome!r}")
        if order_type not in ORDER_TYPES:
            raise Refusal("input", f"order_type must be one of {sorted(ORDER_TYPES)}")
        price = float(price)
        if not (0.01 <= price <= 0.99):
            raise Refusal("input", f"price {price} outside [0.01, 0.99]")
        if my_probability is None or not (0.0 <= float(my_probability) <= 1.0):
            raise Refusal("input", f"my_probability {my_probability} outside [0,1]")
        if requested_usd is None or float(requested_usd) <= 0:
            raise Refusal("input", "requested_usd must be > 0")
        my_probability = float(my_probability)
        # Every entry names the outcome price at which it is wrong (guidance returns
        # missing_invalidation without it; pm_positions rejects a new open lot without it).
        if invalidation is None:
            raise Refusal("input", "missing_invalidation: --invalidation (outcome price) is required")
        invalidation = float(invalidation)
        if not (0.0 < invalidation < price):
            raise Refusal("input", f"invalidation {invalidation} must be > 0 and below the entry price {price}")

        # ---- 2. edge (pure; fail fast before touching venue)
        edge = compute_edge(my_probability, price, theta)
        summary["edge"] = edge
        check_edge(edge)

        c = client or make_client()
        if conn is None:
            conn, own_conn = make_conn(), True
        cur = conn.cursor()

        mv = market_view(c, slug)
        m = mv["market"]
        tick = float(m.get("orderPriceMinTickSize") or 0.001)
        book = outcome_book(mv, outcome)
        summary["market"] = {
            "slug": slug, "venue_market_id": m.get("id"), "question": m.get("question"),
            "status": m.get("status"), "closed": m.get("closed"), "game_start": m.get("gameStartTime"),
            "yes_side": {"id": mv["long"].get("id"), "desc": mv["long"].get("description")},
            "no_side": {"id": mv["short"].get("id"), "desc": mv["short"].get("description")},
            "buying": (mv["long"] if outcome == "yes" else mv["short"]).get("description"),
            "long_bbo": {"bid": mv["long_bid"], "ask": mv["long_ask"], "bid_depth": mv["bid_depth"],
                         "ask_depth": mv["ask_depth"], "last": mv["last"]},
            "outcome_bbo": book, "tick": tick, "venue_fee_coefficient": m.get("feeCoefficient"),
        }
        warnings = []
        if m.get("closed") or any(k in str(m.get("status")) for k in ("RESOLVED", "CLOSED", "SETTLED", "HALT")):
            raise Refusal("market", f"market not tradable: status={m.get('status')} closed={m.get('closed')}")
        if abs(round(price / tick) * tick - price) > 1e-9:
            raise Refusal("input", f"price {price} not on venue tick {tick}")
        tif, pdi, ledger_type = ORDER_TYPES[order_type]
        if pdi and book["ask"] is not None and price >= book["ask"]:
            raise Refusal("market", f"maker (post-only) price {price} >= outcome ask {book['ask']}: would cross; "
                                    "use --order-type gtc/ioc to take")
        if book["bid"] is None or book["ask"] is None:
            warnings.append("one-sided or empty book; book_probability falls back to last trade")
        fc = m.get("feeCoefficient")
        if fc is not None and float(fc) > theta:
            warnings.append(f"venue feeCoefficient {fc} > THETA {theta}: edge may be overstated")
        gst = m.get("gameStartTime")
        if gst:
            try:
                if datetime.fromisoformat(gst.replace("Z", "+00:00")) <= started:
                    warnings.append(f"game already started ({gst})")
            except Exception:
                pass
        edge["book_probability"] = book["book_probability"]
        edge["price_vs_book"] = {"outcome_bid": book["bid"], "outcome_ask": book["ask"]}

        # ---- 3. sizing
        g = sizing_guidance(cur, thesis_id, slug, requested_usd, invalidation)
        conn.rollback()
        summary["guidance"] = g
        check_guidance(g)
        sz = compute_quantity(g["sized_notional"], g.get("spendable_cash"), price, theta)
        summary["sizing"] = {**sz, "sized_notional": g["sized_notional"], "multiplier": g["multiplier"],
                             "multiplier_basis": g["multiplier_basis"], "spendable_cash": g["spendable_cash"],
                             "max_stake": g.get("max_stake"), "max_stake_reason": g.get("max_stake_reason"),
                             "book_equity": g["book_equity"], "thesis_status": g["thesis_status"]}
        check_quantity(sz)
        qty = sz["quantity"]

        # ---- 4. params + preview
        intent = "ORDER_INTENT_BUY_LONG" if outcome == "yes" else "ORDER_INTENT_BUY_SHORT"
        long_px = price if outcome == "yes" else round(1.0 - price, 6)
        params = {
            "marketSlug": slug,
            "intent": intent,
            "type": "ORDER_TYPE_LIMIT",
            "price": {"value": f"{long_px:.4f}", "currency": "USD"},
            "quantity": qty,
            "tif": tif,
            "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC",
            "participateDontInitiate": pdi,
        }
        summary["params"] = params
        try:
            open_orders = (vcall(c.orders.list, {"slugs": [slug]}) or {}).get("orders") or []
            summary["open_orders_on_slug"] = [{"id": o.get("id"), "intent": o.get("intent"),
                                               "price": money(o.get("price")), "leaves": o.get("leavesQuantity")}
                                              for o in open_orders]
            if open_orders:
                warnings.append(f"{len(open_orders)} open order(s) already on {slug} (self-match risk)")
        except Exception as e:
            warnings.append(f"open-orders check failed: {type(e).__name__}: {str(e)[:120]}")
        try:
            preview = vcall(c.orders.preview, {"request": params})
        except Exception as e:
            raise Refusal("preview", f"venue preview failed: {type(e).__name__}: {str(e)[:300]}")
        po = (preview or {}).get("order") or {}
        if not po or po.get("state") == "ORDER_STATE_REJECTED":
            raise Refusal("preview", f"venue preview not accepted: {json.dumps(preview, default=str)[:300]}")
        summary["preview"] = {k: po.get(k) for k in ("state", "intent", "side", "outcomeSide", "action", "quantity",
                                                   "leavesQuantity", "tif", "commissionsBasisPoints",
                                                   "makerCommissionsBasisPoints")}
        summary["preview"]["price"] = money(po.get("price"))
        summary["preview"]["outcome"] = (po.get("marketMetadata") or {}).get("outcome")

        market_id = upsert_market(cur, mv)
        conn.commit()
        summary["pm_market_id"] = market_id

        gate_results = {"guidance": g, "edge": edge, "sizing": sz, "preview_state": po.get("state"),
                        "fair_source": fair_source, "order_type": order_type, "warnings": warnings,
                        "gated_at": started.isoformat(), "writer": "pm_enter",
                        "invalidation_price": invalidation, "invalidation_note": invalidation_note}
        summary["warnings"] = warnings
        summary["would_place"] = {
            "desc": f"BUY {qty} {outcome.upper()} ({summary['market']['buying']}) @ {price} on {slug} "
                    f"[{order_type}] notional ${sz['notional']:.2f} + est fee ${sz['est_fee_total']:.2f}",
            "pm_orders_row": {"market_id": market_id, "account_key": ACCOUNT, "thesis_id": thesis_id,
                              "outcome": outcome, "side": "buy", "order_type": ledger_type, "size": qty,
                              "price": price, "mode": "live", "my_probability": my_probability,
                              "book_probability": book["book_probability"],
                              "edge_after_costs": edge["edge_after_costs"]},
        }

        if dry_run:
            summary["decision"] = "DRY_RUN_OK"
            summary["note"] = "dry-run: no orders.create, no pm_orders/pm_fills writes, no heartbeat"
            return summary

        # ---- 4b. LIVE: create exactly once (never retried: non-idempotent)
        try:
            create = c.orders.create(params)
            time.sleep(CALL_SLEEP)
        except Exception as e:
            summary["decision"] = "ERROR"
            summary["error"] = f"orders.create failed: {type(e).__name__}: {str(e)[:300]}"
            try:
                summary["open_orders_after_failed_create"] = (vcall(c.orders.list, {"slugs": [slug]}) or {}).get("orders")
            except Exception:
                pass
            return summary
        oid = (create or {}).get("id") or ((create or {}).get("order") or {}).get("id")
        summary["create"] = create
        summary["venue_order_id"] = oid
        if not oid:
            summary["decision"] = "ERROR"
            summary["error"] = "orders.create returned no id; check venue open orders manually"
            return summary
        ret = None
        try:
            ret = (vcall(c.orders.retrieve, oid) or {}).get("order")
        except Exception as e:
            warnings.append(f"retrieve failed: {type(e).__name__}: {str(e)[:120]}")
        vstate = (ret or {}).get("state")
        status = status_from_venue(vstate)
        summary["venue_state"], summary["status"] = vstate, status
        full_rationale = (rationale or "") + (f" | fair source: {fair_source}" if fair_source else "")
        payload = {"params": params, "create": create, "retrieve": ret, "preview": preview,
                   "writer": "pm_enter", "fair_source": fair_source}
        try:
            cur.execute(
                """insert into public.pm_orders (market_id, account_key, thesis_id, outcome, side, order_type, size, price,
                       status, mode, venue_order_id, rationale, kill_criteria, my_probability, book_probability,
                       edge_after_costs, gate_results, payload, submitted_at,
                       max_stake_at_entry, max_stake_reason_at_entry)
                   values (%s::uuid,%s,%s,%s,'buy',%s,%s,%s,%s,'live',%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,
                           coalesce(%s::timestamptz, now()), %s, %s) returning id""",
                (market_id, ACCOUNT, thesis_id, outcome, ledger_type, qty, Decimal(str(price)), status, oid,
                 full_rationale, kill_criteria, Decimal(str(my_probability)),
                 None if book["book_probability"] is None else Decimal(str(book["book_probability"])),
                 Decimal(str(edge["edge_after_costs"])), json.dumps(gate_results, default=str),
                 json.dumps(payload, default=str), (ret or {}).get("createTime"),
                 g.get("max_stake"), g.get("max_stake_reason")))
            pm_order_id = str(cur.fetchone()[0])
            conn.commit()
            summary["pm_order_id"] = pm_order_id
        except Exception as e:
            conn.rollback()
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            fb = OUT_DIR / f"pm_enter_orphan_{oid}.json"
            fb.write_text(json.dumps({"summary": summary, "gate_results": gate_results, "payload": payload},
                                     indent=1, default=str))
            summary["decision"] = "ERROR"
            summary["error"] = (f"ORDER IS LIVE ({oid}) but pm_orders insert failed: {type(e).__name__}: "
                                f"{str(e)[:200]}; details saved to {fb}")
            return summary

        # ---- fills + heartbeat
        try:
            cum = float((ret or {}).get("cumQuantity") or 0)
            summary["fills"] = record_fills(c, cur, slug, oid, pm_order_id, market_id) if (cum > 0 or (create or {}).get("executions")) else []
            conn.commit()
        except Exception as e:
            conn.rollback()
            warnings.append(f"fill recording failed (run pm_fills backfill): {type(e).__name__}: {str(e)[:160]}")
        try:
            if summary.get("fills"):
                summary["position"] = upsert_position(cur, market_id, outcome, thesis_id, invalidation,
                                                      invalidation_note, kill_criteria, pm_order_id, summary["fills"])
                conn.commit()
        except Exception as e:
            conn.rollback()
            warnings.append(f"pm_positions open/add failed (write the lot with invalidation_price by hand): "
                            f"{type(e).__name__}: {str(e)[:160]}")
        try:
            cur.execute("select public.oddsborne_touch_heartbeat()")
            summary["heartbeat_at"] = str(cur.fetchone()[0])
            conn.commit()
        except Exception as e:
            conn.rollback()
            warnings.append(f"heartbeat failed: {type(e).__name__}: {str(e)[:120]}")
        summary["decision"] = "PLACED"
        return summary
    except Refusal as r:
        summary["decision"] = "REFUSED"
        summary["refused"] = {"gate": r.gate, "reason": r.reason}
        return summary
    except Exception as e:
        summary["decision"] = "ERROR"
        summary["error"] = f"{type(e).__name__}: {str(e)[:400]}"
        return summary
    finally:
        if own_conn and conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="pm_enter.py",
        description="ODDSBORNE Polymarket US entry (the one path for every buy). LIVE unless --dry-run.")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--outcome", required=True, choices=["yes", "no"],
                    help="yes = long:true side (first team), no = short side")
    ap.add_argument("--price", required=True, type=float, help="limit price of the outcome being bought")
    ap.add_argument("--usd", required=True, type=float, help="requested USD (before steward multiplier)")
    ap.add_argument("--thesis", default=None, help="thesis_id (required; refused if missing)")
    ap.add_argument("--p", dest="my_probability", required=True, type=float, help="my probability for the outcome")
    ap.add_argument("--fair-source", default="")
    ap.add_argument("--rationale", default="")
    ap.add_argument("--kill", dest="kill_criteria", default="")
    ap.add_argument("--order-type", default="maker_gtc", choices=sorted(ORDER_TYPES))
    ap.add_argument("--theta", type=float, default=THETA)
    ap.add_argument("--invalidation", type=float, default=None,
                    help="REQUIRED: outcome price at which the entry is wrong (0 < inval < price)")
    ap.add_argument("--invalidation-note", default="", help="what would make this entry wrong")
    ap.add_argument("--dry-run", action="store_true", help="preview only: no create, no pm_orders write")
    a = ap.parse_args(argv)
    res = enter(a.slug, a.outcome, a.price, a.usd, a.thesis, a.my_probability, a.fair_source, a.rationale,
                a.kill_criteria, a.order_type, dry_run=a.dry_run, theta=a.theta,
                invalidation=a.invalidation, invalidation_note=a.invalidation_note)
    print(json.dumps(jsonable(res), indent=1))
    return {"DRY_RUN_OK": 0, "PLACED": 0, "REFUSED": 2}.get(res.get("decision"), 1)


if __name__ == "__main__":
    sys.exit(main())
