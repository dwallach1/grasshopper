#!/usr/bin/env python3
"""READ-ONLY path scorer for meme_pullback_reclaim (edge2) paper passes. No ledger writes, no orders.

Usage (from /workspace/bandit):  .venv/bin/python edge2_path_score.py [--out-dir research]

Why: the ledger scores a pass as a plain 4h mark (first price at/after decided_at + 4h, minus book_price;
supabase/schemas/58_decision_marks.sql). The edge2 rule exits on a path (+50% / -40% / 4h), so the promotion
bar in research/edge2_promotion_bar.md is scored here instead.

1. Reads every BANDIT meme decision with thesis_id meme_pullback_reclaim via steward_rpc
   (bandit_decision_passes, read-only; supabase/schemas/69_bandit_decision_passes.sql) and keeps the skips.
2. Scores only passes whose 4h window has closed (decided_at + 4h + one 5m bar <= now).
3. GeckoTerminal 5m USD bars of the mint's top-reserve pool (same source as the scan's edge2 check).
   Entry = open of the first 5m bar starting at or after decided_at (the backtest's next-bar-open convention).
   Bars run up to and including the bar that starts at entry + 4h - 5m.
   Exit, same as edge2_fullexit_run.py: sell all at +50% if high >= 1.5x entry; kill at -40% if low <= 0.6x
   (if both happen in the same bar, the kill counts); otherwise the close of the last bar in the 4h window.
   Net = gross - 2.0 pp (1% round trip + 1% assumed impact), as in edge2_run.py.
   A pass with no pool or missing bars is reported as unscored with the reason. Prices are never filled in.
4. Prints n, the mean net, the mean net with the top 2 winners removed, and the promotion bar
   (n >= 20 and that mean > 0). Writes edge2_paper_scores.csv and .json.
"""
from __future__ import annotations
import argparse, csv, json, os, statistics as st, sys, time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests
from steward_rpc import call

THESIS = "meme_pullback_reclaim"; COST = 0.02; TP = 1.5; KILL = 0.6; BAR = 300; HOLD_BARS = 48
GT = "https://api.geckoterminal.com/api/v2"; PT = ZoneInfo("America/Los_Angeles")

def gt(path, params=None):
    for i in range(4):
        try:
            r = requests.get(f"{GT}/{path}", params=params or {}, headers={"accept": "application/json"}, timeout=30)
        except Exception:
            time.sleep(2); continue
        if r.status_code == 429: time.sleep(6 * (i + 1)); continue
        time.sleep(2.1)
        return r.json() if r.ok else {"_http": r.status_code}
    return None

def score(p, now):
    mint = p["instrument"]; t0 = datetime.fromisoformat(str(p["decided_at"]).replace("Z", "+00:00")).timestamp()
    pools = gt(f"networks/solana/tokens/{mint}/pools", {"page": 1})
    pl = (pools or {}).get("data") or []
    if not pl: return {"status": "unscored", "why": "no_pool" if pools is not None else "source_error"}
    pool = max(pl, key=lambda x: float((x.get("attributes") or {}).get("reserve_in_usd") or 0))["attributes"]["address"]
    start = int(t0 // BAR * BAR) + (0 if t0 % BAR == 0 else BAR)
    end = start + (HOLD_BARS - 1) * BAR
    d = gt(f"networks/solana/pools/{pool}/ohlcv/minute",
           {"aggregate": 5, "limit": 1000, "currency": "usd", "token": mint, "before_timestamp": end + BAR})
    bars = sorted([b for b in ((d or {}).get("data") or {}).get("attributes", {}).get("ohlcv_list") or []
                   if start <= b[0] <= end], key=lambda b: b[0])
    if not bars or bars[0][0] != start:
        return {"status": "unscored", "why": f"no entry bar at {start}", "pool": pool, "bars": len(bars)}
    e = bars[0][1]; gross = None; trig = None; exit_ts = None
    for b in bars:
        if b[3] <= e * KILL: gross, trig = KILL - 1, "kill"
        elif b[2] >= e * TP: gross, trig = TP - 1, "tp_full"
        if gross is not None: exit_ts = b[0]; break
    if gross is None:
        if bars[-1][0] != end:
            return {"status": "unscored", "why": f"window incomplete (last bar {bars[-1][0]} != {end})", "pool": pool}
        gross, trig, exit_ts = bars[-1][4] / e - 1, "4h_stop", bars[-1][0]
    return {"status": "scored", "pool": pool, "entry_ts": start, "entry_usd": e, "exit_trigger": trig, "exit_ts": exit_ts,
            "bars": len(bars), "gross_pct": round(gross * 100, 3), "net_pct": round((gross - COST) * 100, 3)}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out-dir", default="research"); a = ap.parse_args()
    now = datetime.now(timezone.utc)
    try:
        rows = call("bandit", "bandit_decision_passes", {"thesis_id": THESIS, "limit": 2000}, idempotent=True) or []
    except Exception as ex:
        print(f"ledger read failed: {type(ex).__name__}: {str(ex)[:200]}"); sys.exit(2)
    passes = [r for r in rows if r.get("decision") == "skip" and r.get("thesis_id") == THESIS]
    out = []
    for p in passes:
        t0 = datetime.fromisoformat(str(p["decided_at"]).replace("Z", "+00:00"))
        rec = {"decision_id": p["decision_id"], "mint": p["instrument"], "decided_at_pt": t0.astimezone(PT).isoformat(),
               "book_price_sol": p.get("book_price"), "source_id": p.get("source_id")}
        if t0 + timedelta(hours=4, minutes=5) > now: rec.update(status="open", why="4h window not closed")
        else:
            try: rec.update(score(p, now))
            except Exception as ex: rec.update(status="unscored", why=f"err {type(ex).__name__}")
        out.append(rec)
    sc = [r["net_pct"] for r in out if r.get("status") == "scored"]
    trimmed = sorted(sc)[:-2] if len(sc) > 2 else []
    summ = {"run_pt": now.astimezone(PT).isoformat(), "thesis_id": THESIS, "passes": len(passes), "n_scored": len(sc),
            "n_open": sum(r["status"] == "open" for r in out), "n_unscored": sum(r["status"] == "unscored" for r in out),
            "mean_net_pct": round(st.mean(sc), 3) if sc else None,
            "mean_net_top2_removed_pct": round(st.mean(trimmed), 3) if trimmed else None,
            "promotion_bar": "n >= 20 and mean net with top 2 winners removed > 0",
            "promotion_bar_met": bool(len(sc) >= 20 and trimmed and st.mean(trimmed) > 0)}
    os.makedirs(a.out_dir, exist_ok=True)
    json.dump({"summary": summ, "passes": out}, open(os.path.join(a.out_dir, "edge2_paper_scores.json"), "w"), indent=1, default=str)
    keys = sorted({k for r in out for k in r}) or ["decision_id"]
    with open(os.path.join(a.out_dir, "edge2_paper_scores.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, keys); w.writeheader(); w.writerows(out)
    print(f"n={summ['n_scored']} (passes {summ['passes']}, open {summ['n_open']}, unscored {summ['n_unscored']})")
    print(f"mean_net_pct={summ['mean_net_pct']} mean_net_top2_removed_pct={summ['mean_net_top2_removed_pct']}")
    print(f"promotion_bar_met={summ['promotion_bar_met']} ({summ['promotion_bar']})")

if __name__ == "__main__":
    main()
