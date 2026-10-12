#!/usr/bin/env python3
"""QUANTANAMO pass_marks: price the equity passes QUANTANAMO logged once their horizon is up.

Usage (from /workspace/quantanamo, after sync_box.sh on main):
  .venv/bin/python pass_marks.py            # mark every pass whose horizon has passed
  .venv/bin/python pass_marks.py --dry-run  # fetch and print; no ledger write

There is no QUANTANAMO scheduled Python entry in this repo. The bookmark scripts and the
Cloudflare research cron do not price passes. Run the command above after the Agentic
heartbeat / end of scan, once horizon_at has passed, or call sweep_quietly() from that
path. QUANTANAMO_PASS_MARKS=0 turns the sweep off.

Why: a pass is a ticker QUANTANAMO did not buy, so portfolio_exposure and broker_fills never
price it, and the resolver leaves the row at resolve_status = no_mark_yet.

Source: Financial Datasets (https://api.financialdatasets.ai), the same provider the knowledge
worker calls (workers/knowledge/src/financial.ts). Key: FINANCIAL_DATASETS_API_KEY (env, else
the steward secrets file). Header X-API-KEY. Nothing from the key is printed.

For each pass from public.steward_pending_decision_marks (steward=quantanamo; scoreable,
horizon passed, no mark yet):
  1. GET /prices?interval=day from the horizon's session date through today. The mark is the
     close of the first bar whose NYSE session close is at or after horizon_at. The bar's
     time field is only the session date; observed_at is that session's close (16:00
     America/New_York, 13:00 on an early close in the NYSE calendar below). A zero-volume
     bar is not a trade. The open is never the mark. A pre-horizon close is not carried forward.
  2. A horizon mark is insert-once, so a live GET /prices/snapshot quote is used only after
     the daily source has affirmatively returned no traded close and the horizon is older
     than NO_PRICE_GRACE (18h). The snapshot's own timestamp must be at or after the horizon
     and not in the future (the database refuses anything else).
  3. public.steward_record_decision_mark writes it (kind=horizon). The database recomputes
     horizon_at and the resolver scores the pass: one share, USD.
  4. If both sources affirmatively have no price and the horizon is past the grace window,
     no_price_reason flags the pass unscoreable. A network error, a missing key, or an HTTP
     5xx/429 is never a reason: the pass is retried next run.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

STEWARD = "quantanamo"
PRICES = "https://api.financialdatasets.ai/prices/"
SNAPSHOT = "https://api.financialdatasets.ai/prices/snapshot"
ET = ZoneInfo("America/New_York")
REGULAR_CLOSE = time(16, 0)
EARLY_CLOSE = time(13, 0)
FUTURE_SKEW = timedelta(minutes=2)  # decision_marks_guard allows observed_at up to now + 2 minutes
NO_PRICE_GRACE = timedelta(hours=18)  # EOD bars publish after the close; do not lock a later quote first
TIMEOUT = 20
PAGE_CAP = 5
DEFAULT_SECRETS_FILE = "/home/box/sand-data/box-secrets.json"

# Mirrors public.us_equity_market_calendar (supabase/schemas/29_us_market_calendar.sql)
# and NYSE_CALENDAR in packages/contracts/src/market-calendar.ts. Absent days are a regular
# 16:00 close. Weekends have no session. test_steward_scripts compares this to the SQL.
NYSE_CALENDAR: dict[str, str] = {
    "2026-01-01": "holiday",
    "2026-01-19": "holiday",
    "2026-02-16": "holiday",
    "2026-04-03": "holiday",
    "2026-05-25": "holiday",
    "2026-06-19": "holiday",
    "2026-07-03": "holiday",
    "2026-09-07": "holiday",
    "2026-11-26": "holiday",
    "2026-11-27": "early_close",
    "2026-12-24": "early_close",
    "2026-12-25": "holiday",
    "2027-01-01": "holiday",
    "2027-01-18": "holiday",
    "2027-02-15": "holiday",
    "2027-03-26": "holiday",
    "2027-05-31": "holiday",
    "2027-06-18": "holiday",
    "2027-07-05": "holiday",
    "2027-09-06": "holiday",
    "2027-11-25": "holiday",
    "2027-11-26": "early_close",
    "2027-12-24": "holiday",
    "2028-01-17": "holiday",
    "2028-02-21": "holiday",
    "2028-04-14": "holiday",
    "2028-05-29": "holiday",
    "2028-06-19": "holiday",
    "2028-07-03": "early_close",
    "2028-07-04": "holiday",
    "2028-09-04": "holiday",
    "2028-11-23": "holiday",
    "2028-11-24": "early_close",
    "2028-12-25": "holiday",
}


class SourceError(RuntimeError):
    """The source could not be read (network, HTTP 5xx/429, auth). Not evidence that there is no price."""


def require_runtime(modules: tuple[str, ...]) -> None:
    """Fail fast, before any vendor or ledger call, when the steward venv is missing or broken."""
    broken = []
    for module in modules:
        try:
            __import__(module)
        except Exception as exc:  # ImportError, or a broken binary wheel
            broken.append(f"{module} ({type(exc).__name__})")
    if broken:
        repo = os.environ.get("GRASSHOPPER_REPO") or os.path.join(os.sep, "workspace", "grasshopper")
        sys.stderr.write(
            f"{STEWARD}: Python env not ready: {', '.join(broken)} (interpreter {sys.executable}).\n"
            f"Nothing was sent. Run:  bash {os.path.join(repo, 'stewards', 'sync_box.sh')}\n"
            f"then retry with {os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), '.venv', 'bin', 'python')}.\n"
        )
        raise SystemExit(3)


def jdump(o) -> str:
    return json.dumps(o, default=lambda x: str(x) if isinstance(x, (Decimal, datetime)) else repr(x))


def parse_ts(v) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v if v is None or v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def session_close_at(day: date) -> datetime | None:
    """NYSE core-session close of day, or None on a weekend or holiday. Not a price."""
    if day.weekday() >= 5:
        return None
    kind = NYSE_CALENDAR.get(day.isoformat())
    if kind == "holiday":
        return None
    close = EARLY_CLOSE if kind == "early_close" else REGULAR_CLOSE
    return datetime.combine(day, close, tzinfo=ET)


def _api_key() -> str | None:
    found = os.environ.get("FINANCIAL_DATASETS_API_KEY")
    if found and found.strip():
        return found.strip()
    path = Path(os.environ.get("STEWARD_SECRETS_FILE") or DEFAULT_SECRETS_FILE)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    inner = data.get("secrets", data)
    if not isinstance(inner, dict) or not inner.get("FINANCIAL_DATASETS_API_KEY"):
        return None
    return str(inner["FINANCIAL_DATASETS_API_KEY"]).strip() or None


def _get(url: str, *, params=None, headers=None):
    import requests
    try:
        r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
    except Exception as e:  # requests.RequestException and friends
        raise SourceError(f"{type(e).__name__}: {str(e)[:200]}") from None
    return r


def _headers(api_key: str) -> dict:
    return {"X-API-KEY": api_key, "accept": "application/json", "user-agent": "grasshopper-quantanamo/pass_marks"}


def _status_error(name: str, status: int, text: str) -> None:
    if status in (429, 500, 502, 503, 504) or status in (401, 402, 400) or status >= 500:
        raise SourceError(f"{name} HTTP {status}: {text[:200]}")


def _bar_day(bar: dict) -> date | None:
    raw = str(bar.get("time") or "")[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def select_daily_mark(bars: list, horizon: datetime, now: datetime, ticker: str | None = None) -> dict:
    """Earliest real daily close at or after the horizon. Zero-volume bars are not trades."""
    found = []
    skipped_zero = 0
    want = ticker.upper() if ticker else None
    for bar in bars:
        if not isinstance(bar, dict):
            continue
        bar_ticker = str(bar.get("ticker") or "").upper()
        if want and bar_ticker and bar_ticker != want:
            continue
        day = _bar_day(bar)
        if day is None:
            continue
        observed = session_close_at(day)
        if observed is None or observed < horizon or observed > now + FUTURE_SKEW:
            continue
        vol = bar.get("volume")
        if vol is not None and Decimal(str(vol)) <= 0:
            skipped_zero += 1
            continue
        px = bar.get("close")
        if px is None:
            continue
        price = Decimal(str(px))
        if price <= 0:
            continue
        found.append({
            "price": price,
            "observed_at": observed,
            "source": "financialdatasets_prices_day",
            "meta": {
                "bar": "day",
                "bar_date": day.isoformat(),
                "field": "close",
                "volume": None if vol is None else str(vol),
                "session_close": iso_z(observed),
                "provider": "financialdatasets.ai",
                "endpoint": "/prices",
                "interval": "day",
                "writer": "pass_marks",
                "method": "close of the first daily bar whose NYSE session close is at or after the horizon",
            },
        })
    if found:
        return min(found, key=lambda g: g["observed_at"])
    reason = "financial datasets returned no traded daily close at or after the horizon"
    if skipped_zero:
        reason += f" ({skipped_zero} zero-volume bar(s) skipped)"
    return {"none": reason}


def _prices_of(body) -> list:
    if isinstance(body, list):
        return body
    if isinstance(body, dict) and isinstance(body.get("prices"), list):
        return body["prices"]
    raise SourceError("financial datasets prices response has no prices array")


def load_daily(ticker: str, horizon: datetime, now: datetime, api_key: str) -> dict:
    """Daily closes from Financial Datasets, or {'none': reason}. Raises SourceError on a transport failure."""
    start = horizon.astimezone(ET).date().isoformat()
    end = now.astimezone(ET).date().isoformat()
    url, params = PRICES, {"ticker": ticker, "interval": "day", "start_date": start, "end_date": end}
    bars: list = []
    headers = _headers(api_key)
    for _ in range(PAGE_CAP):
        r = _get(url, params=params, headers=headers)
        if r.status_code == 404:
            return {"none": f"financial datasets does not list {ticker}"}
        if r.status_code != 200:
            _status_error("financial datasets prices", r.status_code, r.text)
            raise SourceError(f"financial datasets prices HTTP {r.status_code}: {r.text[:200]}")
        body = r.json(parse_float=Decimal) or {}
        bars.extend(_prices_of(body))
        nxt = body.get("next_page_url") if isinstance(body, dict) else None
        if not nxt:
            return select_daily_mark(bars, horizon, now, ticker)
        nxt = str(nxt)
        if not nxt.startswith("https://api.financialdatasets.ai/"):
            raise SourceError("financial datasets next_page_url is not on api.financialdatasets.ai")
        url, params = nxt, None
    raise SourceError("financial datasets prices still had another page after the page cap")


def _snapshot_time(snap: dict) -> datetime | None:
    ms = snap.get("time_milliseconds")
    if ms is not None and str(ms).strip() != "":
        try:
            return datetime.fromtimestamp(float(Decimal(str(ms)) / 1000), timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    raw = str(snap.get("time") or "")
    if len(raw) < 16:  # a date alone is not an observation instant
        return None
    return parse_ts(raw)


def snapshot_mark(snap: dict | None, horizon: datetime, now: datetime) -> dict:
    """A live quote, only when its own timestamp is at or after the horizon. Raises nothing."""
    if not isinstance(snap, dict):
        return {"none": "financial datasets snapshot has no price"}
    px = snap.get("price")
    if px is None or Decimal(str(px)) <= 0:
        return {"none": "financial datasets snapshot has no price"}
    observed = _snapshot_time(snap)
    if observed is None:
        return {"none": "financial datasets snapshot has no observation time", "retry": True}
    if observed < horizon:
        return {"none": "financial datasets snapshot is before the horizon", "retry": True}
    if observed > now + FUTURE_SKEW:
        return {"none": "financial datasets snapshot time is in the future", "retry": True}
    return {
        "price": Decimal(str(px)),
        "observed_at": observed,
        "source": "financialdatasets_prices_snapshot",
        "meta": {
            "field": "price",
            "snapshot_time": iso_z(observed),
            "provider": "financialdatasets.ai",
            "endpoint": "/prices/snapshot",
            "writer": "pass_marks",
            "method": "live snapshot whose timestamp is at or after the horizon",
        },
    }


def load_snapshot(ticker: str, horizon: datetime, now: datetime, api_key: str) -> dict:
    r = _get(SNAPSHOT, params={"ticker": ticker}, headers=_headers(api_key))
    if r.status_code == 404:
        return {"none": f"financial datasets snapshot does not list {ticker}"}
    if r.status_code != 200:
        _status_error("financial datasets snapshot", r.status_code, r.text)
        raise SourceError(f"financial datasets snapshot HTTP {r.status_code}: {r.text[:200]}")
    body = r.json(parse_float=Decimal) or {}
    snap = body.get("snapshot") if isinstance(body, dict) else None
    return snapshot_mark(snap if isinstance(snap, dict) else body if isinstance(body, dict) else None, horizon, now)


def price_pass(p: dict, api_key: str | None, now: datetime) -> dict:
    """Daily close when it is published; snapshot only after the grace; retry on transport errors."""
    ticker = str(p.get("instrument") or "").strip()
    horizon = parse_ts(p.get("horizon_at"))
    if not ticker or horizon is None:
        return {"action": "error", "error": "pending row missing instrument or horizon_at"}
    if not api_key:
        return {"action": "retry", "errors": ["financialdatasets: FINANCIAL_DATASETS_API_KEY not set"]}
    try:
        daily = load_daily(ticker, horizon, now, api_key)
    except SourceError as e:
        return {"action": "retry", "errors": [f"financialdatasets prices: {e}"]}
    if "price" in daily:
        daily["meta"] = {**daily["meta"], "lag_seconds_after_horizon": int((daily["observed_at"] - horizon).total_seconds())}
        return {"action": "mark", **daily}
    if now - horizon < NO_PRICE_GRACE:
        return {"action": "retry", "empty": {"financialdatasets_prices_day": daily["none"]}, "why": "inside the 18h grace"}
    try:
        snap = load_snapshot(ticker, horizon, now, api_key)
    except SourceError as e:
        return {"action": "retry", "errors": [f"financialdatasets snapshot: {e}"],
                "empty": {"financialdatasets_prices_day": daily["none"]}}
    if "price" in snap:
        snap["meta"] = {**snap["meta"], "daily": daily["none"],
                        "lag_seconds_after_horizon": int((snap["observed_at"] - horizon).total_seconds())}
        return {"action": "mark", **snap}
    if snap.get("retry"):
        return {"action": "retry", "empty": {"financialdatasets_prices_day": daily["none"],
                                              "financialdatasets_prices_snapshot": snap["none"]}}
    return {"action": "no_price",
            "reason": f"financialdatasets prices: {daily['none']}; financialdatasets snapshot: {snap['none']}",
            "detail": {"financialdatasets_prices_day": daily["none"], "financialdatasets_prices_snapshot": snap["none"]}}


def record_args(decision_id: str, got: dict) -> dict:
    if got["action"] == "mark":
        return {"steward": STEWARD, "kind": "horizon", "decision_id": decision_id,
                "price": str(got["price"]), "observed_at": iso_z(got["observed_at"]),
                "source": got["source"], "meta": got["meta"]}
    if got["action"] == "no_price":
        return {"steward": STEWARD, "kind": "horizon", "decision_id": decision_id,
                "no_price_reason": got["reason"], "meta": got["detail"]}
    raise ValueError(got["action"])


def sweep(dry_run: bool = False, now: datetime | None = None, limit: int = 50) -> dict:
    from steward_rpc import call
    key = _api_key()
    pending = call(STEWARD, "steward_pending_decision_marks", {"steward": STEWARD, "limit": limit}, idempotent=True) or []
    out = {"pending": len(pending), "results": []}
    for p in pending:
        now_i = now or datetime.now(timezone.utc)
        res = {"decision_id": str(p["decision_id"]), "instrument": p.get("instrument"),
               "horizon_at": str(p.get("horizon_at")), "book_price": str(p.get("book_price"))}
        try:
            got = price_pass(p, key, now_i)
        except Exception as e:  # one bad ticker never blocks the rest
            out["results"].append({**res, "action": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"})
            continue
        res["action"] = got["action"]
        if got["action"] in ("mark", "no_price"):
            args = record_args(str(p["decision_id"]), got)
            if got["action"] == "mark":
                res.update({"price_usd": str(got["price"]), "observed_at": iso_z(got["observed_at"]),
                            "source": got["source"]})
            else:
                res["reason"] = got["reason"]
        else:
            res.update({k: v for k, v in got.items() if k != "action"})
            out["results"].append(res)
            continue
        if dry_run:
            res["would_write"] = {"fn": "steward_record_decision_mark", "args": args}
        else:
            try:
                w = call(STEWARD, "steward_record_decision_mark", args)
                res.update({"counterfactual_pnl": None if not isinstance(w, dict) else w.get("counterfactual_pnl"),
                            "resolve_status": None if not isinstance(w, dict) else w.get("resolve_status"),
                            "replayed": None if not isinstance(w, dict) else w.get("replayed")})
            except Exception as e:
                res.update({"action": "error", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        out["results"].append(res)
    return out


def sweep_quietly() -> dict:
    """For a scheduled caller: never raises, never changes the caller's exit code."""
    if os.environ.get("QUANTANAMO_PASS_MARKS", "1").strip() in ("0", "false", "no", "off"):
        return {"skipped": "QUANTANAMO_PASS_MARKS=0"}
    try:
        return sweep()
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:300]}"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pass_marks.py", description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="fetch prices and print; no ledger write")
    ap.add_argument("--limit", type=int, default=50)
    a = ap.parse_args(argv)
    require_runtime(("requests",))
    out = sweep(dry_run=a.dry_run, limit=a.limit)
    print(jdump(out))
    return 1 if any(r.get("action") == "error" for r in out["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
