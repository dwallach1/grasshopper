#!/usr/bin/env python3
"""READ-ONLY path scorer for all BANDIT paper rules. No ledger writes, no orders, HTTPS only.

Usage (from /workspace/bandit):  .venv/bin/python paper_path_score.py [--out-dir research] [--thesis ID ...]

Theses and promotion bars:
  meme_pullback_reclaim (edge2)  locked bar (research/edge2_promotion_bar.md): n >= 20 and mean net with top 2 winners
                                  removed > 0. Scored exactly as edge2_path_score.py (no extra dedupe, same entry rule).
  meme_range_breakout   (edge3)  bar (research/edge3_prereg.md + edge3_edge4_amendment_20261016.md):
  meme_grad_pullback    (edge4)    n >= 20 forward passes AND mean - SE > 0 AND mean with top 2 winners removed > 0.
  meme_liq_accum        (edge5)    SE = sample stdev (n-1) / sqrt(n). Backtest trades never count.

1. Passes: steward_rpc bandit_decision_passes(thesis_id) (read-only; supabase/schemas/69_bandit_decision_passes.sql),
   decision == 'skip' only.
2. Entry (bar open, GeckoTerminal 5m USD bars):
   edge2 / edge5: first 5m bar starting at or after decided_at (edge5 logs at the NEXT scan, so decided_at is the
                  next-scan entry per its prereg).
   edge3 / edge4: the bar starting at meta.<edge>.prereg_entry_ts (open of the bar after the signal bar). Needs the
                  RPC to return meta; rows without it are 'unscored' (never guessed).
   Pool: edge2/edge5 top-reserve pool now (as edge2_path_score.py); edge3 meta.edge3.pool, edge4 meta.edge4.mig_pool
   (fallback: top-reserve pool).
3. Exit (house): sell all at +50% if high >= 1.5x entry; kill at -40% if low <= 0.6x (kill wins if both in a bar);
   else close of the 48th bar (4h). Net = gross - 2.0 pp. Missing entry bar / incomplete window -> 'unscored'.
4. Dedupe for edge3/4/5: first pass per coin per 4h (by entry time); later ones are 'dup_4h' and not counted.
   edge2 keeps its existing behaviour (no scorer-side dedupe; the scan already dedupes).
Writes <out-dir>/paper_scores.json and paper_scores.csv; prints one table row per thesis.
"""
from __future__ import annotations
import argparse, csv, json, os, statistics as st, sys, time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import requests
from steward_rpc import call

COST = 0.02; TP = 1.5; KILL = 0.6; BAR = 300; HOLD_BARS = 48
GT = "https://api.geckoterminal.com/api/v2"; PT = ZoneInfo("America/Los_Angeles")
THESES = {
    "meme_pullback_reclaim": dict(edge="edge2", entry="decided_at", bar="edge2_locked", dedupe=False),
    "meme_range_breakout":   dict(edge="edge3", entry="meta", pool_key="pool", bar="se_top2", dedupe=True),
    "meme_grad_pullback":    dict(edge="edge4", entry="meta", pool_key="mig_pool", bar="se_top2", dedupe=True),
    "meme_liq_accum":        dict(edge="edge5", entry="decided_at", bar="se_top2", dedupe=True),
}
BAR_TEXT = {"edge2_locked": "n >= 20 and mean net with top 2 winners removed > 0",
            "se_top2": "n >= 20 and mean - SE > 0 and mean net with top 2 winners removed > 0"}

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

def _ts(x): return datetime.fromisoformat(str(x).replace("Z", "+00:00")).timestamp()
def _meta(p):
    m = p.get("meta")
    if isinstance(m, str):
        try: m = json.loads(m)
        except Exception: m = None
    return m if isinstance(m, dict) else {}

def entry_ts(p, cfg):
    """(entry bar start ts, error). Entry bar is the bar that STARTS at the returned ts."""
    if cfg["entry"] == "decided_at":
        t0 = _ts(p["decided_at"])
        return int(t0 // BAR * BAR) + (0 if t0 % BAR == 0 else BAR), None
    e = (_meta(p).get(cfg["edge"]) or {}).get("prereg_entry_ts")
    if e is None: return None, f"no meta.{cfg['edge']}.prereg_entry_ts in RPC row"
    return int(e), None

def score(p, cfg, start):
    mint = p["instrument"]
    pool = (_meta(p).get(cfg["edge"]) or {}).get(cfg.get("pool_key") or "") if cfg.get("pool_key") else None
    if not pool:
        pools = gt(f"networks/solana/tokens/{mint}/pools", {"page": 1})
        pl = (pools or {}).get("data") or []
        if not pl: return {"status": "unscored", "why": "no_pool" if pools is not None else "source_error"}
        pool = max(pl, key=lambda x: float((x.get("attributes") or {}).get("reserve_in_usd") or 0))["attributes"]["address"]
    end = start + (HOLD_BARS - 1) * BAR
    d = gt(f"networks/solana/pools/{pool}/ohlcv/minute",
           {"aggregate": 5, "limit": 1000, "currency": "usd", "token": mint, "before_timestamp": end + BAR})
    bars = sorted([b for b in ((d or {}).get("data") or {}).get("attributes", {}).get("ohlcv_list") or []
                   if start <= b[0] <= end], key=lambda b: b[0])
    if not bars or bars[0][0] != start:
        return {"status": "unscored", "why": f"no entry bar at {start}", "pool": pool, "bars": len(bars)}
    e = bars[0][1]; gross = None; trig = None; exit_ts = None
    for b in bars:
        if b[3] <= e * KILL: gross, trig = KILL - 1, "kill"          # kill wins a same-bar tie
        elif b[2] >= e * TP: gross, trig = TP - 1, "tp_full"
        if gross is not None: exit_ts = b[0]; break
    if gross is None:
        if bars[-1][0] != end:
            return {"status": "unscored", "why": f"window incomplete (last bar {bars[-1][0]} != {end})", "pool": pool}
        gross, trig, exit_ts = bars[-1][4] / e - 1, "4h_stop", bars[-1][0]
    return {"status": "scored", "pool": pool, "entry_usd": e, "exit_trigger": trig, "exit_ts": exit_ts,
            "bars": len(bars), "gross_pct": round(gross * 100, 3), "net_pct": round((gross - COST) * 100, 3)}

def summarize(thesis, cfg, out, n_passes, now):
    sc = [r["net_pct"] for r in out if r.get("status") == "scored"]; n = len(sc)
    mean = st.mean(sc) if sc else None
    se = st.stdev(sc) / n ** 0.5 if n >= 2 else None
    trimmed = sorted(sc)[:-2] if n > 2 else []
    top2 = st.mean(trimmed) if trimmed else None
    if cfg["bar"] == "edge2_locked":
        met = bool(n >= 20 and trimmed and top2 > 0)
    else:
        met = bool(n >= 20 and se is not None and mean - se > 0 and top2 is not None and top2 > 0)
    cnt = lambda s: sum(r["status"] == s for r in out)
    return {"run_pt": now.astimezone(PT).isoformat(), "thesis_id": thesis, "edge": cfg["edge"], "passes": n_passes,
            "n_scored": n, "n_open": cnt("open"), "n_unscored": cnt("unscored"), "n_dup_4h": cnt("dup_4h"),
            "mean_net_pct": None if mean is None else round(mean, 3), "se_pct": None if se is None else round(se, 3),
            "mean_minus_se_pct": None if se is None else round(mean - se, 3),
            "mean_net_top2_removed_pct": None if top2 is None else round(top2, 3),
            "promotion_bar": BAR_TEXT[cfg["bar"]], "promotion_bar_met": met}

def run_thesis(thesis, cfg, now):
    rows = call("bandit", "bandit_decision_passes", {"thesis_id": thesis, "limit": 2000}, idempotent=True) or []
    passes = [r for r in rows if r.get("decision") == "skip" and r.get("thesis_id") == thesis]
    recs = []
    for p in passes:
        t0 = datetime.fromisoformat(str(p["decided_at"]).replace("Z", "+00:00"))
        rec = {"thesis_id": thesis, "decision_id": p["decision_id"], "mint": p["instrument"],
               "decided_at_pt": t0.astimezone(PT).isoformat(), "book_price_sol": p.get("book_price"),
               "source_id": p.get("source_id")}
        start, err = entry_ts(p, cfg)
        if err: rec.update(status="unscored", why=err)
        else: rec.update(entry_ts=start, entry_pt=datetime.fromtimestamp(start, PT).isoformat())
        recs.append((p, rec, start))
    if cfg["dedupe"]:                                    # first pass per coin per 4h, by entry time
        last = {}
        for p, rec, start in sorted([x for x in recs if x[2] is not None], key=lambda x: x[2]):
            prev = last.get(rec["mint"])
            if prev is not None and start - prev < 4 * 3600:
                rec.update(status="dup_4h", why=f"pass within 4h of entry {prev}"); continue
            last[rec["mint"]] = start
    for p, rec, start in recs:
        if rec.get("status"): continue
        # window closed: edge2 keeps its original test (decided_at + 4h05m); others: entry + 4h + one bar
        closed_at = _ts(p["decided_at"]) + 4 * 3600 + 300 if cfg["edge"] == "edge2" else start + HOLD_BARS * BAR + BAR
        if closed_at > now.timestamp(): rec.update(status="open", why="4h window not closed"); continue
        try: rec.update(score(p, cfg, start))
        except Exception as ex: rec.update(status="unscored", why=f"err {type(ex).__name__}")
    out = [r for _, r, _ in recs]
    return summarize(thesis, cfg, out, len(passes), now), out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out-dir", default="research")
    ap.add_argument("--thesis", nargs="*", choices=list(THESES)); a = ap.parse_args()
    now = datetime.now(timezone.utc); summ, allp = [], []
    for th in (a.thesis or list(THESES)):
        try: s, out = run_thesis(th, THESES[th], now)
        except Exception as ex:
            print(f"{th}: ledger read failed: {type(ex).__name__}: {str(ex)[:200]}"); sys.exit(2)
        summ.append(s); allp += out
    os.makedirs(a.out_dir, exist_ok=True)
    json.dump({"run_pt": now.astimezone(PT).isoformat(), "summary": summ, "passes": allp},
              open(os.path.join(a.out_dir, "paper_scores.json"), "w"), indent=1, default=str)
    keys = sorted({k for r in allp for k in r}) or ["thesis_id"]
    with open(os.path.join(a.out_dir, "paper_scores.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, keys); w.writeheader(); w.writerows(allp)
    f = lambda v: "-" if v is None else f"{v:+.2f}"
    print(f"{'thesis_id':24} {'edge':5} {'n':>3} {'open':>4} {'unsc':>4} {'dup':>3} {'mean%':>7} {'exTop2%':>8} {'mean-SE%':>9}  bar_met")
    for s in summ:
        print(f"{s['thesis_id']:24} {s['edge']:5} {s['n_scored']:>3} {s['n_open']:>4} {s['n_unscored']:>4} {s['n_dup_4h']:>3} "
              f"{f(s['mean_net_pct']):>7} {f(s['mean_net_top2_removed_pct']):>8} {f(s['mean_minus_se_pct']):>9}  {s['promotion_bar_met']}")
    for s in summ: print(f"  {s['edge']}: {s['promotion_bar']}")

if __name__ == "__main__":
    main()
