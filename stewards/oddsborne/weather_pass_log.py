#!/usr/bin/env python3
"""ODDSBORNE weather pass log: one scored skip per city-day per side on the market's FAVORITE bucket.

Purpose: test the pattern "the favorite bucket keeps missing when the NWS forecast sits a bucket below it"
(meta.pattern = 'fav_vs_forecast'). Every row is a `skip` on the favorite bucket's market slug, YES and NO.

Modes
  --live [--dates D1 D2 ...]   Fetch live BBOs for every bucket now (Polymarket US) and the NWS daytime
                               forecast high now (api.weather.gov). Default dates: today + tomorrow (PT).
                               YES is logged at the YES ask, NO at the NO ask (1 - YES bid); a side whose
                               book has no such quote is not logged. observed_at / decided_at = now.
  --session RESULT.json [--sweep P2.json]
                               Backfill from a session's recorded weather block (session_raw_*_result.json).
                               If an entry carries a per-bucket `buckets` list (slug/bid/ask/mid) it is used
                               as above; otherwise only the recorded favorite mid exists, so both sides are
                               logged at the recorded mid (YES mid, NO mid = 1 - YES mid) with
                               meta.price_basis='session_recorded_mid' and the asks marked missing. Nothing is
                               re-fetched in this mode: values the session did not record stay missing.
  --log                        Actually write (default is a dry run that prints the rows).

Probability: no session computes a per-bucket model probability (decide_city is a rule, not a model), and
steward_log_decision refuses a prediction pass without one. So probability = the side's market mid
(YES mid / 1 - YES mid), flagged meta.probability_source='market_mid'. Such a row carries no claimed edge;
it is scored on outcome (counterfactual_pnl vs the logged price). Brier on these rows is the market's, not ours.

Observed highs are never written at log time (recorded only after settlement). Prices are never invented.
Dedup: source_id 'wx_<date>_<city>_fav:<side>' (steward_log_decision does ON CONFLICT DO NOTHING), so the
first logged pass per city-day per side wins and re-runs replay.

  cd /workspace/oddsborne && .venv/bin/python weather_pass_log.py --live --log
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, "/workspace/oddsborne")

PT = ZoneInfo("America/Los_Angeles")
STEWARD = "oddsborne"
THESIS = "weather_same_day_high"
UA = {"User-Agent": "ODDSBORNE/1.0 (research; contact: oddsborne)", "Accept": "application/geo+json,application/json"}
# city label (as sessions write it) -> station + event prefix. Settled by the NWS CLI for the station.
CITIES = {
    "NYC": {"station": "KNYC", "prefix": "temp-nychigh"},
    "Midway": {"station": "KMDW", "prefix": "temp-mdwhigh"},
    "Miami": {"station": "KMIA", "prefix": "temp-miahigh"},
    "LAX": {"station": "KLAX", "prefix": "temp-laxhigh"},
    "SFO": {"station": "KSFO", "prefix": "temp-sfohigh"},
}
NWS_SOURCE = "api.weather.gov daytime forecast period (gridpoint at station coords)"
# station_mismatch heuristic: forecast >= this many buckets from the favorite, or NWS day high vs NWS hourly
# max for the same grid >= this many °F apart (the grid point and the settlement station disagree).
MISMATCH_BUCKETS = 2
MISMATCH_NWS_HOURLY_F = 3


# ---------- buckets ----------
def parse_bucket(slug: str | None, title: str | None = None):
    """Return (kind, lo, hi) inclusive integer °F. Slugs: lt62f (<=61), gte62lt63f (62-63), gte70f (>=70)."""
    s, t = str(slug or ""), str(title or "")
    m = re.search(r"(\d+)\s*to\s*(\d+)", t)
    if m:
        return ("range", int(m.group(1)), int(m.group(2)))
    m = re.search(r"(\d+)\s*or\s*below", t, re.I)
    if m:
        return ("below", None, int(m.group(1)))
    m = re.search(r"(\d+)\s*or\s*above", t, re.I)
    if m:
        return ("above", int(m.group(1)), None)
    m = re.search(r"gte(\d+)lt(\d+)f?$", s)
    if m:
        lo, lt = int(m.group(1)), int(m.group(2))
        return ("range", lo, lt if lt == lo + 1 else lt - 1)
    m = re.search(r"-lt(\d+)f?$", s)
    if m:
        return ("below", None, int(m.group(1)) - 1)
    m = re.search(r"-gte(\d+)f?$", s)
    if m:
        return ("above", int(m.group(1)), None)
    return ("unknown", None, None)


def label(b):
    kind, lo, hi = b
    return {"range": f"{lo} to {hi}", "below": f"{hi} or below", "above": f"{lo} or above"}.get(kind, "unknown")


def sort_key(b):
    kind, lo, hi = b
    return {"below": -1e9}.get(kind, lo if lo is not None else 1e9)


def bucket_index(temp, buckets):
    """Index of the bucket containing temp (buckets sorted ascending); nearest for gaps."""
    if temp is None:
        return None
    t = round(float(temp))
    for i, (kind, lo, hi) in enumerate(buckets):
        if (kind == "below" and t <= hi) or (kind == "above" and t >= lo) or (kind == "range" and lo <= t <= hi):
            return i
    best = None
    for i, (kind, lo, hi) in enumerate(buckets):
        edge = [x for x in (lo, hi) if x is not None]
        d = min(abs(t - x) for x in edge) if edge else 1e9
        if best is None or d < best[0]:
            best = (d, i)
    return best[1] if best else None


def mismatch(buckets_apart, nws, hmax):
    reasons = []
    if buckets_apart is not None and abs(buckets_apart) >= MISMATCH_BUCKETS:
        reasons.append(f"forecast {abs(buckets_apart)} buckets {'below' if buckets_apart > 0 else 'above'} the favorite")
    if nws is not None and hmax is not None and abs(float(nws) - float(hmax)) >= MISMATCH_NWS_HOURLY_F:
        reasons.append(f"NWS day high {nws} vs NWS hourly max {hmax} (grid vs station disagree)")
    return bool(reasons), ("; ".join(reasons) or None)


# ---------- row building ----------
def build_rows(date, city, slugs, favorite, nws, hmax, observed_at, basis, book=None):
    """favorite: {slug, bid, ask, mid}. book: per-bucket list (optional, for meta). Returns 0-2 rows."""
    buckets = sorted({s: parse_bucket(s) for s in slugs}.items(), key=lambda kv: sort_key(kv[1]))
    order = [b for _, b in buckets]
    fslug = favorite["slug"]
    fb = parse_bucket(fslug)
    fav_idx = [s for s, _ in buckets].index(fslug)
    fc_idx = bucket_index(nws, order)
    apart = None if fc_idx is None else fav_idx - fc_idx  # >0: forecast sits below the favorite
    mm, mm_reason = mismatch(apart, nws, hmax)
    bid, ask, mid = favorite.get("bid"), favorite.get("ask"), favorite.get("mid")
    base = {
        "forecast_high": nws, "forecast_bucket": None if fc_idx is None else label(order[fc_idx]),
        "nws_hourly_max": hmax, "favorite_bucket": label(fb), "favorite_price": mid,
        "favorite_yes_bid": bid, "favorite_yes_ask": ask, "buckets_apart": apart,
        "nws_source": NWS_SOURCE, "pattern": "fav_vs_forecast", "station": CITIES[city]["station"],
        "city": city, "target_date": date, "event_slug": f"{CITIES[city]['prefix']}-{date}",
        "station_mismatch": mm, "mismatch_reason": mm_reason, "observed_at": observed_at,
        "probability_source": "market_mid", "price_basis": basis,
    }
    if book:
        base["book"] = book
    rows = []
    for side in ("yes", "no"):
        meta = dict(base)
        if basis == "session_recorded_mid":
            if mid is None:
                continue
            price = mid if side == "yes" else round(1 - mid, 4)
            meta["yes_ask"] = "missing" if ask is None else ask
            meta["no_ask"] = "missing" if bid is None else round(1 - bid, 4)
        else:
            if side == "yes":
                price = ask
            else:
                price = None if bid is None else round(1 - bid, 4)
            if price is None or mid is None:
                continue  # no quote on this side -> no pass (never invent)
        prob = mid if side == "yes" else round(1 - mid, 4)
        if not (0 < price <= 1):
            continue
        rows.append({
            "source_id": f"wx_{date}_{city}_fav:{side}", "instrument": fslug, "side": side,
            "price": round(price, 4), "probability": round(prob, 4), "decided_at": observed_at,
            "reason": (f"wx pass {city} {date}: fav '{label(fb)}' mid {mid} vs NWS {nws} "
                       f"(bucket {base['forecast_bucket']}, {apart} apart); {side.upper()} @{round(price, 4)} "
                       f"[{basis}]; prob=market mid (no model)"),
            "meta": {k: v for k, v in meta.items() if v is not None or k in ("forecast_high", "buckets_apart")},
        })
    return rows


# ---------- live ----------
def http_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.loads(r.read().decode())


def nws_forecast(station, dates):
    """Daytime-period high and hourly max per date. No observations (obs never logged)."""
    st = http_json(f"https://api.weather.gov/stations/{station}")
    lon, lat = st["geometry"]["coordinates"][:2]
    props = http_json(f"https://api.weather.gov/points/{lat},{lon}")["properties"]
    periods = http_json(props["forecast"])["properties"]["periods"]
    hourly = http_json(props["forecastHourly"])["properties"]["periods"]
    out = {}
    for d in dates:
        day = next((p.get("temperature") for p in periods if p.get("isDaytime") and (p.get("startTime") or "")[:10] == d), None)
        hs = [p.get("temperature") for p in hourly if (p.get("startTime") or "")[:10] == d and p.get("temperature") is not None]
        out[d] = {"nws": day, "hmax": max(hs) if hs else None}
    return out


def _money(v):
    if isinstance(v, dict):
        v = v.get("value")
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def live_bbo(c, slug, tries=4):
    for i in range(tries):
        try:
            b = c.markets.bbo(slug)
            md = (b or {}).get("marketData") or b or {}
            bid, ask = _money(md.get("bestBid")), _money(md.get("bestAsk"))
            mid = round((bid + ask) / 2, 4) if bid is not None and ask is not None else None
            return {"slug": slug, "bid": bid, "ask": ask, "mid": mid}
        except Exception:
            time.sleep(0.4 * 2 ** i)
    return {"slug": slug, "bid": None, "ask": None, "mid": None, "error": "bbo failed"}


def live_rows(dates):
    from load_secrets import load_secrets
    from polymarket_us import PolymarketUS
    sec = load_secrets()
    c = PolymarketUS(key_id=sec["POLYMARKET_US_KEY_ID"], secret_key=sec["POLYMARKET_US_SECRET_KEY"], timeout=45.0)
    rows, problems, snap = [], [], []
    for city, info in CITIES.items():
        try:
            fc = nws_forecast(info["station"], dates)
        except Exception as e:
            fc = {d: {"nws": None, "hmax": None} for d in dates}
            problems.append(f"nws {city}: {type(e).__name__}")
        for d in dates:
            eslug = f"{info['prefix']}-{d}"
            try:
                ev = c.events.retrieve_by_slug(eslug)
                ev = ev.get("event", ev) if isinstance(ev, dict) else {}
                slugs = [m["slug"] for m in (ev.get("markets") or []) if isinstance(m, dict) and m.get("slug")]
            except Exception as e:
                problems.append(f"event {eslug}: {type(e).__name__}")
                continue
            now = datetime.now(timezone.utc).isoformat()
            book = []
            for s in slugs:
                book.append(live_bbo(c, s))
                time.sleep(0.25)
            quoted = [b for b in book if b["mid"] is not None]
            snap.append({"event": eslug, "observed_at": now, "forecast": fc[d], "book": book})
            if not quoted:
                problems.append(f"{eslug}: no two-sided bucket")
                continue
            fav = max(quoted, key=lambda b: b["mid"])
            rows += build_rows(d, city, slugs, fav, fc[d]["nws"], fc[d]["hmax"], now, "live_bbo",
                               book=[{k: b[k] for k in ("slug", "bid", "ask")} for b in book])
    return rows, problems, snap


# ---------- session backfill ----------
def session_rows(result_path, sweep_path):
    res = json.loads(Path(result_path).read_text())
    observed_at = res.get("at")
    events = {}
    if sweep_path and Path(sweep_path).exists():
        events = json.loads(Path(sweep_path).read_text()).get("events") or {}
    rows, problems = [], []
    for w in res.get("weather") or []:
        city, d = w.get("city"), w.get("day")
        if city not in CITIES:
            problems.append(f"unknown city {city}")
            continue
        eslug = f"{CITIES[city]['prefix']}-{d}"
        if w.get("buckets"):
            book = w["buckets"]
            slugs = [b["slug"] for b in book]
            quoted = [b for b in book if b.get("mid") is not None]
            if not quoted:
                problems.append(f"{eslug}: no recorded two-sided bucket")
                continue
            fav = max(quoted, key=lambda b: b["mid"])
            rows += build_rows(d, city, slugs, fav, w.get("nws"), w.get("hmax"), observed_at, "session_recorded_bbo",
                               book=[{k: b.get(k) for k in ("slug", "bid", "ask")} for b in book])
            continue
        slugs = (events.get(eslug) or {}).get("market_slugs") or []
        if not slugs:
            problems.append(f"{eslug}: no recorded market slugs")
            continue
        want = w.get("mode")
        fslug = next((s for s in slugs if label(parse_bucket(s)) == want), None)
        if fslug is None or w.get("mode_mid") is None:
            problems.append(f"{eslug}: favorite '{want}' not matched to a slug or no recorded mid")
            continue
        fav = {"slug": fslug, "bid": w.get("mode_bid"), "ask": w.get("mode_ask"), "mid": w.get("mode_mid")}
        basis = "session_recorded_bbo" if fav["bid"] is not None and fav["ask"] is not None else "session_recorded_mid"
        rows += build_rows(d, city, slugs, fav, w.get("nws"), w.get("hmax"), observed_at, basis)
    return rows, problems


def log_rows(rows):
    import steward_rpc
    out = []
    for r in rows:
        args = {"steward": STEWARD, "decision": "skip", "instrument": r["instrument"], "side": r["side"],
                "price": r["price"], "probability": r["probability"], "thesis_id": THESIS, "reason": r["reason"],
                "source_id": r["source_id"], "decided_at": r["decided_at"], "meta": r["meta"]}
        try:
            res = steward_rpc.call(STEWARD, "steward_log_decision", args)
        except Exception as e:
            res = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
        out.append({"source_id": r["source_id"], "result": res})
        print("LOGGED", r["source_id"], steward_rpc.dumps(res), flush=True)
        time.sleep(0.15)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--live", action="store_true")
    g.add_argument("--session")
    ap.add_argument("--sweep")
    ap.add_argument("--dates", nargs="*")
    ap.add_argument("--log", action="store_true")
    ap.add_argument("--out", help="write rows/results JSON here")
    a = ap.parse_args()
    snap = None
    if a.live:
        today = datetime.now(PT).date()
        dates = a.dates or [today.isoformat(), (today + timedelta(days=1)).isoformat()]
        rows, problems, snap = live_rows(dates)
    else:
        rows, problems = session_rows(a.session, a.sweep)
    for r in rows:
        m = r["meta"]
        print(f"{r['source_id']:<30} {r['instrument']:<36} {r['side']:<3} px={r['price']:<7} p={r['probability']:<7} "
              f"fc={m.get('forecast_high')}->{m.get('forecast_bucket')} fav={m['favorite_bucket']} "
              f"apart={m.get('buckets_apart')} mismatch={m['station_mismatch']}", flush=True)
    for p in problems:
        print("PROBLEM", p, flush=True)
    results = log_rows(rows) if a.log else []
    out = Path(a.out) if a.out else Path("/workspace/oddsborne/deepdive_raw") / (
        f"weather_pass_log_{datetime.now(PT).strftime('%Y%m%d_%H%M%S')}.json")
    if out.parent.exists():
        out.write_text(json.dumps({"rows": rows, "problems": problems, "results": results, "snapshot": snap},
                                  indent=1, default=str))
        print("wrote", out, flush=True)
    print(f"rows={len(rows)} logged={len(results) if a.log else 0} problems={len(problems)}", flush=True)
    return 1 if any("error" in (x["result"] or {}) for x in results if isinstance(x["result"], dict)) else 0


if __name__ == "__main__":
    sys.exit(main())
