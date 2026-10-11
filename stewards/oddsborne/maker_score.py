#!/usr/bin/env python3
"""ODDSBORNE maker_score: taker vs maker (all-fills) vs maker (fill-required) on logged sports skip passes.

READ-ONLY. Writes nothing to the ledger; only writes a JSON report (+ a venue cache) on the box.

Population: ODDSBORNE sports skip passes (thesis sports_devig_maker_edge) with a real close mark
(decision_marks kind='close', not provisional: meta.provisional not true AND taken <= 60 min before
event_start_at) -- exactly the non-provisional rows of public.v_decision_clv_all.

The box cannot read the ledger (no oddsborne read RPC; pooler unreachable), so rows come from a file:
  1. run the SQL printed by `maker_score.py --print-sql` via the Supabase connector (execute_sql, read-only)
  2. save the result (raw connector output or a plain JSON array) and run
     .venv/bin/python maker_score.py --rows FILE [--out OUT.json] [--no-venue] [--no-rfq]

Versions (all per contract, in the logged side's price terms, scored vs the close mid of that side):
  v1 taker      entry = side ASK at decision time (the "taker@X" logged in the pass reason; fallback: the
                venue price-history point at/before decided_at, flagged). Fee = +0.0695*p*(1-p).
                Also scored vs resolution (payoff 1/0) where the market resolved.
  v2 maker_all  entry = logged price (decision_candidates.book_price, i.e. the side's bid = maker@X), assumed
                filled. Fee = official Polymarket US maker rebate -0.0125*p*(1-p) (docs.polymarket.us/fees,
                eff. 2026-10-07; matches ledger maker fills, fitted 0.0124). Also reported with the session-script
                convention (post_fee_maker charges the TAKER fee +0.0695*p*(1-p) on maker fills).
  v3 maker_fill filled only if the venue actually TRADED at/through the logged price on that side between
                decided_at and the close mark. Polymarket US exposes no public per-market trade tape:
                  - /v1/report/trades/search is own-account only; /v1/report/trades/stats is institutional (bearer);
                  - the Markets WebSocket trade stream is live-only (no history);
                  - /v1/rfqs/trades (retail-signed) returns only RFQ/combo-originated prints.
                The scorer checks /v1/rfqs/trades per slug; a print at/through the price is a CONFIRMED fill,
                absence proves nothing. With zero confirmed prints v3 is reported as status 'no_data'.
  v3b proxy     (supplementary, NOT v3) book-touch: public GET gateway.polymarket.us/v1/price-history (book-derived
                display prices, ~1-min, longPrice = YES best ask, shortPrice = NO ask = 1 - YES best bid). A maker
                BUY at p on side S counts as touched if S's ask printed <= p in (decided_at, close]. Ignores queue
                position and pulled bids, so it is optimistic. Not trades.

Unit of independence = GAME (slug base, e.g. aec-nfl-chi-gb-2026-10-11): both sides and repeat passes on one
game move together. Each version reports n_marks and n_games; the headline mean is the mean of per-game means.
Read threshold: 30 closed games. Below that, results are for monitoring only, not for decisions.
Never invents prices: any missing input -> that row is excluded from that version and counted.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:  # reuse the desk fee model from pm_enter (THETA = 0.0695, fee = THETA*p*(1-p))
    from pm_enter import THETA as TAKER_THETA, fee_per_contract
except Exception:  # pragma: no cover - keep usable without the venv
    TAKER_THETA = 0.0695

    def fee_per_contract(price, theta=TAKER_THETA):
        p = float(price)
        return theta * p * (1.0 - p)

MAKER_THETA = -0.0125  # official maker rebate (fees.md); ledger maker fills fit -0.0124
READ_THRESHOLD_GAMES = 30
GATEWAY = "https://gateway.polymarket.us"
CACHE = Path(HERE) / "deepdive_raw" / "maker_score_cache"
EPS = 1e-9

EXPORT_SQL = """\
select a.decision_id, a.instrument, a.side, a.decided_at, a.entry_price, a.my_probability, a.close_mid,
       a.close_observed_at, a.event_start_at, a.minutes_before_start, a.close_source, a.mark_id,
       c.thesis_id, c.decision, c.book_price as raw_book_price,
       coalesce(c.meta->>'price_terms','side') as price_terms, c.resolved_outcome, c.resolved_at, c.reason,
       m.meta->'yes_bbo' as close_yes_bbo
from public.v_decision_clv_all a
join public.decision_candidates c on c.id = a.decision_id
join public.decision_marks m on m.id = a.mark_id
where a.steward = 'oddsborne' and a.decision = 'skip' and not a.provisional
  and c.thesis_id = 'sports_devig_maker_edge'
order by a.decided_at;"""

GAME_RE = re.compile(r"^([a-z]+-[a-z]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2})")
TAKER_RE = re.compile(r"taker@([0-9]*\.?[0-9]+)")


def ts(v):
    if v is None:
        return None
    s = str(v).replace(" ", "T")
    s = re.sub(r"\+00$", "+00:00", s)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def game_of(slug: str) -> str:
    m = GAME_RE.match(slug or "")
    return m.group(1) if m else slug


def load_rows(path: str) -> list[dict]:
    raw = Path(path).read_text()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        d = raw
    if isinstance(d, list):
        return d
    text = d.get("result") if isinstance(d, dict) else d
    if isinstance(text, list):
        return text
    m = re.search(r"(\[.*\])\s*</untrusted", str(text), re.S) or re.search(r"(\[.*\])", str(text), re.S)
    if not m:
        raise SystemExit(f"no row array found in {path}")
    return json.loads(m.group(1))


# ------------------------------------------------------------------ venue data (read-only, cached)
def _http_json(url: str, tries: int = 3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "oddsborne-maker-score/1"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(1.0 + i)


def price_history(slug: str, start: datetime, end: datetime) -> list[dict]:
    """Book-derived YES/NO display prices for [start, end], chunked to <= 24h windows, cached on disk."""
    out, s = [], int(start.timestamp()) - 60
    e_all = int(end.timestamp())
    CACHE.mkdir(parents=True, exist_ok=True)
    while s < e_all:
        e = min(s + 86400, e_all)
        cf = CACHE / f"ph_{slug}_{s}_{e}.json"
        if cf.exists():
            hist = json.loads(cf.read_text())
        else:
            url = (f"{GATEWAY}/v1/price-history?symbol={slug}&timestamp.startTimestamp={s}"
                   f"&timestamp.endTimestamp={e}&fidelity=1")
            hist = (_http_json(url) or {}).get("history") or []
            if e < time.time() - 120:  # only cache closed windows
                cf.write_text(json.dumps(hist))
            time.sleep(0.15)
        out.extend(hist)
        s = e
    seen, dedup = set(), []
    for p in sorted(out, key=lambda x: x.get("timestamp", 0)):
        if p.get("timestamp") not in seen:
            seen.add(p.get("timestamp"))
            dedup.append(p)
    return dedup


def side_ask(point: dict, side: str):
    return f(point.get("longPrice")) if side == "yes" else f(point.get("shortPrice"))


_CLIENT = None


def rfq_prints(slug: str, start: datetime, end: datetime) -> list[dict] | None:
    """RFQ/combo-originated prints on the slug (the only anonymous trade prints the retail API exposes)."""
    global _CLIENT
    try:
        if _CLIENT is None:
            from pm_enter import make_client
            _CLIENT = make_client()
        trades, cursor = [], None
        for _ in range(20):
            q = {"symbol": slug, "startTime": start.isoformat().replace("+00:00", "Z"),
                 "endTime": end.isoformat().replace("+00:00", "Z"), "limit": 100}
            if cursor:
                q["cursor"] = cursor
            r = _CLIENT.get("/v1/rfqs/trades", query=q, authenticated=True) or {}
            trades.extend(r.get("trades") or [])
            cursor = r.get("cursor")
            time.sleep(0.25)
            if not cursor:
                break
        return trades
    except Exception as ex:
        sys.stderr.write(f"rfq_prints {slug}: {type(ex).__name__}: {str(ex)[:160]}\n")
        return None


# ------------------------------------------------------------------ scoring
def score(rows: list[dict], use_venue: bool, use_rfq: bool) -> dict:
    per = []
    ph_cache: dict[str, list] = {}
    rfq_cache: dict[str, list | None] = {}
    for r in rows:
        slug, side = r["instrument"], r["side"]
        d_at, c_at = ts(r["decided_at"]), ts(r["close_observed_at"])
        close = f(r["close_mid"])
        maker_px = f(r["entry_price"])  # already in side terms (decision_in_side_terms)
        res = r.get("resolved_outcome")
        payoff = None if res not in ("yes", "no") else (1.0 if res == side else 0.0)
        rec = {"decision_id": r["decision_id"], "game": game_of(slug), "slug": slug, "side": side,
               "decided_at": r["decided_at"], "close_observed_at": r["close_observed_at"],
               "minutes_before_start": f(r.get("minutes_before_start")), "close_mid": close,
               "maker_px": maker_px, "resolved_outcome": res}

        hist = None
        if use_venue and d_at and c_at:
            key = slug
            if key not in ph_cache:
                lo = min(ts(x["decided_at"]) for x in rows if x["instrument"] == slug)
                hi = max(ts(x["close_observed_at"]) for x in rows if x["instrument"] == slug)
                try:
                    ph_cache[key] = price_history(slug, lo, hi)
                except Exception as ex:
                    sys.stderr.write(f"price_history {slug}: {type(ex).__name__}: {str(ex)[:160]}\n")
                    ph_cache[key] = None
            hist = ph_cache[key]

        # v1 taker entry
        m = TAKER_RE.search(r.get("reason") or "")
        taker_px, taker_src = (float(m.group(1)), "reason_taker@") if m else (None, None)
        if taker_px is None and hist:
            prior = [p for p in hist if p["timestamp"] <= d_at.timestamp()]
            if prior and d_at.timestamp() - prior[-1]["timestamp"] <= 300:
                taker_px, taker_src = side_ask(prior[-1], side), "price_history_at_decision"
        rec["taker_px"], rec["taker_src"] = taker_px, taker_src
        if taker_px is not None and close is not None:
            fee_t = fee_per_contract(taker_px, TAKER_THETA)
            rec["v1_edge_close"] = close - taker_px - fee_t
            rec["v1_edge_resolution"] = None if payoff is None else payoff - taker_px - fee_t
        # v2 maker all-fills
        if maker_px is not None and close is not None:
            rec["v2_edge_close"] = close - maker_px - MAKER_THETA * maker_px * (1 - maker_px)
            rec["v2_edge_close_session_fee"] = close - maker_px - fee_per_contract(maker_px, TAKER_THETA)
            rec["v2_edge_resolution"] = (None if payoff is None
                                         else payoff - maker_px - MAKER_THETA * maker_px * (1 - maker_px))
        # v3 confirmed trade prints (RFQ tape only)
        if use_rfq and d_at and c_at and maker_px is not None:
            if slug not in rfq_cache:
                lo = min(ts(x["decided_at"]) for x in rows if x["instrument"] == slug)
                hi = max(ts(x["close_observed_at"]) for x in rows if x["instrument"] == slug)
                rfq_cache[slug] = rfq_prints(slug, lo, hi)
            prints = rfq_cache[slug]
            if prints is None:
                rec["v3_status"] = "rfq_error"
            else:
                hit = []
                for t in prints:
                    et, px = ts(t.get("executedTime")), f(t.get("price"))
                    if et is None or px is None or not (d_at < et <= c_at):
                        continue
                    side_px = px if side == "yes" else 1.0 - px  # prints are in YES (long) price terms
                    if side_px <= maker_px + EPS:
                        hit.append(t.get("tradeId"))
                rec["v3_confirmed_fill"] = bool(hit)
                rec["v3_trade_ids"] = hit
                rec["v3_status"] = "confirmed" if hit else "no_print"
        # v3b book-touch proxy
        if hist is not None and d_at and c_at and maker_px is not None:
            win = [p for p in hist if d_at.timestamp() < p["timestamp"] <= c_at.timestamp()]
            asks = [a for a in (side_ask(p, side) for p in win) if a is not None]
            if asks:
                rec["v3b_min_side_ask"] = min(asks)
                rec["v3b_touched"] = min(asks) <= maker_px + EPS
                rec["v3b_n_points"] = len(asks)
        per.append(rec)

    def summarize(key: str, filt=None) -> dict:
        xs = [p for p in per if p.get(key) is not None and (filt is None or filt(p))]
        games: dict[str, list] = {}
        for p in xs:
            games.setdefault(p["game"], []).append(p[key])
        gmeans = {g: mean(v) for g, v in games.items()}
        return {
            "n_marks": len(xs), "n_games": len(gmeans),
            "mean_edge_c_per_game": round(100 * mean(gmeans.values()), 3) if gmeans else None,
            "median_edge_c_per_game": round(100 * median(gmeans.values()), 3) if gmeans else None,
            "games_positive": sum(1 for v in gmeans.values() if v > 0),
            "mean_edge_c_per_mark": round(100 * mean(p[key] for p in xs), 3) if xs else None,
            "per_game_c": {g: round(100 * v, 3) for g, v in sorted(gmeans.items())},
        }

    all_games = sorted({p["game"] for p in per})
    v3_confirmed = [p for p in per if p.get("v3_confirmed_fill")]
    v3_checked = [p for p in per if p.get("v3_status") in ("confirmed", "no_print")]
    if not v3_checked:
        v3 = {"status": "no_data", "reason": "trade prints not checked (--no-rfq or RFQ read failed)"}
    elif not v3_confirmed:
        v3 = {"status": "no_data",
              "reason": ("Polymarket US exposes no public per-market trade history. The only anonymous prints "
                         "(/v1/rfqs/trades) are RFQ/combo-originated and showed 0 prints on these slugs in the "
                         "decision->close windows, so fill vs no-fill cannot be determined."),
              "n_marks_checked": len(v3_checked), "fill_count": None}
    else:
        v3 = {"status": "partial_lower_bound", "fill_count_confirmed": len(v3_confirmed),
              "n_marks_checked": len(v3_checked),
              "note": "only RFQ-originated prints are visible; unconfirmed rows are unknown, not unfilled",
              **summarize("v2_edge_close", lambda p: p.get("v3_confirmed_fill"))}
    v3b_rows = [p for p in per if "v3b_touched" in p]
    v3b = {"status": "proxy_book_touch_not_trades", "n_marks_with_history": len(v3b_rows),
           "n_games_with_history": len({p["game"] for p in v3b_rows}),
           "touched_marks": sum(1 for p in v3b_rows if p["v3b_touched"]),
           "touched_games": len({p["game"] for p in v3b_rows if p["v3b_touched"]}),
           "edge_vs_close_if_touched": summarize("v2_edge_close", lambda p: p.get("v3b_touched")),
           "edge_vs_close_not_touched_for_reference": summarize("v2_edge_close",
                                                                lambda p: p.get("v3b_touched") is False)}
    n_games = len(all_games)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "population": "oddsborne sports skip passes, non-provisional close marks (v_decision_clv_all)",
        "fee_model": {"taker": f"+{TAKER_THETA}*p*(1-p) (pm_enter.fee_per_contract; session scripts)",
                      "maker": f"{MAKER_THETA}*p*(1-p) official rebate; session convention (+{TAKER_THETA}) also shown"},
        "unit_of_independence": "game (slug base); headline = mean of per-game means",
        "n_marks": len(per), "n_games": n_games, "games": all_games,
        "read_threshold_games": READ_THRESHOLD_GAMES,
        "decision_ready": n_games >= READ_THRESHOLD_GAMES,
        "warning": (None if n_games >= READ_THRESHOLD_GAMES else
                    f"ONLY {n_games} closed games (< {READ_THRESHOLD_GAMES}): monitoring only, do not use for decisions"),
        "v1_taker": {"vs_close": summarize("v1_edge_close"), "vs_resolution": summarize("v1_edge_resolution"),
                     "taker_px_sources": {s: sum(1 for p in per if p.get("taker_src") == s)
                                          for s in {p.get("taker_src") for p in per}}},
        "v2_maker_all_fills": {"vs_close": summarize("v2_edge_close"),
                               "vs_close_session_fee_convention": summarize("v2_edge_close_session_fee"),
                               "vs_resolution": summarize("v2_edge_resolution")},
        "v3_maker_fill_required": v3,
        "v3b_book_touch_proxy": v3b,
        "rows": per,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rows", help="JSON export of EXPORT_SQL (connector output or plain array)")
    ap.add_argument("--out", help="report path (default deepdive_raw/maker_score_<UTC>.json)")
    ap.add_argument("--print-sql", action="store_true")
    ap.add_argument("--no-venue", action="store_true", help="skip price-history (no taker fallback, no v3b)")
    ap.add_argument("--no-rfq", action="store_true", help="skip the RFQ print check (v3 -> no_data)")
    a = ap.parse_args(argv)
    if a.print_sql:
        print(EXPORT_SQL)
        return 0
    if not a.rows:
        ap.error("--rows is required (or --print-sql)")
    rows = load_rows(a.rows)
    rep = score(rows, use_venue=not a.no_venue, use_rfq=not a.no_rfq)
    out = Path(a.out or os.path.join(HERE, "deepdive_raw",
                                     f"maker_score_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"))
    out.write_text(json.dumps(rep, indent=1, default=str))
    (out.parent / "maker_score_latest.json").write_text(json.dumps(rep, indent=1, default=str))
    s = {k: rep[k] for k in ("n_marks", "n_games", "decision_ready", "warning")}
    s["v1_taker_close"] = {k: rep["v1_taker"]["vs_close"][k] for k in ("n_marks", "n_games", "mean_edge_c_per_game", "games_positive")}
    s["v1_taker_resolution"] = {k: rep["v1_taker"]["vs_resolution"][k] for k in ("n_marks", "n_games", "mean_edge_c_per_game")}
    s["v2_maker_close"] = {k: rep["v2_maker_all_fills"]["vs_close"][k] for k in ("n_marks", "n_games", "mean_edge_c_per_game", "games_positive")}
    s["v2_maker_close_session_fee"] = rep["v2_maker_all_fills"]["vs_close_session_fee_convention"]["mean_edge_c_per_game"]
    s["v3"] = {k: v for k, v in rep["v3_maker_fill_required"].items() if k != "per_game_c"}
    b = rep["v3b_book_touch_proxy"]
    s["v3b_proxy"] = {"touched_marks": b["touched_marks"], "of": b["n_marks_with_history"],
                      "touched_games": b["touched_games"], "of_games": b["n_games_with_history"],
                      "mean_edge_c_per_game_if_touched": b["edge_vs_close_if_touched"]["mean_edge_c_per_game"]}
    s["report"] = str(out)
    print(json.dumps(s, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
