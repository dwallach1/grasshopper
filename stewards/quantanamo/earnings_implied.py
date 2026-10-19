#!/usr/bin/env python3
"""QUANTANAMO earnings implied move: the straddle a held equity can gap on the print.

Usage (from /workspace/quantanamo, after sync_box.sh):
  .venv/bin/python earnings_implied.py --payloads observations.json --dry-run
  .venv/bin/python earnings_implied.py --payloads observations.json

There is no Robinhood HTTP client in this process. The steward fetches the payloads
with the Robinhood tools and passes them in (a JSON object keyed by symbol, or the
fetch= callable). This file only reads those payloads. It never invents a price.

Tools, per open lot:
  get_earnings_results (or get_earnings_calendar)  report date, am/pm, actual EPS
  get_option_chains                                expiration_dates
  get_equity_quotes                                underlying last trade
  get_option_instruments                           contracts at the chosen expiry
  get_option_quotes                                mark_price of the ATM call and put

Rule (GRASSHOPPER 2026-10-19; the SQL copy is private.equity_lot_open_risk):
  Until the report is out, open risk = max(line distance, implied-move risk).
  Implied-move risk = (ATM straddle / underlying) x position market value.
  The expiry is the nearest listed expiration on or after the report date.
  A monthly expiry weeks later (EFX, ROL) is stored as listed. No correction.
  After the report, the line only. Missing option data: the line, and
  missing_reason implied_move_missing.

A transport failure is not "no quote": the lot is left for the next run.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from zoneinfo import ZoneInfo

STEWARD = "quantanamo"
FLAG = "implied_move_missing"
SOURCE_PRICED = "robinhood_option_mark"
SOURCE_EARNINGS = "robinhood_earnings"
ET = ZoneInfo("America/New_York")
SIX = Decimal("0.000001")


class SourceError(RuntimeError):
    """The Robinhood read failed. Not evidence that the chain has no quote."""


def _positive(value) -> Decimal | None:
    """A real positive price. Zero, blank, and garbage are not prices."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if number <= 0:
        return None
    return number


def _parse_date(value) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    raw = str(value or "")[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _parse_ts(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    raw = str(value or "").strip()
    if len(raw) < 16:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _data(payload) -> dict | None:
    if not isinstance(payload, dict):
        return None
    inner = payload.get("data")
    if isinstance(inner, dict):
        return inner
    if "results" in payload or "chains" in payload:
        return payload
    return None


def _q6(number: Decimal) -> Decimal:
    return number.quantize(SIX, rounding=ROUND_HALF_UP)


def release_at(report_date: date, timing: str | None) -> datetime:
    """When the print counts as out. am: 09:30 ET. pm: 20:00 ET. No timing: next midnight ET."""
    if timing == "am":
        return datetime.combine(report_date, time(9, 30), tzinfo=ET)
    if timing == "pm":
        return datetime.combine(report_date, time(20, 0), tzinfo=ET)
    return datetime.combine(report_date + timedelta(days=1), time(0, 0), tzinfo=ET)


def report_passed(report_date: date | None, timing: str | None, reported: bool, now: datetime) -> bool:
    """True once the source has an actual EPS, or the release clock has passed."""
    if reported:
        return True
    if report_date is None or now is None:
        return False
    return now >= release_at(report_date, timing)


def line_risk(quantity: Decimal, mark: Decimal | None, invalidation: Decimal | None) -> Decimal:
    """qty x max(mark - invalidation, 0). No invalidation: qty x mark. Unmarked: 0."""
    if mark is None or quantity is None:
        return Decimal(0)
    if invalidation is None:
        return quantity * mark
    gap = mark - invalidation
    if gap < 0:
        gap = Decimal(0)
    return quantity * gap


def equity_open_risk(
    *,
    quantity: Decimal,
    mark: Decimal | None,
    invalidation: Decimal | None,
    report_date: date | None,
    report_timing: str | None,
    reported: bool,
    straddle: Decimal | None,
    underlying: Decimal | None,
    expiry: date | None,
    has_observation: bool,
    missing_reason: str | None,
    now: datetime,
) -> dict:
    """Same rule as private.equity_lot_open_risk. Prices in, risk out. Never fills a missing price."""
    line = line_risk(quantity, mark, invalidation)
    passed = report_date is not None and report_passed(report_date, report_timing, reported, now)
    pending = report_date is not None and not passed
    priced = (
        straddle is not None and straddle > 0
        and underlying is not None and underlying > 0
        and expiry is not None and mark is not None and quantity is not None
    )
    implied = (straddle / underlying) * (quantity * mark) if pending and priced else None
    if passed:
        flag = None
    elif has_observation and report_date is None and missing_reason is None:
        flag = None
    elif implied is not None:
        flag = None
    else:
        flag = FLAG
    risk = line if implied is None else max(line, implied)
    return {
        "line_risk": _q6(line),
        "implied_move": None if implied is None else _q6(implied),
        "risk": _q6(risk),
        "risk_flag": flag,
    }


def earnings_rows(payload, symbol: str) -> list | None:
    """Rows for this symbol, or None when the payload cannot be read. [] means the symbol is absent."""
    data = _data(payload)
    if data is None or not isinstance(data.get("results"), list):
        return None
    want = symbol.upper()
    missing = {str(item).upper() for item in (data.get("not_found") or [])}
    if want in missing:
        return []
    rows = []
    for row in data["results"]:
        if not isinstance(row, dict) or str(row.get("symbol") or "").upper() != want:
            continue
        report = row.get("report") if isinstance(row.get("report"), dict) else {}
        eps = row.get("eps") if isinstance(row.get("eps"), dict) else {}
        day = _parse_date(report.get("date"))
        if day is None:
            continue
        timing = report.get("timing")
        if timing not in ("am", "pm"):
            timing = None
        actual = eps.get("actual") if isinstance(eps, dict) else None
        reported = actual is not None and str(actual).strip() != ""
        rows.append({"report_date": day, "report_timing": timing, "reported": reported})
    return rows


def classify_report(rows: list | None, now: datetime) -> dict:
    """pending, passed, or missing. A calendar that does not mention the symbol is missing, not 'no earnings'."""
    if rows is None:
        return {"status": "missing", "why": "earnings payload unreadable"}
    if not rows:
        return {"status": "missing", "why": "no earnings row for the symbol"}
    pending = [
        row for row in rows
        if not row["reported"] and not report_passed(row["report_date"], row["report_timing"], False, now)
    ]
    if pending:
        chosen = min(pending, key=lambda row: release_at(row["report_date"], row["report_timing"]))
        return {"status": "pending", **chosen}
    latest = max(rows, key=lambda row: (row["report_date"], row["report_timing"] or ""))
    return {
        "status": "passed",
        "report_date": latest["report_date"],
        "report_timing": latest["report_timing"],
        "reported": latest["reported"] or report_passed(latest["report_date"], latest["report_timing"], False, now),
    }


def expiration_dates(payload) -> list[date] | None:
    data = _data(payload)
    if data is None or not isinstance(data.get("chains"), list):
        return None
    found = []
    for chain in data["chains"]:
        if not isinstance(chain, dict):
            continue
        for raw in chain.get("expiration_dates") or []:
            day = _parse_date(raw)
            if day is not None:
                found.append(day)
    return found


def select_expiry(dates: list[date] | None, report_date: date | None) -> date | None:
    """Nearest listed expiry on or after the report. No weekly adjustment."""
    if not dates or report_date is None:
        return None
    later = [day for day in dates if day >= report_date]
    return min(later) if later else None


def underlying_price(payload) -> tuple[Decimal, datetime] | None:
    """The later of the last regular and last extended trade. No previous close, no bid/ask mid."""
    data = _data(payload)
    if data is None or not isinstance(data.get("results"), list) or not data["results"]:
        return None
    first = data["results"][0]
    quote = first.get("quote") if isinstance(first, dict) else None
    if not isinstance(quote, dict):
        return None
    if quote.get("has_traded") is False or (quote.get("state") not in (None, "active")):
        return None
    found = []
    for price_key, time_key in (
        ("last_trade_price", "venue_last_trade_time"),
        ("last_non_reg_trade_price", "venue_last_non_reg_trade_time"),
    ):
        px = _positive(quote.get(price_key))
        observed = _parse_ts(quote.get(time_key))
        if px is not None and observed is not None:
            found.append((observed, px))
    if not found:
        return None
    found.sort()
    observed, px = found[-1]
    return px, observed


def _quote_marks(payload) -> dict[str, tuple[Decimal, datetime | None]]:
    data = _data(payload)
    if data is None or not isinstance(data.get("results"), list):
        return {}
    marks = {}
    for item in data["results"]:
        quote = item.get("quote") if isinstance(item, dict) else None
        if not isinstance(quote, dict):
            continue
        px = _positive(quote.get("mark_price"))
        iid = str(quote.get("instrument_id") or "")
        if px is None or not iid:
            continue
        marks[iid] = (px, _parse_ts(quote.get("updated_at")))
    return marks


def select_atm_straddle(instruments, quotes, underlying: Decimal, expiry: date) -> dict | None:
    """ATM call mark + put mark at expiry. mark_price only. A missing leg is not filled from bid/ask."""
    marks = _quote_marks(quotes)
    if not isinstance(instruments, list):
        data = _data(instruments)
        instruments = data.get("instruments") if isinstance(data, dict) else None
    if not isinstance(instruments, list):
        return None
    want = expiry.isoformat()
    by_strike: dict[Decimal, dict] = {}
    for inst in instruments:
        if not isinstance(inst, dict):
            continue
        if str(inst.get("expiration_date") or "")[:10] != want:
            continue
        if inst.get("state") not in (None, "active"):
            continue
        if inst.get("tradability") not in (None, "tradable"):
            continue
        side = inst.get("type")
        if side not in ("call", "put"):
            continue
        strike = _positive(inst.get("strike_price"))
        iid = str(inst.get("id") or "")
        marked = marks.get(iid)
        if strike is None or marked is None:
            continue
        slot = by_strike.setdefault(strike, {})
        if side in slot:
            slot[side] = None  # two contracts on one side: do not pick one
            continue
        slot[side] = {"price": marked[0], "id": iid, "at": marked[1]}
    candidates = []
    for strike, slot in by_strike.items():
        call, put = slot.get("call"), slot.get("put")
        if not call or not put:
            continue
        candidates.append((abs(strike - underlying), strike, call, put))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    _, strike, call, put = candidates[0]
    return {
        "strike": strike,
        "call_price": call["price"],
        "put_price": put["price"],
        "straddle_price": call["price"] + put["price"],
        "call_id": call["id"],
        "put_id": put["id"],
        "expiry": expiry,
        "call_at": call["at"],
        "put_at": put["at"],
    }


def _base(report: dict, *, source: str, missing: str | None, why: str | None, extra: dict | None = None) -> dict:
    meta = {"writer": "earnings_implied", "why": why}
    if extra:
        meta.update(extra)
    out = {
        "report_date": report.get("report_date"),
        "report_timing": report.get("report_timing"),
        "reported": bool(report.get("reported")),
        "source": source,
        "missing_reason": missing,
        "meta": {k: v for k, v in meta.items() if v is not None},
    }
    return out


def build_observation(symbol: str, payloads: dict, now: datetime) -> dict:
    """Turn Robinhood payloads into one ledger observation. Missing quotes stay missing."""
    if not isinstance(payloads, dict):
        return _base({}, source=SOURCE_EARNINGS, missing=FLAG, why="payloads are not an object")
    report = classify_report(earnings_rows(payloads.get("earnings"), symbol), now)
    if report["status"] == "missing":
        return _base({}, source=SOURCE_EARNINGS, missing=FLAG, why=report["why"])
    if report["status"] == "passed":
        return _base(report, source=SOURCE_EARNINGS, missing=None, why="report has passed")
    dates = expiration_dates(payloads.get("chains"))
    expiry = select_expiry(dates, report["report_date"])
    if dates is None or expiry is None:
        why = "option chain unreadable" if dates is None else "no listed expiry on or after the report"
        return _base(report, source=SOURCE_EARNINGS, missing=FLAG, why=why)
    spot = underlying_price(payloads.get("equity_quote"))
    if spot is None:
        return _base(report, source=SOURCE_EARNINGS, missing=FLAG, why="no underlying last trade",
                     extra={"expiry_date": expiry.isoformat()})
    und, und_at = spot
    legs = select_atm_straddle(payloads.get("instruments"), payloads.get("quotes"), und, expiry)
    if legs is None:
        return _base(report, source=SOURCE_EARNINGS, missing=FLAG, why="no ATM call and put marks",
                     extra={"expiry_date": expiry.isoformat(), "underlying_price": str(und)})
    times = [t for t in (und_at, legs["call_at"], legs["put_at"]) if t is not None]
    return {
        **_base(report, source=SOURCE_PRICED, missing=None, why="ATM straddle at the nearest listed expiry"),
        "straddle_price": legs["straddle_price"],
        "underlying_price": und,
        "call_price": legs["call_price"],
        "put_price": legs["put_price"],
        "expiry_date": expiry,
        "strike": legs["strike"],
        "observed_at": min(times) if times else now,
        "meta": {
            "writer": "earnings_implied",
            "why": "ATM straddle at the nearest listed expiry",
            "expiry_date": expiry.isoformat(),
            "strike": str(legs["strike"]),
            "call_id": legs["call_id"],
            "put_id": legs["put_id"],
            "call_mark": str(legs["call_price"]),
            "put_mark": str(legs["put_price"]),
            "underlying": str(und),
            "method": "nearest expiry on or after the report; lowest strike nearest the last trade; mark_price call + put",
        },
    }


def record_args(lot_id: str, symbol: str, observation: dict, now: datetime) -> dict:
    """RPC args. A missing straddle sends no prices."""
    args = {
        "steward": STEWARD,
        "lot_id": lot_id,
        "symbol": symbol,
        "observed_at": observation.get("observed_at") or now,
        "source": observation.get("source") or SOURCE_EARNINGS,
        "reported": bool(observation.get("reported")),
        "meta": observation.get("meta") or {},
    }
    if observation.get("report_date") is not None:
        args["report_date"] = observation["report_date"]
    if observation.get("report_timing") in ("am", "pm"):
        args["report_timing"] = observation["report_timing"]
    if observation.get("missing_reason"):
        args["missing_reason"] = observation["missing_reason"]
        return args
    for key in ("straddle_price", "underlying_price", "call_price", "put_price", "expiry_date", "strike"):
        if observation.get(key) is not None:
            args[key] = observation[key]
    return args


def sweep(fetch, dry_run: bool = False, now: datetime | None = None) -> dict:
    """fetch(symbol) -> payloads, or raises SourceError. One bad symbol does not stop the rest."""
    from steward_rpc import call
    lots = call(STEWARD, "steward_open_equity_lots", {"steward": STEWARD}, idempotent=True) or []
    out = {"lots": len(lots), "results": []}
    for lot in lots:
        symbol = str(lot.get("symbol") or "").upper()
        row = {"lot_id": str(lot.get("lot_id")), "symbol": symbol}
        now_i = now or datetime.now(timezone.utc)
        try:
            payloads = fetch(symbol)
            got = build_observation(symbol, payloads, now_i)
        except SourceError as exc:
            out["results"].append({**row, "action": "retry", "error": str(exc)[:200]})
            continue
        except Exception as exc:  # one bad payload never blocks the rest
            out["results"].append({**row, "action": "error", "error": f"{type(exc).__name__}: {str(exc)[:200]}"})
            continue
        args = record_args(str(lot.get("lot_id")), symbol, got, now_i)
        row["action"] = FLAG if args.get("missing_reason") else ("passed" if got.get("reported") or got.get("meta", {}).get("why") == "report has passed" else "straddle")
        if got.get("expiry_date") is not None:
            row["expiry_date"] = got["expiry_date"].isoformat()
        if args.get("missing_reason"):
            row["missing_reason"] = args["missing_reason"]
        if dry_run:
            row["would_write"] = {"fn": "steward_record_equity_implied_move", "args": args}
        else:
            try:
                wrote = call(STEWARD, "steward_record_equity_implied_move", args)
                if isinstance(wrote, dict):
                    row["expiry_date"] = wrote.get("expiry_date") or row.get("expiry_date")
                    row["missing_reason"] = wrote.get("missing_reason")
            except Exception as exc:
                row.update({"action": "error", "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
        out["results"].append(row)
    return out


def sweep_quietly(fetch=None) -> dict:
    """For a scheduled caller. No fetch means nothing is written (a missing client is not a missing quote)."""
    if os.environ.get("QUANTANAMO_EARNINGS_IMPLIED", "1").strip() in ("0", "false", "no", "off"):
        return {"skipped": "QUANTANAMO_EARNINGS_IMPLIED=0"}
    if fetch is None:
        return {"skipped": "no Robinhood payload source"}
    try:
        return sweep(fetch)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {str(exc)[:300]}"}


def _load_payloads(path: str) -> dict:
    data = json.loads(open(path).read())
    if not isinstance(data, dict):
        raise SystemExit("payloads must be a JSON object keyed by symbol")
    return {str(k).upper(): v for k, v in data.items()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="earnings_implied.py", description=__doc__.split("\n")[0])
    ap.add_argument("--payloads", required=True, help="JSON object keyed by symbol of Robinhood tool payloads")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    book = _load_payloads(a.payloads)

    def fetch(symbol: str) -> dict:
        if symbol not in book:
            raise SourceError(f"no payloads for {symbol}")
        return book[symbol]

    out = sweep(fetch, dry_run=a.dry_run)
    print(json.dumps(out, default=str))
    return 1 if any(r.get("action") == "error" for r in out["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
