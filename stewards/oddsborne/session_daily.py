#!/usr/bin/env python3
"""ODDSBORNE daily Polymarket US session (date = --date / ODDS_DATE / today America/New_York) PT morning (HTTPS ledger; date-checked sports matcher).
Fresh venue snap, exits, weather (belief-not-ban Midway), sports de-vig fix,
Fed + lean full-book BBO, enter via pm_enter if post-fee edge > 0.
Never invent prices/fills/P/L. Taker Θ=0.0695; maker edge = fair - px + 0.0125*p*(1-p) (rebate);
maker GATE = that - adverse-selection haircut (maker_fee.HAIRCUT, >=0.59c until 30 scored games); 1c bar on gate. No 8¢ bar.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, "/workspace/oddsborne")
sys.path.insert(0, "/workspace/oddsborne/deepdive_raw")

from load_secrets import load_secrets
from db_connect import connect
from polymarket_us import PolymarketUS
import _afternoon_helpers_20260930 as H

spec = importlib.util.spec_from_file_location(
    "aft", "/workspace/oddsborne/deepdive_raw/afternoon_full_20260930_pm.py"
)
aft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aft)

PT = ZoneInfo("America/Los_Angeles")
NOW = datetime.now(timezone.utc)
def _session_date():
    """Session date: --date YYYY-MM-DD or ODDS_DATE, else today in America/New_York."""
    for i, a in enumerate(sys.argv):
        if a == "--date" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith("--date="):
            return a.split("=", 1)[1]
    return os.environ.get("ODDS_DATE") or datetime.now(ZoneInfo("America/New_York")).date().isoformat()


# --dry-run / ODDS_DRY_RUN=1: read-only rehearsal. No invalidation or breach exits, no entries (pm_enter
# --dry-run only, ODDS_LIVE ignored), and every output file gets a _dry session suffix.
DRY_RUN = "--dry-run" in sys.argv or os.environ.get("ODDS_DRY_RUN") == "1"
TODAY = _session_date()
TOMORROW = (datetime.fromisoformat(TODAY) + timedelta(days=1)).date().isoformat()
DSTAMP = TODAY.replace("-", "")
H.TODAY = TODAY
H.TOMORROW = TOMORROW
import maker_fee as MF  # /workspace/oddsborne/maker_fee.py: taker fee, maker rebate, adverse-selection haircut
THETA = MF.THETA  # TAKER fee coefficient (0.0695): fee = THETA*p*(1-p)
MAKER_REBATE = MF.MAKER_REBATE  # maker rebate (0.0125), received not paid: rebate = MAKER_REBATE*p*(1-p)
MAKER_HAIRCUT = MF.HAIRCUT  # adverse-selection haircut ($/contract) subtracted for the maker GATE
MAKER_HAIRCUT_INFO = MF.HAIRCUT_INFO
OUT = Path("/workspace/oddsborne")
P2 = Path(f"/workspace/oddsborne/deepdive_raw/sweep_{DSTAMP}_p2.json")
SESSION = f"{DSTAMP}_am" + ("_dry" if DRY_RUN else "")
THESIS_SPORTS = "sports_devig_maker_edge"
THESIS_WX = "weather_same_day_high"
MIN_EDGE = 0.01  # routine: skip sub-cent post-fee edges
REQUESTED_USD = 5.0  # David: minimum ticket $5+ requested; guidance caps

CODE_MAP = {
    "nyg": ["giants"], "lar": ["rams"], "min": ["twins", "vikings"], "sf": ["49ers", "giants"],
    "mia": ["marlins", "dolphins"], "chc": ["cubs"], "nym": ["mets"], "tex": ["rangers"],
    "den": ["broncos"], "phi": ["eagles", "phillies"], "chi": ["bears", "cubs"],
    "bal": ["ravens", "orioles"], "dal": ["cowboys"], "stl": ["cardinals"],
    "pit": ["pirates", "steelers"], "mil": ["brewers"], "sd": ["padres", "chargers"],
    "lad": ["dodgers"], "tb": ["rays", "buccaneers"], "nyy": ["yankees"],
    "cin": ["reds", "bengals"], "atl": ["braves", "falcons"], "laa": ["angels"],
    "sea": ["mariners", "seahawks"], "gb": ["packers"], "kc": ["chiefs"],
    "was": ["commanders"], "wsh": ["nationals"], "hou": ["astros", "texans"],
    "ath": ["athletics"], "col": ["rockies"], "cws": ["white sox"], "cle": ["guardians", "browns"],
    "ari": ["cardinals", "diamondbacks"], "ind": ["colts"], "lv": ["raiders"],
    "no": ["saints"], "tor": ["blue jays"], "bos": ["red sox", "patriots"],
    "buf": ["bills"], "jax": ["jaguars"], "jac": ["jaguars"], "det": ["lions", "tigers"],
    "ne": ["patriots"], "ten": ["titans"], "car": ["panthers"], "lac": ["chargers"],
}


def fee(p):
    return THETA * p * (1.0 - p)


def post_fee(fair, price):
    """Taker post-fee edge: fair - price - THETA*p*(1-p) (pm_enter.fee_per_contract)."""
    if fair is None or price is None:
        return None
    return round(fair - price - fee(price), 6)


def maker_rebate(p):
    return MF.maker_rebate(p)


def post_fee_maker(fair, price):
    """RAW maker post-fee edge: makers RECEIVE a rebate (Polymarket US fee schedule eff. 2026-10-07;
    ledger maker fills fit ~0.0124): fair - price + MAKER_REBATE*p*(1-p). Do NOT charge the taker THETA here."""
    return MF.post_fee_maker_raw(fair, price)


def post_fee_maker_gate(fair, price):
    """GATE maker edge = raw - adverse-selection haircut (MF.HAIRCUT). MIN_EDGE applies to this number."""
    return MF.post_fee_maker_gate(fair, price, MAKER_HAIRCUT)


def money(x):
    try:
        return float(x) if x is not None else None
    except Exception:
        return None


def decide_city_belief(st, day, book, fc, metar):
    """Run decide_city but treat Midway as belief, not hard ban.
    Temporarily spoof short name past Midway early-return, then restore city label.
    """
    short = H.STATIONS[st]["short"]
    if short != "Midway":
        d = H.decide_city(st, day, book, fc, metar)
        # CA-coastal cool-side is belief: keep reason but annotate weighed
        if d.get("reason", "").startswith("CA-coastal"):
            d["belief_weighed"] = "lax_sfo_cool_side_prior"
            d["reason"] = "BELIEF weighed (not ban): " + d["reason"]
        return d

    # Bypass Midway early return by running as a non-Midway station path:
    # call decide_city with station metadata patched.
    orig = H.STATIONS[st]["short"]
    H.STATIONS[st]["short"] = "MidwayBelief"
    try:
        d = H.decide_city(st, day, book, fc, metar)
    finally:
        H.STATIONS[st]["short"] = orig
    d["city"] = "Midway"
    d["belief_weighed"] = "midway_revenge_prior"
    # If the normal path would ENTER/CANDIDATE somehow, still note belief cost.
    # Default path still SKIPs FBO without crisp maker — annotate.
    reason = d.get("reason") or ""
    if d.get("decision") == "SKIP" and "revenge banned" not in reason:
        d["reason"] = f"BELIEF weighed (not ban): {reason}"
    elif d.get("decision") != "SKIP":
        d["reason"] = f"OVERRIDE Midway belief (document): {reason}"
        d["belief_override"] = True
    else:
        d["reason"] = f"BELIEF weighed (not ban): {reason or 'no crisp edge'}"
    return d


CLIENT = None
_SIDE_CACHE = {}


def long_team_for(mslug):
    """Venue truth: the long (YES) side team from marketSides."""
    if mslug in _SIDE_CACHE:
        return _SIDE_CACHE[mslug]
    name = None
    try:
        r = CLIENT.markets.retrieve_by_slug(mslug)
        time.sleep(0.3)
        m = r.get("market", r) if isinstance(r, dict) else {}
        for sd in (m.get("marketSides") or []):
            if sd.get("long"):
                t = sd.get("team") or {}
                name = t.get("name") or sd.get("description")
                break
    except Exception as e:
        print("long_team_err", mslug, type(e).__name__, flush=True)
    _SIDE_CACHE[mslug] = name
    return name


def match_fair_to_market(mslug, fair_map, mid=None, title=None):
    """Match Bovada fair to the market's LONG side via venue marketSides (fixes 10-04 side bug)."""
    lt = long_team_for(mslug)
    if not lt:
        return None, None, "no_long_side"
    ltl = lt.lower()
    last = ltl.split()[-1]
    for name, fp in fair_map.items():
        nl = name.lower()
        if nl == ltl or ltl in nl or nl in ltl:
            return name, fp, "marketSides_long"
    for name, fp in fair_map.items():
        if name.lower().split()[-1] == last:
            return name, fp, "marketSides_long_lastword"
    return None, None, f"long={lt}_not_in_bovada"


def venue_snap(c):
    bal = c.account.balances()
    time.sleep(0.45)
    pos = c.portfolio.positions()
    time.sleep(0.45)
    try:
        orders = c.orders.list()
    except Exception as e:
        orders = {"error": f"{type(e).__name__}: {str(e)[:200]}", "orders": []}
    path = OUT / f"session_raw_{SESSION}_bal.json"
    path.write_text(json.dumps({"at": NOW.isoformat(), "bal": bal, "pos": pos, "orders": orders}, indent=2, default=str))
    cash = equity = None
    asset = 0.0
    n_orders_bal = None
    if isinstance(bal, dict) and bal.get("balances"):
        b0 = bal["balances"][0]
        cash = money(b0.get("currentBalance"))
        asset = money(b0.get("assetNotional")) or 0.0
        n_orders_bal = b0.get("openOrders")
        equity = round((cash or 0) + asset, 2)
    n_pos = 0
    pos_list = []
    pos_by_slug = {}
    asset_from_pos = 0.0
    if isinstance(pos, dict):
        raw = pos.get("availablePositions") or pos.get("positions") or []
        if isinstance(raw, dict):
            pos_by_slug = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
            raw = list(raw.values()) if raw else []
        if isinstance(raw, list):
            pos_list = [x for x in raw if isinstance(x, dict)]
            n_pos = len(pos_list)
            if not pos_by_slug:
                for v in pos_list:
                    meta = v.get("marketMetadata") or {}
                    slug = meta.get("slug") or v.get("marketSlug") or v.get("slug")
                    if slug:
                        pos_by_slug[str(slug)] = v
            for slug, v in pos_by_slug.items():
                cv = v.get("cashValue") or {}
                if isinstance(cv, dict) and cv.get("value") is not None:
                    try:
                        asset_from_pos += float(cv["value"])
                    except Exception:
                        pass
    if (asset is None or asset == 0.0) and asset_from_pos > 0:
        asset = round(asset_from_pos, 4)
        equity = round((cash or 0) + asset, 2)
    n_orders = 0
    order_rows = []
    if isinstance(orders, dict) and not orders.get("error"):
        ol = orders.get("orders") or orders.get("data") or []
        if isinstance(ol, list):
            n_orders = len(ol)
            order_rows = ol
        elif isinstance(ol, dict):
            n_orders = len(ol)
            order_rows = list(ol.values())
    return {
        "cash": cash, "equity": equity, "asset": asset, "n_pos": n_pos, "n_orders": n_orders,
        "n_orders_bal": n_orders_bal, "pos_list": pos_list, "pos_by_slug": pos_by_slug,
        "orders": orders, "order_rows": order_rows, "path": str(path),
        "bal": bal, "pos": pos,
    }


def slug_for_market_id(cur, market_id):
    if not market_id:
        return None
    cur.execute("SELECT slug FROM public.pm_markets WHERE id=%s::uuid", (str(market_id),))
    row = cur.fetchone()
    return row[0] if row else None


def sell_whole_position(c, slug, outcome, qty, print_px, inval, pos_id):
    """IOC sell of whole YES/NO long at print_px (or bid). Returns dict; never invents fills."""
    qty_i = int(qty) if qty == int(qty) else int(qty)  # floor already
    if qty_i < 1:
        return {"error": "qty<1", "slug": slug}
    intent = "ORDER_INTENT_SELL_LONG" if outcome == "yes" else "ORDER_INTENT_SELL_SHORT"
    # Price for sell-long is long-side price (same as YES price)
    px = float(print_px)
    params = {
        "marketSlug": slug,
        "intent": intent,
        "type": "ORDER_TYPE_LIMIT",
        "price": {"value": f"{px:.4f}", "currency": "USD"},
        "quantity": qty_i,
        "tif": "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
        "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC",
        "participateDontInitiate": False,
    }
    out = {"slug": slug, "outcome": outcome, "qty": qty_i, "price": px, "inval": inval,
           "pos_id": pos_id, "params": params}
    if DRY_RUN:  # --dry-run: no orders.create, no ledger close
        out["decision"] = "DRY_RUN_SKIPPED"
        (OUT / f"session_raw_{SESSION}_sell_would_write.json").write_text(json.dumps(out, indent=2, default=str))
        return out
    try:
        preview = c.orders.preview({"request": params})
        time.sleep(0.35)
        out["preview"] = preview
        po = (preview or {}).get("order") or {}
        if not po or po.get("state") == "ORDER_STATE_REJECTED":
            out["error"] = f"preview_rejected: {json.dumps(preview, default=str)[:300]}"
            return out
    except Exception as e:
        out["error"] = f"preview_failed: {type(e).__name__}: {str(e)[:300]}"
        return out
    try:
        create = c.orders.create(params)
        time.sleep(0.45)
        out["create"] = create
        out["venue_order_id"] = (create or {}).get("id")
        execs = (create or {}).get("executions") or []
        out["n_executions"] = len(execs) if isinstance(execs, list) else None
        filled = False
        if isinstance(execs, list) and execs:
            filled = True
        # verify remaining position
        try:
            pos = c.portfolio.positions()
            time.sleep(0.35)
            rem = None
            raw = (pos or {}).get("availablePositions") or (pos or {}).get("positions") or {}
            if isinstance(raw, dict) and slug in raw:
                rem = money(raw[slug].get("netPosition") or raw[slug].get("qtyAvailable"))
            out["remaining_qty"] = rem
            if rem is not None and rem < 0.5:
                filled = True
        except Exception as e:
            out["pos_check_err"] = f"{type(e).__name__}: {str(e)[:120]}"
        out["decision"] = "SELL_FILLED" if filled else "SELL_PLACED_UNCONFIRMED"
    except Exception as e:
        out["error"] = f"create_failed: {type(e).__name__}: {str(e)[:300]}"
        out["decision"] = "SELL_FAILED"
        return out
    # Close ledger only if fill confirmed
    if out.get("decision") == "SELL_FILLED" and not DRY_RUN:
        try:
            conn = connect()
            cur = conn.cursor()
            cur.execute(
                """UPDATE public.pm_positions SET status='closed', closed_at=now(), updated_at=now(),
                       meta = coalesce(meta,'{}'::jsonb) || %s::jsonb
                   WHERE id=%s::uuid AND status='open' RETURNING id""",
                (json.dumps({"exit": "invalidation", "session": SESSION, "print": px, "inval": inval,
                             "venue_order_id": out.get("venue_order_id"), "at": datetime.now(timezone.utc).isoformat()}),
                 str(pos_id)),
            )
            closed = cur.fetchone()
            conn.commit()
            conn.close()
            out["ledger_closed"] = str(closed[0]) if closed else None
        except Exception as e:
            out["ledger_err"] = f"{type(e).__name__}: {str(e)[:200]}"
    return out


def pm_exit_invalidation(pos_id):
    """Live invalidation exit via pm_exit.py (HTTPS ledger close + realized_pnl). Never invents fills."""
    cmd = ["/workspace/oddsborne/.venv/bin/python", "/workspace/oddsborne/pm_exit.py",
           "--position-id", str(pos_id), "--reason", "invalidation",
           "--rationale", f"ODDSBORNE {SESSION}: fresh print at/below invalidation_price"]
    if DRY_RUN:
        print("DRY_RUN: would exit", " ".join(cmd), flush=True)
        return {"cmd": cmd, "rc": None, "decision": "DRY_RUN_SKIPPED"}
    r = subprocess.run(cmd, capture_output=True, text=True, cwd="/workspace/oddsborne")
    print("PM_EXIT_OUT", (r.stdout or "")[-2500:], (r.stderr or "")[-600:], flush=True)
    out = {"cmd": cmd, "rc": r.returncode, "stdout": (r.stdout or "")[-4000:]}
    try:
        j = json.loads(r.stdout)
    except Exception:
        j = {}
    out["result"] = j
    dec = str(j.get("decision") or "")
    out["decision"] = "SELL_FILLED" if (r.returncode == 0 and dec.upper() in ("CLOSED", "REDUCED")) else (
        "SELL_PLACED_UNCONFIRMED" if r.returncode == 0 else "SELL_FAILED")
    return out


def check_exits(c, open_lots, pos_by_slug):
    """For every open pm_positions row: compare venue print to invalidation_price; sell if <=."""
    exits = []
    covered = set()
    conn = cur = None
    try:
        conn = connect()
        cur = conn.cursor()
    except Exception as e:
        print("check_exits_db_offline", type(e).__name__, str(e)[:120], flush=True)
    for lot in open_lots:
        slug = lot.get("slug")
        if not slug and cur is not None:
            slug = slug_for_market_id(cur, lot.get("market_id"))
        lot["slug"] = slug
        d = {"lot_id": lot["id"], "slug": slug, "outcome": lot.get("outcome"),
             "qty": lot.get("qty"), "avg": lot.get("avg"), "inv": lot.get("inv"),
             "inv_note": lot.get("inv_note"), "action": None, "why": ""}
        if not slug:
            d["action"] = "ERROR"
            d["why"] = "no slug for market_id"
            exits.append(d)
            continue
        covered.add(slug)
        raw, s, tries = H.bbo_with_retry(c, slug, tries=4)
        time.sleep(0.4)
        bid, ask, mid = s.get("bid"), s.get("ask"), s.get("mid")
        d["bbo"] = {"bid": bid, "ask": ask, "mid": mid, "spr": s.get("spr")}
        print_px = bid if bid is not None else mid
        d["print"] = print_px
        inv = lot.get("inv")
        if inv is None:
            d["action"] = "MISSING_INVAL"
            d["why"] = "open lot lacks invalidation_price — must set before hold"
            exits.append(d)
            print(f"EXIT {slug} MISSING_INVAL", flush=True)
            continue
        # venue position qty cross-check
        pv = pos_by_slug.get(slug) if pos_by_slug else None
        venue_qty = lot.get("qty") or 0
        if isinstance(pv, dict):
            vq = money(pv.get("netPosition") or pv.get("netPositionDecimal") or pv.get("qtyAvailable"))
            if vq is not None:
                venue_qty = vq
                d["venue_qty"] = vq
        if print_px is not None and print_px <= float(inv):
            d["action"] = "KILL_SELL"
            d["why"] = f"print {print_px} <= inval {inv} — selling whole qty {venue_qty}"
            print(f"EXIT SELL {slug} print={print_px} inval={inv} qty={venue_qty}", flush=True)
            sell = pm_exit_invalidation(lot["id"])
            d["sell"] = sell
            if sell.get("decision") in ("SELL_FILLED", "SELL_PLACED", "SELL_PLACED_UNCONFIRMED"):
                d["action"] = "SOLD" if sell.get("decision") == "SELL_FILLED" else "SELL_ATTEMPTED"
                if sell.get("decision") == "SELL_FILLED":
                    covered.discard(slug)  # no longer covered after fill-exit

        else:
            d["action"] = "HOLD"
            d["why"] = f"print {print_px} > inval {inv}; hold; watch routines active"
            print(f"EXIT HOLD {slug} print={print_px} inval={inv}", flush=True)
        exits.append(d)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    return exits, covered


class _DryRunNoWrite(Exception):
    """Raised inside ledger-write blocks under --dry-run to take the no-write path."""


def write_pnl_safe(cash, equity, notes, payload):
    if DRY_RUN:  # --dry-run writes nothing: no pm_pnl, heartbeat or desk_agents
        as_of = datetime.now(timezone.utc)
        path = OUT / f"session_raw_{SESSION}_pnl_would_write.json"
        path.write_text(json.dumps({"cash": cash, "equity": equity, "notes": notes, "payload": payload,
                                    "as_of": as_of.isoformat()}, indent=2, default=str))
        print("DRY_RUN: would write pm_pnl + heartbeat + desk_agents ->", path, flush=True)
        return "DRY_RUN", "DRY_RUN", None, as_of
    try:
        conn = connect()
    except Exception as e:
        as_of = datetime.now(timezone.utc)
        pending = {"cash": cash, "equity": equity, "notes": notes, "payload": payload,
                   "as_of": as_of.isoformat(), "error": f"{type(e).__name__}: {e}"}
        path = OUT / f"session_raw_{SESSION}_pnl_pending.json"
        path.write_text(json.dumps(pending, indent=2, default=str))
        print("write_pnl_offline", path, flush=True)
        return f"PENDING_MCP:{path.name}", "PENDING_HB", None, as_of
    cur = conn.cursor()
    cur.execute("select public.oddsborne_touch_heartbeat()")
    cur.fetchone()
    as_of = datetime.now(timezone.utc)
    cur.execute(
        """
        INSERT INTO public.pm_pnl (account_key, as_of, realized, unrealized, fees, cash, equity, notes, payload)
        VALUES (%s, %s, 0, 0, 0, %s, %s, %s, %s::jsonb)
        RETURNING id
        """,
        ("polymarket-us-primary", as_of, cash, equity if equity is not None else cash, notes, json.dumps(payload, default=str)),
    )
    pnl_id = str(cur.fetchone()[0])
    cur.execute("select public.oddsborne_touch_heartbeat()")
    hb = str(cur.fetchone()[0])
    desk = None
    try:
        cur.execute(
            """UPDATE public.desk_agents SET status='active', heartbeat_at=now()
               WHERE slug='oddsborne' RETURNING slug, heartbeat_at"""
        )
        desk = cur.fetchone()
    except Exception as e:
        print("desk_agents_warn", type(e).__name__, str(e)[:120], flush=True)
        conn.rollback()
        # re-insert after rollback
        cur.execute("select public.oddsborne_touch_heartbeat()")
        hb = str(cur.fetchone()[0])
        cur.execute(
            """
            INSERT INTO public.pm_pnl (account_key, as_of, realized, unrealized, fees, cash, equity, notes, payload)
            VALUES (%s, %s, 0, 0, 0, %s, %s, %s, %s::jsonb)
            RETURNING id
            """,
            ("polymarket-us-primary", as_of, cash, equity if equity is not None else cash, notes, json.dumps(payload, default=str)),
        )
        pnl_id = str(cur.fetchone()[0])
        cur.execute("select public.oddsborne_touch_heartbeat()")
        hb = str(cur.fetchone()[0])
    conn.commit()
    conn.close()
    return pnl_id, hb, desk, as_of


def check_fee_coeff(c):
    try:
        # probe a known market for feeCoefficient if exposed
        r = c.markets.retrieve_by_slug("rdc-usfed-fomc-2026-10-28-hike25")
        time.sleep(0.3)
        m = r.get("market") if isinstance(r, dict) and "market" in r else r
        if isinstance(m, dict):
            for k in ("feeCoefficient", "fee_coefficient", "fees", "fee"):
                if k in m:
                    return {k: m.get(k)}
            # dig marketSides
            return {"keys_sample": list(m.keys())[:25], "theta_desk": THETA}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:120]}", "theta_desk": THETA}
    return {"theta_desk": THETA}


def parse_bovada_ts(path: Path):
    """Bovada coupon -> [{desc, ml, start(datetime UTC), live}] (adds startTime for the date check)."""
    raw = json.loads(path.read_text() or "[]")
    games = []
    for block in (raw if isinstance(raw, list) else [raw]):
        if not isinstance(block, dict):
            continue
        for ev in block.get("events") or []:
            desc = ev.get("description") or ""
            ml = {}
            for dg in ev.get("displayGroups") or []:
                for m in dg.get("markets") or []:
                    if (m.get("description") or "").strip().lower() != "moneyline":
                        continue
                    per = (m.get("period") or {})
                    if per and not per.get("main", True):
                        continue
                    outs = {}
                    for o in m.get("outcomes") or []:
                        name = o.get("description") or ""
                        if " - " in name:
                            continue
                        pr = o.get("price")
                        price = pr.get("american") if isinstance(pr, dict) else None
                        if name and price is not None:
                            outs[name] = {"american": str(price), "p": aft.am_to_p(price)}
                    if len(outs) == 2:
                        ml = outs
                        break
                if ml:
                    break
            st = ev.get("startTime")
            start = datetime.fromtimestamp(st / 1000, tz=timezone.utc) if isinstance(st, (int, float)) else None
            if ml:
                games.append({"desc": desc, "ml": ml, "start": start, "live": bool(ev.get("live"))})
    return games


def try_enter(pick, cash):
    """Dry-run then live pm_enter for a sports candidate (YES or NO). $5 requested; guidance caps."""
    px = float(pick["bid"])
    fair = float(pick["fair"])
    outcome = pick.get("outcome") or "yes"
    kill_fair = round(fair - 0.08, 4)
    inval = kill_fair if 0 < kill_fair < px else round(max(0.01, px - 0.05), 4)
    if not (0 < inval < px):
        inval = round(px * 0.5, 4)
    usd = REQUESTED_USD
    kill_txt = (
        f"Maker BUY {pick.get('matched')} {outcome.upper()} @{px} vs Bovada fair~{fair} "
        f"(post-fee maker {pick.get('post_fee_maker')}). KILL: print <= {inval}; "
        f"cancel unsold by game start; no revenge size-up."
    )
    inval_note = (
        f"Fresh print at or below {inval} (Bovada conservative (min prop/power/Shin) fair {fair} at entry minus 8c; "
        f"means the line/market moved hard against {pick.get('matched')}); or unfilled at game start."
    )
    cmd = [
        "/workspace/oddsborne/.venv/bin/python", "/workspace/oddsborne/pm_enter.py",
        "--slug", pick["market"], "--outcome", outcome, "--price", f"{px:.4f}",
        "--usd", str(usd), "--thesis", THESIS_SPORTS, "--p", f"{fair:.4f}",
        "--fair-source", f"Bovada conservative min(prop,power,Shin) de-vig ML {pick.get('bovada')} {pick.get('americans')} start {pick.get('bovada_start')}",
        "--rationale", f"ODDSBORNE {SESSION}: post-fee maker {pick.get('post_fee_maker')} > 0 vs Bovada (date-checked vs gameStartTime {pick.get('gameStartTime')})",
        "--kill", kill_txt, "--order-type", "maker_gtc",
        "--invalidation", f"{inval:.4f}", "--invalidation-note", inval_note, "--dry-run",
    ]
    print("DRY", " ".join(cmd), flush=True)
    dry = subprocess.run(cmd, capture_output=True, text=True, cwd="/workspace/oddsborne")
    print("DRY_OUT", (dry.stdout or "")[-3000:], flush=True)
    print("DRY_ERR", (dry.stderr or "")[-800:], flush=True)
    try:
        dry_j = json.loads(dry.stdout)
    except Exception:
        dry_j = {"raw": (dry.stdout or "")[:3000], "rc": dry.returncode}
    live_j = None
    if not DRY_RUN and os.environ.get("ODDS_LIVE") == "1" and dry.returncode == 0 and isinstance(dry_j, dict) and dry_j.get("decision") == "DRY_RUN_OK":
        doc = subprocess.run(["bash", "/workspace/grasshopper/stewards/doctor.sh"], capture_output=True, text=True)
        print("doctor_pre_live", doc.stdout[-200:], doc.returncode, flush=True)
        if doc.returncode != 0:
            return {"pick": pick, "px": px, "fair": fair, "invalidation": inval, "usd": usd,
                    "dry": dry_j, "live": None, "blocker": "doctor_failed", "cmd": cmd}
        live = subprocess.run([x for x in cmd if x != "--dry-run"], capture_output=True, text=True, cwd="/workspace/oddsborne")
        print("LIVE_OUT", (live.stdout or "")[-3000:], flush=True)
        print("LIVE_ERR", (live.stderr or "")[-800:], flush=True)
        try:
            live_j = json.loads(live.stdout)
        except Exception:
            live_j = {"raw": (live.stdout or "")[:3000], "rc": live.returncode}
    return {"pick": pick, "px": px, "fair": fair, "invalidation": inval, "usd": usd, "outcome": outcome,
            "dry": dry_j, "live": live_j, "cmd": cmd}


def main():
    # Box→Supabase pooler TCP is DOWN this session — fail DB instantly; ledger via MCP.
    def _connect_offline():
        raise TimeoutError("ConnectionTimeout: pooler TCP unreachable (session forced offline)")
    global connect
    import db_connect as _dbc
    _dbc.connect = _connect_offline
    connect = _connect_offline

    sec = load_secrets()
    for k, v in sec.items():
        os.environ[k] = v
    assert sec.get("POLYMARKET_US_KEY_ID") and sec.get("POLYMARKET_US_SECRET_KEY")

    c = PolymarketUS(key_id=sec["POLYMARKET_US_KEY_ID"], secret_key=sec["POLYMARKET_US_SECRET_KEY"], timeout=45.0)
    global CLIENT
    CLIENT = c
    blockers = []

    # 1) Fresh venue snap
    print("=== VENUE SNAP ===", flush=True)
    snap = venue_snap(c)
    cash, equity = snap["cash"], snap["equity"]
    print(f"cash={cash} equity={equity} pos={snap['n_pos']} orders={snap['n_orders']}", flush=True)

    fee_info = check_fee_coeff(c)
    print("fee_probe", fee_info, flush=True)

    notes0 = (
        f"Daily session AM {TODAY} ~{datetime.now(PT).strftime('%-I:%M %p PT')}. "
        f"Venue cash={cash} equity={equity} positions={snap['n_pos']} orders={snap['n_orders']}. "
        f"Fresh morning snap. Cash snapshot not period P/L. Ledger over HTTPS (steward-rpc) + Supabase MCP for notes."
    )
    pnl_id = os.environ.get("PNL_ID", "see pm_pnl_snapshot.py")
    hb = os.environ.get("HB_AT", "PENDING_HB")
    desk = None
    as_of = datetime.now(timezone.utc)
    print("pm_pnl", pnl_id, "hb", hb, flush=True)

    # 2) Open positions / exits
    open_lots = []
    try:
        from pm_enter import make_rpc
        _rpc = make_rpc()
        _rows = _rpc("oddsborne_open_positions", {}, idempotent=True) or []
        print("rpc_open_positions", json.dumps(_rows, default=str)[:1500], flush=True)
        open_lots = [
            {"id": str(r.get("id") or r.get("position_id")), "thesis_id": r.get("thesis_id"), "outcome": r.get("outcome"),
             "qty": float(r.get("quantity") or 0),
             "avg": float(r["average_cost"]) if r.get("average_cost") is not None else None,
             "inv": float(r["invalidation_price"]) if r.get("invalidation_price") is not None else None,
             "inv_note": r.get("invalidation_note"), "market_id": r.get("market_id"), "slug": r.get("slug") or r.get("market_slug")}
            for r in _rows
        ]
        raise StopIteration  # skip legacy psycopg path
        conn = connect()
        cur = conn.cursor()
        cur.execute(
            """SELECT id, thesis_id, outcome, quantity, average_cost, invalidation_price, invalidation_note, market_id
               FROM public.pm_positions WHERE status='open' ORDER BY opened_at DESC NULLS LAST"""
        )
        open_lots = [
            {"id": str(r[0]), "thesis_id": r[1], "outcome": r[2], "qty": float(r[3] or 0),
             "avg": float(r[4]) if r[4] is not None else None,
             "inv": float(r[5]) if r[5] is not None else None, "inv_note": r[6], "market_id": str(r[7]) if r[7] else None}
            for r in cur.fetchall()
        ]
        conn.close()
    except StopIteration:
        pass
    except Exception as e:
        print("open_lots_db_offline", type(e).__name__, str(e)[:120], flush=True)
        lots_path = Path(f"/workspace/oddsborne/deepdive_raw/session_{DSTAMP}_open_lots.json")
        open_lots = json.loads(lots_path.read_text())
        blockers.append(f"pm_positions via MCP snapshot file {lots_path.name}: {type(e).__name__}")
    print("open_lots", len(open_lots), flush=True)
    for lot in open_lots:
        print(f"  lot {lot['id'][:8]} qty={lot['qty']} avg={lot['avg']} inv={lot['inv']} note={(lot.get('inv_note') or '')[:60]}", flush=True)

    # 2b) EXITS FIRST — compare venue print to invalidation_price
    print("=== EXITS ===", flush=True)
    exits, covered_slugs = check_exits(c, open_lots, snap.get("pos_by_slug") or {})
    covered_slugs = set(covered_slugs)  # 10-08: Bucs maker cancelled overnight; TB-DAL treated as new market
    for _o in (snap.get("order_rows") or []):
        try:
            _ms = (_o.get("marketMetadata") or {}).get("slug") or _o.get("marketSlug") or _o.get("slug")
            if _ms:
                covered_slugs.add(str(_ms))
        except Exception:
            pass
    for _ms in (snap.get("pos_by_slug") or {}):
        covered_slugs.add(str(_ms))
    print("covered_slugs", sorted(covered_slugs), flush=True)

    # 3) Bovada (reuse files if fresh; else refresh)
    print("=== BOVADA ===", flush=True)
    for label, url, name in (
        ("mlb", "https://www.bovada.lv/services/sports/event/v2/events/A/description/baseball?marketFilterId=def&preMatchOnly=true&lang=en", "mlb"),
        ("nfl", "https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl?marketFilterId=def&preMatchOnly=true&lang=en", "nfl"),
    ):
        path = OUT / f"session_raw_{SESSION}_bovada_{name}.json"
        try:
            raw = aft.http_get(url)
            if raw.strip() in (b"", b"{}"):
                raw = aft.http_get(url.split("?")[0] + "?lang=en")
            path.write_bytes(raw)
            print(name, "bytes", len(raw), flush=True)
        except Exception as e:
            blockers.append(f"bovada_{name}: {type(e).__name__}: {str(e)[:120]}")
            if not path.exists():
                path.write_text("[]")
    mlb = parse_bovada_ts(OUT / f"session_raw_{SESSION}_bovada_mlb.json")
    nfl = parse_bovada_ts(OUT / f"session_raw_{SESSION}_bovada_nfl.json")
    print("bovada mlb", len(mlb), "nfl", len(nfl), flush=True)

    p2 = json.loads(P2.read_text()) if P2.exists() else {}
    events = p2.get("events") or {}

    # Build sports event index for matching
    horizon = NOW + timedelta(days=21)
    sports_ev = []
    for slug, ev in events.items():
        if ev.get("closed"):
            continue
        sl = slug.lower()
        title = (ev.get("title") or "").lower()
        if not (sl.startswith("nfl-") or sl.startswith("mlb-") or "nfl" in sl or "mlb" in sl):
            continue
        # skip props/fantasy
        if any(x in sl for x in ("rec-", "most", "fp-", "fantasy", "lastundefeated", "nextteam", "wk4", "race", "margin")):
            continue
        end = ev.get("endDate")
        try:
            dt = datetime.fromisoformat(str(end).replace("Z", "+00:00")) if end else None
        except Exception:
            dt = None
        if dt and dt > horizon:
            continue
        sports_ev.append(ev)
    print("sports events window", len(sports_ev), flush=True)

    # 4) Sports comps — DATE-CHECKED matcher (10-05 lesson): Bovada startTime must match the
    #    market's gameStartTime (±3h) and fair is matched to venue marketSides long team; score YES and NO.
    print("=== SPORTS ===", flush=True)
    comps = []
    date_mismatch = []
    quoted = 0
    _mk_cache = {}

    def market_meta(ms):
        if ms in _mk_cache:
            return _mk_cache[ms]
        meta = {}
        try:
            r = c.markets.retrieve_by_slug(ms)
            time.sleep(0.3)
            m = r.get("market", r) if isinstance(r, dict) else {}
            meta = {"gameStartTime": m.get("gameStartTime"), "marketType": m.get("marketType"),
                    "sportsMarketType": m.get("sportsMarketType"), "closed": m.get("closed"),
                    "feeCoefficient": m.get("feeCoefficient"), "status": m.get("status")}
            for sd in (m.get("marketSides") or []):
                t = sd.get("team") or {}
                if sd.get("long"):
                    meta["long_team"] = t.get("name") or sd.get("description")
                else:
                    meta["short_team"] = t.get("name") or sd.get("description")
            _SIDE_CACHE[ms] = meta.get("long_team")
        except Exception as e:
            meta = {"error": f"{type(e).__name__}: {str(e)[:100]}"}
        _mk_cache[ms] = meta
        return meta

    def pdt(x):
        try:
            return datetime.fromisoformat(str(x).replace("Z", "+00:00"))
        except Exception:
            return None

    _ev_cache = {}

    def event_markets(ev):
        sl = ev["slug"]
        if sl in _ev_cache:
            return _ev_cache[sl]
        mslugs = [m for m in (ev.get("market_slugs") or []) if str(m).startswith("aec-")]
        titles = {}
        r = aft.call_retry(lambda s=sl: c.events.retrieve_by_slug(s), f"get[{sl}]", 0.45)
        if isinstance(r, dict):
            evr = r.get("event") if isinstance(r.get("event"), dict) else r
            mkts = (evr or {}).get("markets") or []
            titles = {m.get("slug"): m.get("title") for m in mkts if isinstance(m, dict)}
            if not mslugs:
                mslugs = [m.get("slug") for m in mkts if isinstance(m, dict) and str(m.get("slug") or "").startswith("aec-")]
        _ev_cache[sl] = (mslugs, titles)
        return mslugs, titles

    for sport, games in (("mlb", mlb), ("nfl", nfl)):
        for g in games:
            fair_map = aft.devig(g["ml"])
            names = list(fair_map.keys())
            if len(names) < 2:
                continue
            if g.get("live"):
                print(f"  LIVE-SKIP {g.get('desc')}", flush=True)
                continue
            bov_start = g.get("start")
            tokens = []
            for name in names:
                toks = [t for t in name.lower().replace(".", "").split()
                        if len(t) > 3 and t not in ("city", "york", "los", "angeles", "san", "bay", "new")]
                tokens.append(toks[-1] if toks else name.lower().split()[-1])
            hits = []
            for ev in sports_ev:
                blob = ((ev.get("title") or "") + " " + ev.get("slug", "")).lower()
                if all(t in blob for t in tokens):
                    hits.append(ev)
            if not hits:
                continue
            matched_any = False
            for hit in hits:
                mslugs, titles = event_markets(hit)
                for ms in mslugs[:2]:
                    meta = market_meta(ms)
                    if meta.get("marketType") not in (None, "moneyline"):
                        continue
                    gst = pdt(meta.get("gameStartTime"))
                    if bov_start is None or gst is None or abs((gst - bov_start).total_seconds()) > 3 * 3600:
                        date_mismatch.append({"market": ms, "bovada": g.get("desc"),
                                              "bovada_start": bov_start.isoformat() if bov_start else None,
                                              "gameStartTime": meta.get("gameStartTime")})
                        continue
                    matched_any = True
                    if gst <= datetime.now(timezone.utc):  # 10-12 PM: in-play book vs stale prematch Bovada = not an edge
                        date_mismatch.append({"market": ms, "bovada": g.get("desc"), "started": True,
                                              "gameStartTime": meta.get("gameStartTime")})
                        print(f"  STARTED-SKIP {ms} gameStartTime={meta.get('gameStartTime')}", flush=True)
                        continue
                    raw, sb, tries = H.bbo_with_retry(c, ms, tries=4)
                    time.sleep(0.4)
                    quoted += 1
                    title = titles.get(ms)
                    bid, ask, spr, mid = sb.get("bid"), sb.get("ask"), sb.get("spr"), sb.get("mid")
                    matched, fair_p, how = match_fair_to_market(ms, fair_map, mid=mid, title=title)
                    americans = {k: v.get("american") for k, v in g["ml"].items()}
                    for side in ("yes", "no"):
                        _dm = (MF.devig_methods(g["ml"]) or {}).get(matched) if matched else None
                        _cf = (MF.conservative_fair(side, _dm["power"], _dm["shin"], _dm["prop"]) if _dm else None)
                        if side == "yes":
                            f_side = _cf["used"] if _cf else None  # 10-12: conservative min(prop, power, Shin)
                            mk_px = bid
                            tk_px = ask
                            team = matched
                        else:
                            f_side = _cf["used"] if _cf else None  # 10-12: conservative for NO = min(1-prop, 1-power, 1-Shin)
                            mk_px = round(1 - ask, 4) if ask is not None else None
                            tk_px = round(1 - bid, 4) if bid is not None else None
                            team = meta.get("short_team")
                        em_raw = post_fee_maker(f_side, mk_px) if mk_px is not None else None
                        em = post_fee_maker_gate(f_side, mk_px) if mk_px is not None else None  # gate (haircut)
                        et = post_fee(f_side, tk_px) if tk_px is not None else None
                        decision, why = "SKIP", ""
                        if ms in covered_slugs:
                            decision = "COVERED"
                            why = f"already held; fair {f_side} vs maker {mk_px}; post-fee maker raw {em_raw} gate {em}"
                        elif matched and not _dm:
                            decision = "ERROR"
                            why = f"no clean two-way Bovada line for de-vig ({how}); error, not a pass"
                        elif f_side is None or mk_px is None:
                            why = f"missing fair/bbo fair={f_side} {bid}/{ask} ({how})"
                        elif spr is not None and spr > 0.04:
                            why = f"spread {spr} wide; post-fee maker raw {em_raw} gate {em}"
                        elif em is not None and em >= MIN_EDGE:
                            decision = "CANDIDATE"
                            why = (f"post-fee maker gate {em} (raw {em_raw} - haircut {MAKER_HAIRCUT}) fair {f_side} "
                                   f"({team}/{how}) maker@{mk_px} (yes BBO {bid}/{ask})")
                        else:
                            why = (f"fair {f_side} ({team}/{how}) maker@{mk_px} taker@{tk_px}; post-fee maker raw {em_raw} "
                                   f"gate {em} (haircut {MAKER_HAIRCUT}, bar {MIN_EDGE}) taker {et}")
                        comp = {
                            "sport": sport, "event": hit.get("slug"), "market": ms, "title": title, "outcome": side,
                            "fair": f_side, "matched": team, "match_how": how,
                            "fair_prop": (_cf or {}).get("prop"), "fair_power": (_cf or {}).get("power"),
                            "fair_shin": (_cf or {}).get("shin"), "fair_used": (_cf or {}).get("used"),
                            "fair_method": (_cf or {}).get("method"),
                            "bid": mk_px, "ask": tk_px, "yes_bid": bid, "yes_ask": ask, "mid": mid, "spr": spr,
                            "post_fee_maker": em, "post_fee_maker_raw": em_raw, "maker_haircut": MAKER_HAIRCUT,
                            "post_fee_taker": et,
                            "decision": decision, "why": why, "bovada": g.get("desc"),
                            "bovada_start": bov_start.isoformat() if bov_start else None,
                            "gameStartTime": meta.get("gameStartTime"),
                            "americans": americans, "fair_map": fair_map,
                        }
                        comps.append(comp)
                        if _cf:
                            print(f"    FAIRS {ms} {side} prop={_cf['prop']} power={_cf['power']} shin={_cf['shin']} used={_cf['used']}({_cf['method']})", flush=True)
                        print(f"  {decision:9s} {ms} {side} {why[:170]}", flush=True)
            if not matched_any:
                print(f"  NO-DATE-MATCH {g.get('desc')} start={bov_start}", flush=True)
    print("date_mismatch_discarded", len(date_mismatch), flush=True)
    (OUT / f"session_raw_{SESSION}_sports_dated.json").write_text(json.dumps({"comps": comps, "date_mismatch": date_mismatch}, indent=2, default=str))
    if os.environ.get("SPORTS_ONLY"):
        print("SPORTS_ONLY_DONE", flush=True)
        return

    cands = [x for x in comps if x["decision"] == "CANDIDATE"]
    print("sports_errors", sum(1 for x in comps if x["decision"] == "ERROR"), flush=True)
    best = None
    if comps:
        best = max(comps, key=lambda x: x["post_fee_maker"] if x["post_fee_maker"] is not None else -9)

    # 5) Weather with belief-not-ban
    print("=== WEATHER ===", flush=True)
    weather = []
    for st in H.STATIONS:
        try:
            fc = H.fetch_nws_station(st)
        except Exception as e:
            fc = {"error": str(e)[:160]}
            blockers.append(f"nws {st}")
        time.sleep(0.1)
        metar = None
        try:
            mets = H.fetch_metars(st, hours=20)
            bestm = H.metar_max_for_local_day(mets, st, TODAY)
            if bestm:
                metar = {"tF": bestm["tF"], "ts": bestm["ts"]}
        except Exception:
            blockers.append(f"metar {st}")
        for day in (TODAY, TOMORROW):
            eslug = f"{H.STATIONS[st]['event_prefix']}-{day}"
            try:
                ev = c.events.retrieve_by_slug(eslug)
                time.sleep(0.3)
                if isinstance(ev, dict) and "event" in ev and "markets" not in ev:
                    ev = ev["event"]
                mkts = (ev or {}).get("markets") or [] if isinstance(ev, dict) else []
            except Exception as e:
                mkts = []
                blockers.append(f"wx {eslug}: {type(e).__name__}")
            buckets = []
            for m in mkts:
                if not isinstance(m, dict) or not m.get("slug"):
                    continue
                raw, s, tries = H.bbo_with_retry(c, m["slug"])
                time.sleep(0.28)
                buckets.append({"slug": m["slug"], "title": m.get("title"), "bid": s.get("bid"), "ask": s.get("ask"), "mid": s.get("mid"), "spr": s.get("spr")})
            scored = [b for b in buckets if b.get("mid") is not None]
            mode = max(scored, key=lambda x: x["mid"]) if scored else None
            book = {"mode": mode, "buckets": buckets}
            dec = decide_city_belief(st, day, book, fc if isinstance(fc, dict) else {}, metar)
            weather.append(dec)
            print(f"  WX {dec.get('city')} {day} {dec.get('decision')} {str(dec.get('reason',''))[:120]}", flush=True)

    wx_trade = [w for w in weather if w.get("decision") not in (None, "SKIP")]

    # 6) Fed + lean politics BBO shortlist
    print("=== FED + LEAN SWEEP ===", flush=True)
    fed = {}
    for slug in ("rdc-usfed-fomc-2026-10-28-hike25", "rdc-usfed-fomc-2026-10-28-nochng"):
        raw, s, tries = H.bbo_with_retry(c, slug)
        time.sleep(0.35)
        fed[slug] = {"bid": s.get("bid"), "ask": s.get("ask"), "mid": s.get("mid"), "spr": s.get("spr")}
        print("FED", slug, s.get("bid"), s.get("ask"), flush=True)

    lean_slugs = [
        "paccc-usho-midterms-2026-11-03-rep",
        "paccc-usho-midterms-2026-11-03-dem",
        "paccc-usse-midterms-2026-11-03-rep",
        "paccc-usse-midterms-2026-11-03-dem",
        "ewc-usse-tx-2026-11-03-rep",
        "ewc-usse-me-2026-11-03-rep",
        "urc-usunemp-sa-september-2026-10-02-gt4pt0pct",
        "urc-usunemp-sa-september-2026-10-02-gt4pt1pct",
        "urc-usunemp-sa-september-2026-10-02-gt4pt2pct",
        "cpic-uscpi-september-yoy-2026-10-14-gt3pt0pct",
        "cpic-uscpi-september-yoy-2026-10-14-gt3pt1pct",
        "cpc-btc-hitprice-high-yr-12-31-2026-100k",
        "cpc-btc-hitprice-high-yr-12-31-2026-110k",
        "tac-nobel-peace-2026-10-09-recerd",
        "tac-nobel-peace-2026-10-09-dontru",
        "tac-nobel-peace-2026-10-09-volzel",
        "rdc-usfed-fomc-2026-10-28-cut25",
        "rdc-usfed-fomc-2026-10-28-hike50",
    ]
    # add near aec-nfl moneylines from p2 within 7d not already quoted
    already = {x["market"] for x in comps}
    near_aec = []
    for slug, ev in events.items():
        for ms in (ev.get("market_slugs") or []):
            if not str(ms).startswith("aec-nfl-"):
                continue
            if ms in already:
                continue
            end = ev.get("endDate")
            try:
                dt = datetime.fromisoformat(str(end).replace("Z", "+00:00")) if end else None
            except Exception:
                dt = None
            if dt and dt <= NOW + timedelta(days=7):
                near_aec.append(ms)
    for ms in near_aec[:12]:
        lean_slugs.append(ms)

    lean_bbos = []
    for ms in lean_slugs:
        raw, s, tries = H.bbo_with_retry(c, ms, tries=3)
        time.sleep(0.35)
        row = {"market": ms, "bid": s.get("bid"), "ask": s.get("ask"), "mid": s.get("mid"), "spr": s.get("spr")}
        lean_bbos.append(row)
        print(f"  LEAN {ms} {s.get('bid')}/{s.get('ask')}", flush=True)

    # 7) Enter sports candidates with post-fee edge > 0 (skip COVERED)
    sports_enters = []
    sports_enter = None
    not_entered = []  # gate-clearing picks not entered, with reason (read by session_passlog.py)
    # one ticket per game (keyed by game/event, not market slug): skip a game already held/resting and never
    # take two picks (or both sides) of one game in this run; skipped picks are logged as same_game passes
    _cov_events = MF.held_game_keys(comps, covered_slugs)
    enterable = list(cands)
    if enterable and (cash or 0) < 5:
        not_entered += [{"market": x["market"], "outcome": x.get("outcome") or "yes",
                         "reason": f"blocked_cash (spendable {cash} < 5)"} for x in enterable]
    if enterable and (cash or 0) >= 5:
        # sort by edge desc; no entry-count cap: edge >= MIN_EDGE + steward_sizing_guidance (pm_enter) are the limits
        enterable = sorted(enterable, key=lambda x: x.get("post_fee_maker") or -9, reverse=True)
        for pick in enterable:
            if MF.same_game_skip(pick, _cov_events, covered_slugs):
                print("SKIP_SAME_GAME", pick["market"], pick.get("outcome"), flush=True)
                not_entered.append({"market": pick["market"], "outcome": pick.get("outcome") or "yes", "reason": "same_game"})
                continue
            print("ENTER_ATTEMPT", pick["market"], pick["post_fee_maker"], flush=True)
            _cov_events.add(MF.game_key(pick))  # one pick per game per run, placed or not
            se = try_enter(pick, cash)
            sports_enters.append(se)
            sports_enter = se  # last/primary for backward compat
            live = se.get("live") or {}
            if live.get("decision") == "PLACED":
                covered_slugs.add(pick["market"])
                # refresh cash estimate from guidance if present
                g = (live.get("guidance") or {})
                if g.get("spendable_cash") is not None:
                    try:
                        cash = float(g["spendable_cash"])
                    except Exception:
                        pass
    else:
        print("NO_SPORTS_CANDIDATE", "best=", (best or {}).get("market"), (best or {}).get("post_fee_maker"),
              "covered=", sorted(covered_slugs), flush=True)

    # 8) Postmortems — grade Sep 27 sports skips that have settled (NFL/MLB that day)
    postmortems = []
    # Known: Sep 27 NFL ari-sf etc played; quick note if we can confirm outcome from closed markets
    # Keep light: only if a skip note lacks postmortem for a settled game we referenced.
    # Sep 27 Angels already graded. Skip heavy grading this session unless clear due items.
    due_postmortems = "none_clear_due_beyond_prior_grades"

    # 9) Write pm_notes
    best_line = "no sports quote"
    if best:
        best_line = (
            f"{best.get('market')} post-fee maker {best.get('post_fee_maker')} "
            f"({best.get('decision')}) fair={best.get('fair')} vs {best.get('bid')}/{best.get('ask')}"
        )
    scan_body = (
        f"Daily AM {TODAY}. cash={cash} equity={equity}. Universe seen={p2.get('n_seen')} near={p2.get('n_near')}. "
        f"Sports quoted={quoted} candidates={len(cands)}. Best: {best_line}. "
        f"Weather non-skip={len(wx_trade)}. Fed hike25={fed.get('rdc-usfed-fomc-2026-10-28-hike25')}. "
        f"Midway/LAX-SFO treated as beliefs not bans. Θ={THETA}. Cash snapshot not period P/L."
    )
    skip_bits = []
    for w in weather:
        skip_bits.append(f"{w.get('city')} {w.get('day')}: {w.get('decision')} — {str(w.get('reason',''))[:90]}")
    for sc in sorted(comps, key=lambda x: -(x.get("post_fee_maker") or -9))[:8]:
        skip_bits.append(f"SPORT {sc.get('market')}: {sc.get('decision')} — {str(sc.get('why',''))[:100]}")
    scan_decision = "hold" if not (sports_enter and (sports_enter.get("live") or {}).get("decision") == "PLACED") else "enter"
    scan_meta = {"session": SESSION, "best": best, "n_candidates": len(cands), "fed": fed,
                 "n_seen": p2.get("n_seen"), "weather_non_skip": len(wx_trade)}
    skip_meta = {"comps_top": sorted(comps, key=lambda x: -(x.get("post_fee_maker") or -9))[:10],
                 "weather": [{k: w.get(k) for k in ("city","day","decision","reason","mode","mode_mid","nws","hmax","obsmax","belief_weighed")} for w in weather]}
    note_scan = note_skip = hb2 = None
    try:
        if DRY_RUN:  # --dry-run writes nothing: route to the would-write file below, no blocker
            raise _DryRunNoWrite()
        conn = connect()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO public.pm_notes (thesis_id, note_type, title, body, decision, meta)
               VALUES (%s, 'scan', %s, %s, %s, %s::jsonb) RETURNING id""",
            (THESIS_WX, f"Morning full-book + weather scan {TODAY}", scan_body, scan_decision,
             json.dumps(scan_meta, default=str)),
        )
        note_scan = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO public.pm_notes (thesis_id, note_type, title, body, decision, meta)
               VALUES (%s, 'skip', %s, %s, 'skip', %s::jsonb) RETURNING id""",
            (THESIS_SPORTS, f"Morning skips AM {TODAY}", "\n".join(skip_bits)[:8000],
             json.dumps(skip_meta, default=str)),
        )
        note_skip = str(cur.fetchone()[0])
        cur.execute("select public.oddsborne_touch_heartbeat()")
        hb2 = str(cur.fetchone()[0])
        conn.commit()
        conn.close()
    except Exception as e:
        if not isinstance(e, _DryRunNoWrite):
            print("pm_notes_offline", type(e).__name__, str(e)[:160], flush=True)
        else:
            print("DRY_RUN: would write pm_notes scan+skip + heartbeat", flush=True)
        pending = {
            "scan": {"thesis_id": THESIS_WX, "note_type": "scan", "title": f"Morning full-book + weather scan {TODAY}",
                     "body": scan_body, "decision": None, "meta": scan_meta},
            "skip": {"thesis_id": THESIS_SPORTS, "note_type": "skip", "title": f"Morning skips AM {TODAY}",
                     "body": "\n".join(skip_bits)[:8000], "decision": None, "meta": skip_meta},
            "error": f"{type(e).__name__}: {e}",
        }
        if isinstance(e, _DryRunNoWrite):
            path = OUT / f"session_raw_{SESSION}_notes_would_write.json"
            path.write_text(json.dumps(pending, indent=2, default=str))
            note_scan = note_skip = hb2 = "DRY_RUN"
        else:
            path = OUT / f"session_raw_{SESSION}_notes_pending.json"
            path.write_text(json.dumps(pending, indent=2, default=str))
            note_scan = f"PENDING_MCP:scan:{path.name}"
            note_skip = f"PENDING_MCP:skip:{path.name}"
            hb2 = hb if isinstance(hb, str) else "PENDING_HB"
            blockers.append(f"pm_notes via MCP pending file: {type(e).__name__}")

    entered = any(
        isinstance(se.get("live"), dict) and se["live"].get("decision") == "PLACED"
        for se in (sports_enters or ([sports_enter] if sports_enter else []))
    )
    sold_any = any(d.get("action") == "SOLD" for d in exits)
    # Final venue re-snap after exits/enters
    print("=== FINAL SNAP ===", flush=True)
    snap2 = venue_snap(c)
    cash2, equity2 = snap2["cash"], snap2["equity"]
    print(f"final cash={cash2} equity={equity2} pos={snap2['n_pos']} orders={snap2['n_orders']}", flush=True)

    # 10) Artifacts
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "at_pt": datetime.now(PT).strftime("%Y-%m-%d %-I:%M %p PT"),
        "cash": cash2,
        "equity": equity2,
        "cash_start": cash, "equity_start": equity,
        "n_positions": snap2["n_pos"],
        "n_orders": snap2["n_orders"],
        "pm_pnl_id": pnl_id, "heartbeat": hb2,
        "desk": [str(x) for x in desk] if desk else None,
        "n_seen": p2.get("n_seen"), "n_near": p2.get("n_near"),
        "sports_quoted": quoted, "candidates": cands, "best": best,
        "sports_enter": sports_enter, "sports_enters": sports_enters, "not_entered": not_entered,
        "covered_slugs": sorted(covered_slugs),
        "pos_detail": [
            {**{k: d.get(k) for k in ("lot_id","slug","outcome","qty","avg","inv","print","action","why")},
             "bbo": d.get("bbo")}
            for d in exits
        ],
        "weather_non_skip": [{k: w.get(k) for k in ("city","day","decision","reason")} for w in wx_trade],
        "weather": [{k: w.get(k) for k in ("city","day","decision","reason","mode","mode_mid","nws","hmax","obsmax","belief_weighed","belief_override")} for w in weather],
        "fed": fed, "lean_bbos": lean_bbos, "exits": exits, "open_lots": open_lots,
        "pm_notes": {"scan": note_scan, "skip": note_skip},
        "fee_probe": fee_info, "theta": THETA, "maker_rebate": MAKER_REBATE, "maker_haircut": MAKER_HAIRCUT_INFO,
        "blockers": blockers, "due_postmortems": due_postmortems,
        "outcome": ("TRADE" if entered else ("EXIT" if sold_any else "NO TRADE")),
        "notify_user": True,  # morning mandate + full-book
        "sold_any": sold_any,
    }
    (OUT / f"session_raw_{SESSION}_result.json").write_text(json.dumps(result, indent=2, default=str))
    (OUT / f"session_raw_{SESSION}_sports.json").write_text(json.dumps({"comps": comps, "candidates": cands, "best": best, "enter": sports_enter}, indent=2, default=str))
    (OUT / f"session_raw_{SESSION}_score.json").write_text(json.dumps({
        "at": result["at"], "at_pt": result["at_pt"], "cash": cash, "equity": equity,
        "n_seen": p2.get("n_seen"), "n_near": p2.get("n_near"),
        "sports_quoted": quoted, "candidates": cands, "best": best,
        "weather_non_skip": result["weather_non_skip"], "weather": result["weather"],
        "fed": fed, "blockers": blockers,
    }, indent=2, default=str))

    # markdown
    lines = []
    lines.append(f"# ODDSBORNE Daily Session — {TODAY}")
    lines.append("")
    lines.append(f"**As of:** ~{datetime.now(PT).strftime('%-I:%M %p PT')} (API/ledger {as_of.isoformat()})")
    lines.append("**Mandate:** Full-book liquid US sweep; hunt concentrated post-fee edge. Midway/LAX-SFO cool-side = beliefs not bans. No 8¢ bar.")
    lines.append(f"**Heartbeat:** `{hb2}`")
    lines.append("")
    lines.append("## Cash / book (live API — never invented)")
    lines.append("")
    lines.append("| Field | Value |")
    lines.append("|---|---:|")
    _cash = cash2
    _eq = equity2
    _npos = snap2["n_pos"]
    _nord = snap2["n_orders"]
    lines.append(f"| cash | **${_cash}** |")
    lines.append(f"| equity | **${_eq}** |")
    lines.append(f"| open positions | **{_npos}** |")
    lines.append(f"| open orders | **{_nord}** |")
    lines.append("")
    lines.append("Source: `account.balances()` + `portfolio.positions()` + `orders.list()`.")
    lines.append("")
    lines.append("## Playbook")
    lines.append(f"- weather_same_day_high; Midway/LAX-SFO cool = learned beliefs (weigh, note override); sports_devig_maker_edge post-fee > 0.")
    lines.append(f"- Fees LIVE: taker Θ=**{THETA}**; maker rebate **{MAKER_REBATE}**·p(1−p) credited; maker gate = raw − adverse-selection haircut **{MAKER_HAIRCUT}** ({MAKER_HAIRCUT_INFO.get('rule')}). Prefer maker. Probe: `{fee_info}`.")
    lines.append("")
    lines.append("## Actions")
    lines.append("")
    lines.append("### 1) Exits")
    lines.append(f"- Open pm_positions at start: **{len(open_lots)}**.")
    if not exits:
        lines.append("- No open lots to check.")
    for d in exits:
        lines.append(
            f"- `{d.get('slug')}` qty={d.get('qty')} avg={d.get('avg')} print={d.get('print')} "
            f"inval={d.get('inv')} → **{d.get('action')}** — {str(d.get('why',''))[:160]}"
        )
        if d.get("sell"):
            lines.append(f"  - sell: `{json.dumps({k: d['sell'].get(k) for k in ('decision','venue_order_id','error','ledger_closed','price','qty')}, default=str)}`")
    lines.append("")
    lines.append("### 2) Weather (belief-not-ban re-score)")
    lines.append("")
    lines.append("| City / day | Mode @ mid | NWS / hmax / obs | Decision | Why |")
    lines.append("|---|---|---|---|---|")
    for w in weather:
        lines.append(
            f"| {w.get('city')} {w.get('day')[5:] if w.get('day') else ''} | {w.get('mode')} @{w.get('mode_mid')} | "
            f"{w.get('nws')} / {w.get('hmax')} / {w.get('obsmax')} | **{w.get('decision')}** | {str(w.get('reason',''))[:140]} |"
        )
    lines.append("")
    lines.append("### 3) Sports vs Bovada (post-fee maker > 0; no 8¢ bar)")
    comps_sorted = sorted([c for c in comps if c.get("post_fee_maker") is not None], key=lambda x: -(x["post_fee_maker"]))
    if not comps_sorted:
        lines.append("- No matched Bovada↔PM quotes.")
    for sc in comps_sorted[:20]:
        lines.append(
            f"- **{sc.get('market')}** `{sc.get('matched')}` BBO {sc.get('bid')}/{sc.get('ask')} vs {sc.get('bovada')} "
            f"(devig ~{sc.get('fair')}) → maker post-fee **{sc.get('post_fee_maker')}** — {sc.get('decision')}"
        )
    if sports_enter:
        lj = sports_enter.get("live") or sports_enter.get("dry") or {}
        lines.append(f"- Enter attempt: `{json.dumps(lj, default=str)[:500]}`")
    else:
        if best:
            lines.append(f"- No sports enter: best {best.get('market')} post-fee maker {best.get('post_fee_maker')} ({best.get('decision')}).")
        else:
            lines.append("- No sports enter: no quotes.")
    lines.append("")
    lines.append("### 4) Oct Fed")
    for k, v in fed.items():
        lines.append(f"- {k} BBO **{v.get('bid')}/{v.get('ask')}** — watch-only")
    lines.append("")
    lines.append("### 5) TRADE / POSITIONS")
    if entered:
        for se in (sports_enters or [sports_enter]):
            if not se: continue
            lj = se.get("live") or {}
            if lj.get("decision") == "PLACED":
                lines.append(
                    f"- **TRADE** `{lj.get('slug') or (se.get('pick') or {}).get('market')}` "
                    f"{lj.get('outcome','yes').upper()} @ {se.get('px')} "
                    f"qty={((lj.get('sizing') or {}).get('quantity'))} "
                    f"thesis={THESIS_SPORTS} p={se.get('fair')} inval={se.get('invalidation')} "
                    f"venue={lj.get('venue_order_id') or lj.get('order_id')} "
                    f"pm_orders={lj.get('pm_order_id')}"
                )
            else:
                lines.append(f"- Enter attempt (not PLACED): `{json.dumps(lj, default=str)[:400]}`")
    elif sold_any:
        lines.append("- **EXIT** taken — see Exits. No new entries.")
    else:
        lines.append("- **NO TRADE** this morning (no new entry; open lots held if any).")
    # open position summary
    lines.append("")
    lines.append("### Open positions (post-exit check)")
    for d in exits:
        if d.get("action") in ("HOLD", "MISSING_INVAL", "KILL_SELL", "SOLD", "ERROR"):
            lines.append(
                f"- `{d.get('slug')}` {d.get('outcome')} qty={d.get('qty')} avg={d.get('avg')} "
                f"mark/print={d.get('print')} inval={d.get('inv')} → {d.get('action')}"
            )
    if not exits:
        lines.append("- none")
    lines.append("")
    # watch specs for NEW fills today
    watch_specs = []
    for se in (sports_enters or []):
        lj = se.get("live") or {}
        if lj.get("decision") == "PLACED":
            slug = lj.get("slug") or (se.get("pick") or {}).get("market")
            watch_specs.append({
                "name": f"oddsborne-watch-{slug.replace('aec-','') if slug else 'unknown'}",
                "slug": slug,
                "invalidation_price": se.get("invalidation") or lj.get("invalidation"),
                "interval_min": 30,
                "weekends": True,
                "venue_order_id": lj.get("venue_order_id") or lj.get("order_id"),
                "note": "Create same-day: check inval every ≤30m; sell whole on print ≤ line; delete on close/settle.",
            })
    if watch_specs:
        lines.append("### Watch (parent to create on NEW fill)")
        for ws in watch_specs:
            lines.append(
                f"- Name: `{ws['name']}` — `{ws['slug']}` inval **{ws['invalidation_price']}** "
                f"every {ws['interval_min']}m weekends incl.; venue {ws.get('venue_order_id')}"
            )
        lines.append("")
    result["watch_specs"] = watch_specs
    lines.append("## Full-book sweep (mandate)")
    lines.append(f"- Events inspected: **{p2.get('n_seen')}** (near≤21d **{p2.get('n_near')}**)")
    lines.append(f"- Sports moneylines BBO'd: **{quoted}**; lean shortlist BBO'd: **{len(lean_bbos)}**")
    lines.append("- Top lean watches:")
    for row in lean_bbos[:10]:
        if row.get("bid") is not None:
            lines.append(f"  - `{row['market']}` BBO {row.get('bid')}/{row.get('ask')} mid={row.get('mid')}")
    lines.append(f"- Decision after full-book: **{'TRADE' if entered else 'NO TRADE'}**")
    lines.append("")
    lines.append("## Files / ledger")
    lines.append(f"- `/workspace/oddsborne/daily_session_{TODAY.replace('-','')}.md`")
    lines.append(f"- `session_raw_{SESSION}_result.json`, `_score.json`, `_sports.json`, `_bal.json`")
    lines.append(f"- DB: `pm_pnl` `{pnl_id}`, `pm_notes` scan `{note_scan}` skip `{note_skip}`")
    lines.append("")
    lines.append("## Notify?")
    lines.append("")
    lines.append("**YES** — morning session mandate + full-book done.")
    md_path = OUT / f"daily_session_{TODAY.replace('-','')}.md"
    # fix filename: daily_session_20261004.md
    md_path = OUT / f"daily_session_{DSTAMP}{'_dry' if DRY_RUN else ''}.md"
    md_path.write_text("\n".join(lines) + "\n")
    result["watch_specs"] = watch_specs
    (OUT / f"session_raw_{SESSION}_result.json").write_text(json.dumps(result, indent=2, default=str))
    print("WROTE", md_path, flush=True)
    print("ONE_LINE", json.dumps({
        "outcome": result["outcome"],
        "cash": result.get("cash"), "equity": result.get("equity"),
        "n_pos": result.get("n_positions"), "n_orders": result.get("n_orders"),
        "pnl": pnl_id, "hb": hb2, "candidates": len(cands),
        "best": best_line, "weather_non_skip": len(wx_trade),
        "entered": entered, "sold_any": sold_any,
        "exits": [{k: d.get(k) for k in ("slug","action","print","inv")} for d in exits],
        "covered": sorted(covered_slugs),
        "blockers": blockers,
    }, default=str), flush=True)


if __name__ == "__main__":
    main()
