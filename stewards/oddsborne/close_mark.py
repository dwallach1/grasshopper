#!/usr/bin/env python3
"""Record closing-mid (kind="close") marks for logged sports passes.
Usage: .venv/bin/python close_mark.py DECISION_ID:SLUG:SIDE:EVENT_START_ISO [...] [--dry-run]
SIDE is yes|no. NO mid = 1 - YES mid. Skips (no write) if the venue mid is missing or the event already started.
Never invents a price: the mid comes from the live Polymarket US BBO only."""
import json, os, sys, time
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pm_enter import make_client
import steward_rpc as S


def _money(v):
    if isinstance(v, dict):
        v = v.get("value")
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def _bbo_sum(bbo):
    if not isinstance(bbo, dict):
        return {"error": "non-dict"}
    if bbo.get("error"):
        return bbo
    md = bbo.get("marketData") or bbo
    bid, ask = _money(md.get("bestBid")), _money(md.get("bestAsk"))
    mid = round((ask + bid) / 2.0, 4) if bid is not None and ask is not None else None
    return {"bid": bid, "ask": ask, "mid": mid, "last": _money(md.get("lastTradePx"))}


def bbo_with_retry(c, slug, tries=4):
    """Live Polymarket US BBO with backoff; treats Cloudflare/HTML bodies as a flake. Never fabricates a quote."""
    last = None
    for i in range(tries):
        try:
            b = c.markets.bbo(slug)
            raw = json.dumps(b, default=str)[:200].lower()
            if "cloudflare" in raw or "<html" in raw:
                raise RuntimeError("cloudflare/html flake")
            return b, _bbo_sum(b), i
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:120]}"
            time.sleep(0.4 * (2 ** i))
    return {"error": last}, {"error": last}, tries


DRY = "--dry-run" in sys.argv
c = make_client(); out = []
for spec in [a for a in sys.argv[1:] if not a.startswith("--")]:
    did, slug, side, start = spec.split(":", 3)
    now = datetime.now(timezone.utc)
    r = {"decision_id": did, "slug": slug, "side": side, "event_start_at": start, "observed_at": now.isoformat()}
    if now >= datetime.fromisoformat(start.replace("Z", "+00:00")):
        r["result"] = "skip_event_started"; out.append(r); continue
    _, sb, _ = bbo_with_retry(c, slug, tries=4)
    bid, ask, mid = sb.get("bid"), sb.get("ask"), sb.get("mid")
    if mid is None and bid is not None and ask is not None:
        mid = (bid + ask) / 2
    r["yes_bbo"] = {"bid": bid, "ask": ask, "mid": mid, "last": sb.get("last")}
    if mid is None:
        r["result"] = "skip_no_mid"; out.append(r); continue
    px = round(mid if side == "yes" else 1 - mid, 6)
    mins = round((datetime.fromisoformat(start.replace("Z", "+00:00")) - now).total_seconds() / 60)
    r["minutes_before_start"] = mins
    r["mark_price"] = px
    if DRY:
        r["result"] = "dry_run"
    else:
        try:
            r["rpc"] = S.record_decision_mark("oddsborne", decision_id=did, price=px, observed_at=now.isoformat(),
                                              source="polymarket_us_bbo_mid", kind="close", event_start_at=start,
                                              meta={"slug": slug, "side": side, "yes_bbo": r["yes_bbo"],
                                                    "minutes_before_start": mins, "provisional": mins > 60})
            r["result"] = "recorded"
        except Exception as e:
            r["result"] = f"error: {type(e).__name__}: {str(e)[:200]}"
    out.append(r)
print(json.dumps(out, indent=1, default=str))
