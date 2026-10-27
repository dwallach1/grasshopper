#!/usr/bin/env python3
"""READ-ONLY path scorer for all BANDIT paper rules. No ledger writes, no orders, HTTPS only.

Usage (from /workspace/bandit):  .venv/bin/python paper_path_score.py [--out-dir research] [--thesis ID ...]

Theses and promotion bars:
  meme_pullback_reclaim (edge2)  locked bar (research/edge2_promotion_bar.md): n >= 20 and mean net with top 2 winners
                                  removed > 0. Scored exactly as edge2_path_score.py (no extra dedupe, same entry rule).
  meme_range_breakout   (edge3)  bar (research/edge3_prereg.md + edge3_edge4_amendment_20261016.md):
  meme_grad_pullback    (edge4)    n >= 20 forward passes AND mean - SE > 0 AND mean with top 2 winners removed > 0.
  meme_liq_accum        (edge5)    SE = sample stdev (n-1) / sqrt(n). Backtest trades never count.
  meme_flush_rebound    (edge6)  same bar (research/edge6_prereg.md); kill rule there (retire at n >= 10 if mean + SE < 0).

1. Passes: steward_rpc bandit_decision_passes(thesis_id) (read-only; supabase/schemas/69_bandit_decision_passes.sql),
   decision == 'skip' only.
2. Entry (bar open, GeckoTerminal 5m USD bars):
   edge2 / edge5: first 5m bar starting at or after decided_at (edge5 logs at the NEXT scan, so decided_at is the
                  next-scan entry per its prereg).
   edge3 / edge4 / edge6: the bar starting at meta.<edge>.prereg_entry_ts (open of the bar after the signal bar). Needs the
                  RPC to return meta; rows without it are 'unscored' (never guessed).
   Pool: edge2/edge5 top-reserve pool now (as edge2_path_score.py); edge3/edge6 meta.<edge>.pool, edge4 meta.edge4.mig_pool
   (fallback: top-reserve pool).
3. Exit (house): sell all at +50% if high >= 1.5x entry; kill at -40% if low <= 0.6x (kill wins if both in a bar);
   else close of the 48th bar (4h). Net = gross - 2.0 pp. Missing entry bar / incomplete window -> 'unscored'.
4. Voids: rows with blocked_by 'paper_void_stale' (edge5 pending entries voided after 2h; scan_https_once.py) are
   reported as their own count ('void') and are never scored, deduped against, or counted toward n.
5. Dedupe for edge3/4/5/6: first pass per coin per 4h (by entry time); later ones are 'dup_4h' and not counted.
   edge2 keeps its existing behaviour (no scorer-side dedupe; the scan already dedupes).
6. Run budget (--budget-s, default 150 s): every GeckoTerminal call has a (connect, read) timeout and bounded retries,
   OHLCV and pool lookups are cached per run (one fetch covers every pass on that pool inside its 1000-bar window), and
   progress goes to stderr. When the budget runs out the rest are 'deferred' (never scored, never counted toward n), the
   summary says partial=true, and the files are still written, so a slow API never hangs the run. Scored rows in the
   previous <out-dir>/paper_scores.json are reused (same thesis, decision_id, entry_ts), so a rerun picks up where the
   last one stopped; --fresh rescores everything.
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
    "meme_flush_rebound":    dict(edge="edge6", entry="meta", pool_key="pool", bar="se_top2", dedupe=True),
}
VOID_TAGS = {"paper_void_stale"}
BAR_TEXT = {"edge2_locked": "n >= 20 and mean net with top 2 winners removed > 0",
            "se_top2": "n >= 20 and mean - SE > 0 and mean net with top 2 winners removed > 0"}

HTTP_TIMEOUT = (5, 15)                   # (connect, read) seconds for every GeckoTerminal request
DEFAULT_BUDGET_S = 150

class Budget(Exception):
    """The run's wall-clock budget is spent; remaining passes are deferred."""

class Run:
    """Per-run state: deadline, OHLCV / pool caches, call counter."""
    def __init__(self, budget_s=DEFAULT_BUDGET_S):
        self.deadline = time.monotonic() + budget_s; self.ohlcv = {}; self.pools = {}; self.calls = 0
        self.prior = {}                  # (thesis_id, decision_id, entry_ts) -> scored row from the last run's json
    def left(self): return self.deadline - time.monotonic()

def _sleep(s, run):
    if run is not None and run.left() < s: raise Budget()
    time.sleep(s)

_ACTIVE = None                           # the Run in progress (gt() reads its deadline)

def gt(path, params=None):
    run = _ACTIVE
    for i in range(3):
        if run is not None:
            if run.left() <= 0: raise Budget()
            run.calls += 1
        try:
            r = requests.get(f"{GT}/{path}", params=params or {}, headers={"accept": "application/json"}, timeout=HTTP_TIMEOUT)
        except Exception:
            _sleep(2, run); continue
        if r.status_code == 429: _sleep(6 * (i + 1), run); continue
        time.sleep(2.1)                  # GeckoTerminal free tier: ~30 req/min
        try: return r.json() if r.ok else {"_http": r.status_code}
        except ValueError: return {"_http": r.status_code}
    return None

def _gt(path, params, run):
    if run is not None and run.left() <= 0: raise Budget()
    return gt(path, params)

def pool_for(mint, run):
    if run is not None and mint in run.pools: return run.pools[mint]
    pools = _gt(f"networks/solana/tokens/{mint}/pools", {"page": 1}, run)
    if run is not None and pools is not None: run.pools[mint] = pools
    return pools

def ohlcv(pool, mint, start, end, run):
    """Bars for pool up to end. Reuses a cached fetch when it reaches past `end` and back to `start`."""
    if run is not None:
        for before, bars in run.ohlcv.get(pool, []):
            if before >= end + BAR and bars and bars[0][0] <= start: return bars
    d = _gt(f"networks/solana/pools/{pool}/ohlcv/minute",
            {"aggregate": 5, "limit": 1000, "currency": "usd", "token": mint, "before_timestamp": end + BAR}, run)
    bars = sorted(((d or {}).get("data") or {}).get("attributes", {}).get("ohlcv_list") or [], key=lambda b: b[0])
    if run is not None and d is not None and "_http" not in d: run.ohlcv.setdefault(pool, []).append((end + BAR, bars))
    return bars

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

def score(p, cfg, start, run=None):
    mint = p["instrument"]
    pool = (_meta(p).get(cfg["edge"]) or {}).get(cfg.get("pool_key") or "") if cfg.get("pool_key") else None
    if not pool:
        pools = pool_for(mint, run)
        pl = (pools or {}).get("data") or []
        if not pl: return {"status": "unscored", "why": "no_pool" if pools is not None else "source_error"}
        pool = max(pl, key=lambda x: float((x.get("attributes") or {}).get("reserve_in_usd") or 0))["attributes"]["address"]
    end = start + (HOLD_BARS - 1) * BAR
    bars = [b for b in ohlcv(pool, mint, start, end, run) if start <= b[0] <= end]
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
            "n_scored": n, "n_open": cnt("open"), "n_unscored": cnt("unscored"), "n_dup_4h": cnt("dup_4h"), "n_void": cnt("void"),
            "n_deferred": cnt("deferred"), "partial": cnt("deferred") > 0,
            "mean_net_pct": None if mean is None else round(mean, 3), "se_pct": None if se is None else round(se, 3),
            "mean_minus_se_pct": None if se is None else round(mean - se, 3),
            "mean_net_top2_removed_pct": None if top2 is None else round(top2, 3),
            "promotion_bar": BAR_TEXT[cfg["bar"]], "promotion_bar_met": met}

def run_thesis(thesis, cfg, now, run=None):
    global _ACTIVE
    _ACTIVE = run
    rows = call("bandit", "bandit_decision_passes", {"thesis_id": thesis, "limit": 2000}, idempotent=True,
               timeout=30) or []
    passes = [r for r in rows if r.get("decision") == "skip" and r.get("thesis_id") == thesis]
    recs = []
    for p in passes:
        t0 = datetime.fromisoformat(str(p["decided_at"]).replace("Z", "+00:00"))
        rec = {"thesis_id": thesis, "decision_id": p["decision_id"], "mint": p["instrument"],
               "decided_at_pt": t0.astimezone(PT).isoformat(), "book_price_sol": p.get("book_price"),
               "source_id": p.get("source_id")}
        bb = p.get("blocked_by") or _meta(p).get("blocked_by")
        if bb in VOID_TAGS:
            rec.update(status="void", why=f"{bb}: {(_meta(p).get('void') or {}).get('reason') or 'voided'}")
            recs.append((p, rec, None)); continue
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
    todo = []
    for p, rec, start in recs:
        if rec.get("status"): continue
        # window closed: edge2 keeps its original test (decided_at + 4h05m); others: entry + 4h + one bar
        closed_at = _ts(p["decided_at"]) + 4 * 3600 + 300 if cfg["edge"] == "edge2" else start + HOLD_BARS * BAR + BAR
        if closed_at > now.timestamp(): rec.update(status="open", why="4h window not closed"); continue
        todo.append((p, rec, start))
    t0 = time.monotonic()
    for i, (p, rec, start) in enumerate(sorted(todo, key=lambda x: -x[2])):    # newest first: one fetch covers older
        prev = run.prior.get((thesis, str(rec["decision_id"]), start)) if run is not None else None
        if prev is not None:             # closed 4h window already scored: reuse, no API call
            rec.update({k: v for k, v in prev.items() if k not in rec}); continue
        if run is not None and run.left() <= 0:
            rec.update(status="deferred", why="run budget exhausted"); continue
        try: rec.update(score(p, cfg, start, run))
        except Budget: rec.update(status="deferred", why="run budget exhausted")
        except Exception as ex: rec.update(status="unscored", why=f"err {type(ex).__name__}")
        if run is not None and ((i + 1) % 10 == 0 or i + 1 == len(todo)):
            print(f"[{thesis}] {i + 1}/{len(todo)} scored-or-tried, {time.monotonic() - t0:.0f}s"
                  + f", {run.calls} API calls, {max(run.left(), 0):.0f}s budget left", file=sys.stderr, flush=True)
    out = [r for _, r, _ in recs]
    return summarize(thesis, cfg, out, len(passes), now), out

def load_prior(path):
    """Scored rows from a previous run. A closed window's bars don't change, so they are reused (not refetched)."""
    try:
        with open(path) as fh: rows = json.load(fh).get("passes") or []
    except (OSError, ValueError, AttributeError): return {}
    return {(r["thesis_id"], str(r["decision_id"]), r.get("entry_ts")): r for r in rows
            if isinstance(r, dict) and r.get("status") == "scored" and r.get("entry_ts") is not None and "decision_id" in r}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out-dir", default="research")
    ap.add_argument("--thesis", nargs="*", choices=list(THESES))
    ap.add_argument("--budget-s", type=float, default=DEFAULT_BUDGET_S, help="wall-clock cap; the rest are 'deferred'")
    ap.add_argument("--fresh", action="store_true", help="ignore scored rows in the previous paper_scores.json")
    a = ap.parse_args()
    now = datetime.now(timezone.utc); summ, allp = [], []; run = Run(a.budget_s)
    if not a.fresh: run.prior = load_prior(os.path.join(a.out_dir, "paper_scores.json"))
    # edge2 (meme_pullback_reclaim) REJECTED 2026-10-25 (GRASSHOPPER): not scored by default (its scorer hung >3 min in
    # the 2026-10-26 standup). Pass --thesis meme_pullback_reclaim to re-score its history on purpose.
    for th in (a.thesis or [t for t in THESES if t != "meme_pullback_reclaim"]):
        print(f"[{th}] reading passes", file=sys.stderr, flush=True)
        try: s, out = run_thesis(th, THESES[th], now, run)
        except Exception as ex:
            print(f"{th}: ledger read failed: {type(ex).__name__}: {str(ex)[:200]}"); sys.exit(2)
        summ.append(s); allp += out
    os.makedirs(a.out_dir, exist_ok=True)
    with open(os.path.join(a.out_dir, "paper_scores.json"), "w") as fh:
        json.dump({"run_pt": now.astimezone(PT).isoformat(), "summary": summ, "passes": allp}, fh, indent=1, default=str)
    keys = sorted({k for r in allp for k in r}) or ["thesis_id"]
    with open(os.path.join(a.out_dir, "paper_scores.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, keys); w.writeheader(); w.writerows(allp)
    f = lambda v: "-" if v is None else f"{v:+.2f}"
    print(f"{'thesis_id':24} {'edge':5} {'n':>3} {'open':>4} {'unsc':>4} {'dup':>3} {'void':>4} {'mean%':>7} {'exTop2%':>8} {'mean-SE%':>9}  bar_met")
    for s in summ:
        print(f"{s['thesis_id']:24} {s['edge']:5} {s['n_scored']:>3} {s['n_open']:>4} {s['n_unscored']:>4} {s['n_dup_4h']:>3} {s['n_void']:>4} "
              f"{f(s['mean_net_pct']):>7} {f(s['mean_net_top2_removed_pct']):>8} {f(s['mean_minus_se_pct']):>9}  {s['promotion_bar_met']}")
    for s in summ: print(f"  {s['edge']}: {s['promotion_bar']}")
    if any(s["partial"] for s in summ):
        print(f"PARTIAL: run budget {a.budget_s:.0f}s spent; deferred passes: "
              + ", ".join(f"{s['thesis_id']}={s['n_deferred']}" for s in summ if s["n_deferred"]) + " (rerun to finish)")

if __name__ == "__main__":
    main()
