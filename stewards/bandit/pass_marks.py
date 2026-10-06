#!/usr/bin/env python3
"""BANDIT pass_marks: price the passes BANDIT logged once their 4-hour horizon is up.

Usage (from /workspace/bandit):
  .venv/bin/python pass_marks.py            # mark every pass whose horizon has passed
  .venv/bin/python pass_marks.py --dry-run  # fetch and print; no ledger write

It also runs on its own at the end of mark_clip.py and pnl_snapshot.py (BANDIT's scheduled watch and
standup scripts), so new passes are scored without a separate routine. BANDIT_PASS_MARKS=0 turns that off.

Why: a pass is a mint BANDIT did not buy, so none of its own marks (fills, meme_tokens, meme_positions)
ever price it, and the scorer left every pass at resolve_status = no_mark_yet.

For each pass from public.steward_pending_decision_marks (scoreable, horizon passed, no mark yet):
  1. the first real price observed at or after the horizon, in SOL per token, from either
     - Jupiter Price v3 (the source BANDIT prices its entries and passes with): token usdPrice / SOL usdPrice
       from one response, observed now. Live only; it cannot look back.
     - GeckoTerminal 1-minute OHLCV for the mint's deepest SOL-quoted pool: the close of the first traded
       candle that starts at or after the horizon (observed_at = that candle's start). The candle's open is
       the previous close, so it is never used.
     whichever was observed earlier wins (so a late run still gets the price nearest the horizon);
  2. public.steward_record_decision_mark writes it (the database computes the horizon and refuses an earlier
     observation), and the resolver scores the pass: counterfactual_pnl = mark - book_price, one token, SOL.
  3. If both sources affirmatively have no price (no Jupiter price, no SOL pool or no trade on GeckoTerminal)
     and the horizon is more than an hour old, the pass is flagged unscoreable with that reason. A network
     error is never a reason: the pass is retried next run. Nothing is interpolated or carried forward.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import clip_common as cc

JUP_PRICE = "https://api.jup.ag/price/v3"
GECKO = "https://api.geckoterminal.com/api/v2"
GECKO_HEADERS = {"accept": "application/json;version=20230302"}
WINDOW_MINUTES = 1000  # GeckoTerminal max candles per call: first trade within ~16.6h of the horizon
NO_PRICE_GRACE = timedelta(hours=1)  # indexers lag; only call it unpriced once the horizon is this old
TIMEOUT = 20


class SourceError(RuntimeError):
    """The source could not be read (network, HTTP 5xx/429). Not evidence that there is no price."""


def _get(url: str, *, params=None, headers=None):
    import requests
    try:
        r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
    except Exception as e:  # requests.RequestException and friends
        raise SourceError(f"{type(e).__name__}: {str(e)[:200]}") from None
    return r


def jupiter_price(mint: str, api_key: str | None, now: datetime) -> dict:
    """{'price': Decimal SOL/token, 'observed_at', 'source', 'meta'} or {'none': reason}. Raises SourceError."""
    if not api_key:
        raise SourceError("JUPITER_API_KEY not set")
    r = _get(JUP_PRICE, params={"ids": f"{mint},{cc.SOL_MINT}"}, headers={"x-api-key": api_key})
    if r.status_code != 200:
        raise SourceError(f"jupiter price/v3 HTTP {r.status_code}: {r.text[:200]}")
    data = r.json(parse_float=Decimal) or {}
    sol = (data.get(cc.SOL_MINT) or {}).get("usdPrice")
    if not sol or Decimal(str(sol)) <= 0:
        raise SourceError("jupiter price/v3 returned no SOL price")
    tok = (data.get(mint) or {}).get("usdPrice")
    if not tok or Decimal(str(tok)) <= 0:
        return {"none": "jupiter price v3 has no price for the mint"}
    price = (Decimal(str(tok)) / Decimal(str(sol))).quantize(Decimal("1e-18"))
    if price <= 0:
        return {"none": "jupiter price v3 price rounds to zero SOL"}
    return {"price": price, "observed_at": now, "source": "jupiter_price_v3",
            "meta": {"token_usd": str(tok), "sol_usd": str(sol), "block_id": (data.get(mint) or {}).get("blockId"),
                     "method": "token usdPrice / SOL usdPrice, one response (as live_trade_clip prices entries)"}}


def gecko_sol_pool(mint: str) -> dict:
    """Deepest pool with the mint as base and wrapped SOL as quote: {'pool', 'dex', 'reserve_usd'} or {'none'}."""
    r = _get(f"{GECKO}/networks/solana/tokens/{mint}/pools", params={"page": 1}, headers=GECKO_HEADERS)
    if r.status_code == 404:
        return {"none": "geckoterminal does not list the mint"}
    if r.status_code != 200:
        raise SourceError(f"geckoterminal pools HTTP {r.status_code}: {r.text[:200]}")
    best = None
    for p in (r.json(parse_float=Decimal) or {}).get("data") or []:
        rel = p.get("relationships") or {}
        base = ((rel.get("base_token") or {}).get("data") or {}).get("id")
        quote = ((rel.get("quote_token") or {}).get("data") or {}).get("id")
        if base != f"solana_{mint}" or quote != f"solana_{cc.SOL_MINT}":
            continue
        reserve = Decimal(str((p.get("attributes") or {}).get("reserve_in_usd") or "0"))
        if best is None or reserve > best["reserve_usd"]:
            best = {"pool": (p.get("attributes") or {}).get("address") or p["id"].split("_", 1)[-1],
                    "dex": ((rel.get("dex") or {}).get("data") or {}).get("id"), "reserve_usd": reserve,
                    "name": (p.get("attributes") or {}).get("name")}
    return best or {"none": "geckoterminal has no SOL-quoted pool for the mint"}


def gecko_first_trade(mint: str, horizon: datetime, now: datetime) -> dict:
    """Close of the first traded 1-minute candle starting at or after the horizon, in SOL per token."""
    pool = gecko_sol_pool(mint)
    if "none" in pool:
        return pool
    h = int(horizon.timestamp())
    start = h if h % 60 == 0 else h - h % 60 + 60  # first candle that starts at or after the horizon
    end = min(int(now.timestamp()), start + WINDOW_MINUTES * 60)
    if end <= start:
        return {"none": "no complete 1-minute candle after the horizon yet", "retry": True}
    r = _get(f"{GECKO}/networks/solana/pools/{pool['pool']}/ohlcv/minute",
             params={"aggregate": 1, "before_timestamp": end, "limit": WINDOW_MINUTES, "currency": "token",
                     "token": "base"}, headers=GECKO_HEADERS)
    if r.status_code != 200:
        raise SourceError(f"geckoterminal ohlcv HTTP {r.status_code}: {r.text[:200]}")
    body = r.json(parse_float=Decimal) or {}
    meta = body.get("meta") or {}
    if (meta.get("base") or {}).get("address") != mint or (meta.get("quote") or {}).get("address") != cc.SOL_MINT:
        return {"none": "geckoterminal candle currency is not SOL per token for this mint"}
    rows = ((body.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
    for ts, _o, _hi, _lo, close, vol in sorted(rows, key=lambda x: int(x[0])):
        ts = int(ts)
        if ts < start or ts + 60 > end:  # before the horizon, or a candle still forming
            continue
        if Decimal(str(vol)) > 0 and Decimal(str(close)) > 0:
            return {"price": Decimal(str(close)), "observed_at": datetime.fromtimestamp(ts, timezone.utc),
                    "source": "geckoterminal_ohlcv_1m",
                    "meta": {"pool": pool["pool"], "dex": pool["dex"], "pool_name": pool.get("name"),
                             "pool_reserve_usd": str(pool["reserve_usd"]), "candle_start": ts,
                             "candle_end": ts + 60, "field": "close", "volume_sol": str(vol),
                             "note": "price = close of the first traded 1m candle starting at/after the horizon"}}
    return {"none": f"no trade in the SOL pool {pool['pool']} between the horizon and "
                    f"{datetime.fromtimestamp(end, timezone.utc).isoformat()}",
            "retry": end < start + WINDOW_MINUTES * 60}


def price_pass(p: dict, jup_key: str | None, now: datetime) -> dict:
    """Pick the earliest real observation at or after the horizon; report why when there is none."""
    mint = p["instrument"]
    horizon = cc.parse_ts(p["horizon_at"])
    found, empty, errors = [], [], []
    for name, fn in (("geckoterminal", lambda: gecko_first_trade(mint, horizon, now)),
                     ("jupiter", lambda: jupiter_price(mint, jup_key, now))):
        try:
            got = fn()
        except SourceError as e:
            errors.append(f"{name}: {e}")
            continue
        if "price" in got:
            found.append(got)
        else:
            empty.append((name, got))
    if found:
        best = min(found, key=lambda g: g["observed_at"])
        best["meta"] = {**best["meta"], "lag_seconds_after_horizon": int((best["observed_at"] - horizon).total_seconds()),
                        "writer": "pass_marks"}
        if errors:
            best["meta"]["source_errors"] = errors
        return {"action": "mark", **best}
    if errors or any(g.get("retry") for _, g in empty):
        return {"action": "retry", "errors": errors, "empty": {n: g["none"] for n, g in empty}}
    if now - horizon < NO_PRICE_GRACE:
        return {"action": "retry", "empty": {n: g["none"] for n, g in empty}, "why": "inside the 1h grace"}
    return {"action": "no_price", "reason": "; ".join(f"{n}: {g['none']}" for n, g in empty),
            "detail": {n: g["none"] for n, g in empty}}


def sweep(dry_run: bool = False, now: datetime | None = None, limit: int = 50) -> dict:
    from load_secrets import load_secrets
    jup_key = load_secrets().get("JUPITER_API_KEY")
    pending = cc.ledger("steward_pending_decision_marks", {"steward": cc.STEWARD, "limit": limit}, idempotent=True) or []
    out = {"pending": len(pending), "results": []}
    for p in pending:
        now_i = now or datetime.now(timezone.utc)
        res = {"decision_id": str(p["decision_id"]), "instrument": p["instrument"], "horizon_at": str(p["horizon_at"]),
               "book_price": str(p["book_price"])}
        try:
            got = price_pass(p, jup_key, now_i)
        except Exception as e:  # keep going: one bad mint never blocks the rest
            out["results"].append({**res, "action": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"})
            continue
        res["action"] = got["action"]
        if got["action"] == "mark":
            args = {"steward": cc.STEWARD, "kind": "horizon", "decision_id": str(p["decision_id"]),
                    "price": str(got["price"]), "observed_at": got["observed_at"].isoformat(),
                    "source": got["source"], "meta": got["meta"]}
            res.update({"price_sol": str(got["price"]), "observed_at": got["observed_at"].isoformat(),
                        "source": got["source"]})
        elif got["action"] == "no_price":
            args = {"steward": cc.STEWARD, "kind": "horizon", "decision_id": str(p["decision_id"]),
                    "no_price_reason": got["reason"], "meta": got["detail"]}
            res["reason"] = got["reason"]
        else:
            res.update({k: v for k, v in got.items() if k != "action"})
            out["results"].append(res)
            continue
        if dry_run:
            res["would_write"] = {"fn": "steward_record_decision_mark", "args": args}
        else:
            try:
                w = cc.ledger("steward_record_decision_mark", args)
                res.update({"counterfactual_pnl": w.get("counterfactual_pnl"), "resolve_status": w.get("resolve_status"),
                            "replayed": w.get("replayed")})
            except Exception as e:
                res.update({"action": "error", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        out["results"].append(res)
    return out


def sweep_quietly() -> dict:
    """For the scheduled scripts: never raises, never changes their exit code."""
    if os.environ.get("BANDIT_PASS_MARKS", "1").strip() in ("0", "false", "no", "off"):
        return {"skipped": "BANDIT_PASS_MARKS=0"}
    try:
        return sweep()
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:300]}"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pass_marks.py", description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="fetch prices and print; no ledger write")
    ap.add_argument("--limit", type=int, default=50)
    a = ap.parse_args(argv)
    cc.require_runtime(("requests",))
    out = sweep(dry_run=a.dry_run, limit=a.limit)
    print(cc.jdump(out))
    return 1 if any(r.get("action") == "error" for r in out["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
