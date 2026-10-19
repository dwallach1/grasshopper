#!/usr/bin/env python3
"""QUANTANAMO earnings implied move: the straddle a held equity can gap on the print.

The sweep is two commands. Python does not call Robinhood. On the box, sync_box.sh
copies this file to /workspace/quantanamo/earnings_implied.py.

  python3 stewards/quantanamo/earnings_implied.py plan
  python3 stewards/quantanamo/earnings_implied.py write payload.json
  python3 stewards/quantanamo/earnings_implied.py write payload.json --execute

plan prints the open lots that lack a current implied-move row (no row, or a report
still ahead with no straddle and no implied_move_missing flag) and the Robinhood
calls. write reads the saved MCP responses and emits
select public.steward_record_equity_implied_move(...). --execute runs that call.
--dry-run prints the SQL only. A missing quote is stored as implied_move_missing.
This file never invents a price.

Tools, per open lot (plan names these; write accepts the raw responses):
  get_earnings_results     one symbol: report date, am/pm, actual EPS (upcoming quarter included)
  get_earnings_calendar    market window, 31 days; accepted if that is what was saved
  get_option_chains        expiration_dates          argument underlying_symbol
  get_equity_quotes        underlying last trade     argument symbols
  get_option_instruments   contracts at the expiry   arguments chain_symbol, expiration_dates, state
  get_option_quotes        mark_price of ATM call and put   argument instrument_ids

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


def _reported_flag(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("true", "t", "1")
    return bool(value)


def is_implied_move_gap(observation: dict | None, now: datetime) -> bool:
    """True when this open lot has no current implied-move row.

    Same predicate as public.equity_implied_move_is_gap. No row is a gap: the sweep
    never wrote, so a report still ahead would be silent. A row whose report is still
    ahead, with no straddle and no implied_move_missing flag, is a gap. A priced
    straddle, a passed report, a checked calendar with nothing pending, or a missing
    flag is current.
    """
    if observation is None:
        return True
    raw_date = observation.get("report_date")
    report_date = raw_date if isinstance(raw_date, date) and not isinstance(raw_date, datetime) else _parse_date(raw_date)
    if report_date is None:
        return False
    if _positive(observation.get("straddle_price")) is not None:
        return False
    if observation.get("missing_reason"):
        return False
    timing = str(observation.get("report_timing") or "").lower()
    if timing not in ("am", "pm"):
        timing = None
    return not report_passed(report_date, timing, _reported_flag(observation.get("reported")), now)


def _normalize_lots(lots) -> list[dict]:
    rows = []
    for lot in lots or []:
        if not isinstance(lot, dict):
            continue
        lot_id = str(lot.get("lot_id") or "").strip()
        symbol = str(lot.get("symbol") or "").upper().strip()
        if not lot_id or not symbol:
            continue
        row = {"lot_id": lot_id, "symbol": symbol}
        if lot.get("quantity") is not None:
            qty = lot["quantity"]
            row["quantity"] = format(qty, "f") if isinstance(qty, Decimal) else qty
        rows.append(row)
    rows.sort(key=lambda row: (row["symbol"], row["lot_id"]))
    return rows


def gap_lots(lots, observations: dict | None, now: datetime) -> list[dict]:
    """Lots is_implied_move_gap still wants. observations is keyed by lot_id."""
    observations = observations or {}
    return _normalize_lots([
        lot for lot in (lots or [])
        if isinstance(lot, dict) and is_implied_move_gap(observations.get(str(lot.get("lot_id") or "").strip()), now)
    ])


def plan_calls(lots) -> dict:
    """Exact Robinhood calls for these lots. `fill` is completed from the earlier response."""
    rows = _normalize_lots(lots)
    symbols = sorted({row["symbol"] for row in rows})
    calls = []
    for symbol in symbols:
        calls.append({"tool": "get_earnings_results", "arguments": {"symbol": symbol}})
        calls.append({"tool": "get_option_chains", "arguments": {"underlying_symbol": symbol}})
    if symbols:
        calls.append({"tool": "get_equity_quotes", "arguments": {"symbols": symbols}})
    for symbol in symbols:
        calls.append({
            "tool": "get_option_instruments",
            "arguments": {"chain_symbol": symbol, "state": "active"},
            "fill": {"expiration_dates": "nearest expiration_dates value on or after report.date, one YYYY-MM-DD"},
            "after": ["get_earnings_results", "get_option_chains"],
        })
        calls.append({
            "tool": "get_option_quotes",
            "arguments": {},
            "fill": {
                "instrument_ids": (
                    "ids of the active call and the active put at that expiry whose strike is nearest "
                    "the last trade; a tie takes the lower strike"
                ),
            },
            "after": ["get_option_instruments", "get_equity_quotes"],
        })
    return {"lots": rows, "calls": calls}


def fetch_gap_lots() -> list:
    """Open lots public.v_equity_implied_move_gaps still lists. Read-only."""
    from steward_rpc import call
    rows = call(STEWARD, "steward_implied_move_gaps", {"steward": STEWARD}, idempotent=True) or []
    if not isinstance(rows, list):
        raise RuntimeError("steward_implied_move_gaps did not return a list")
    return rows


_RAW_KEYS = ("data", "guide", "results", "chains", "instruments")


def _is_raw_response(value: dict) -> bool:
    return any(key in value for key in _RAW_KEYS)


def _filter_raw(payload: dict, symbol: str) -> dict:
    """Keep one symbol inside a batched MCP response. A one-symbol quote may omit the symbol."""
    data = _data(payload)
    if not isinstance(data, dict):
        return payload
    filtered = dict(data)
    results = data.get("results")
    if isinstance(results, list) and results and isinstance(results[0], dict):
        sample = results[0]
        quote = sample.get("quote") if isinstance(sample.get("quote"), dict) else {}
        if "symbol" in sample or quote.get("symbol"):
            kept = []
            for row in results:
                if not isinstance(row, dict):
                    continue
                q = row.get("quote") if isinstance(row.get("quote"), dict) else {}
                sym = row.get("symbol") or q.get("symbol")
                if str(sym or "").upper() == symbol:
                    kept.append(row)
            if not kept and len(results) == 1 and not sample.get("symbol") and not quote.get("symbol"):
                kept = list(results)
            filtered["results"] = kept
    if isinstance(data.get("chains"), list):
        filtered["chains"] = [
            chain for chain in data["chains"]
            if isinstance(chain, dict) and (not chain.get("symbol") or str(chain["symbol"]).upper() == symbol)
        ]
    if isinstance(data.get("instruments"), list):
        filtered["instruments"] = [
            inst for inst in data["instruments"]
            if isinstance(inst, dict) and (not inst.get("chain_symbol") or str(inst["chain_symbol"]).upper() == symbol)
        ]
    if isinstance(payload.get("data"), dict):
        return {**payload, "data": filtered}
    return filtered


def _pick_named(bag: dict, keys: tuple[str, ...], symbol: str):
    value = None
    for key in keys:
        if key in bag:
            value = bag[key]
            break
    if not isinstance(value, dict):
        return None
    if not _is_raw_response(value):
        for key, item in value.items():
            if str(key).upper() == symbol and isinstance(item, dict):
                return item
        return None
    return _filter_raw(value, symbol)


def payloads_for(doc: dict, symbol: str) -> dict:
    """Raw MCP responses for one symbol, in the shape build_observation reads."""
    symbol = symbol.upper()
    direct = doc.get(symbol)
    if isinstance(direct, dict) and any(k in direct for k in ("earnings", "chains", "equity_quote", "instruments", "quotes")):
        return direct
    sources = []
    nested = doc.get("responses")
    if isinstance(nested, dict):
        per = nested.get(symbol)
        if isinstance(per, dict):
            sources.append(per)
    sources.append(doc)
    results = calendar = chains = equity = instruments = quotes = None
    for source in sources:
        if not isinstance(source, dict):
            continue
        results = results or _pick_named(source, ("get_earnings_results", "earnings"), symbol)
        calendar = calendar or _pick_named(source, ("get_earnings_calendar",), symbol)
        chains = chains or _pick_named(source, ("get_option_chains", "chains"), symbol)
        equity = equity or _pick_named(source, ("get_equity_quotes", "equity_quote"), symbol)
        instruments = instruments or _pick_named(source, ("get_option_instruments", "instruments"), symbol)
        quotes = quotes or _pick_named(source, ("get_option_quotes", "quotes"), symbol)
    earnings = results if results is not None else calendar
    out = {}
    if earnings is not None:
        out["earnings"] = earnings
    if chains is not None:
        out["chains"] = chains
    if equity is not None:
        out["equity_quote"] = equity
    if instruments is not None:
        out["instruments"] = instruments
    if quotes is not None:
        out["quotes"] = quotes
    return out


def _jsonable(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        text = value.isoformat()
        return text.replace("+00:00", "Z") if text.endswith("+00:00") else text
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def implied_move_sql(args: dict) -> str:
    """One statement. Dollar-quoted so the JSON is the function argument, not invented SQL."""
    body = json.dumps(args, separators=(",", ":"), sort_keys=True)
    tag = "im"
    while f"${tag}$" in body:
        tag += "x"
    return f"select public.steward_record_equity_implied_move(${tag}${body}${tag}$::jsonb);"


def _execute_record(args: dict):
    from steward_rpc import call
    return call(STEWARD, "steward_record_equity_implied_move", args)


def write_payload(doc: dict, *, execute: bool = False, now: datetime | None = None, caller=None) -> dict:
    """Turn saved MCP responses into one SQL statement per lot. Missing quotes become a missing row."""
    if not isinstance(doc, dict):
        raise ValueError("payload must be a JSON object")
    raw_lots = doc.get("lots")
    if not isinstance(raw_lots, list):
        raise ValueError("payload lots must be a list of {lot_id, symbol}")
    now_i = now or datetime.now(timezone.utc)
    lots = _normalize_lots(raw_lots)
    statements = []
    results = []
    for lot in lots:
        symbol = lot["symbol"]
        row = {"lot_id": lot["lot_id"], "symbol": symbol}
        try:
            got = build_observation(symbol, payloads_for(doc, symbol), now_i)
            payload_args = _jsonable(record_args(lot["lot_id"], symbol, got, now_i))
            sql = implied_move_sql(payload_args)
        except Exception as exc:
            row.update({"action": "error", "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
            results.append(row)
            continue
        statements.append(sql)
        row["sql"] = sql
        if payload_args.get("missing_reason"):
            row["action"] = FLAG
            row["missing_reason"] = payload_args["missing_reason"]
        elif payload_args.get("reported") or (got.get("meta") or {}).get("why") == "report has passed":
            row["action"] = "passed"
        else:
            row["action"] = "straddle"
        if payload_args.get("expiry_date"):
            row["expiry_date"] = payload_args["expiry_date"]
        if payload_args.get("strike") is not None:
            row["strike"] = payload_args["strike"]
        if execute:
            try:
                wrote = (caller or _execute_record)(payload_args)
                if isinstance(wrote, dict):
                    if wrote.get("expiry_date"):
                        row["expiry_date"] = wrote["expiry_date"]
                    if wrote.get("missing_reason"):
                        row["missing_reason"] = wrote["missing_reason"]
            except Exception as exc:
                row.update({"action": "error", "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
        results.append(row)
    return {"lots": len(lots), "statements": statements, "results": results}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="earnings_implied.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="open lots with no current implied-move row, and the Robinhood calls")
    wr = sub.add_parser("write", help="saved Robinhood responses to steward_record_equity_implied_move SQL")
    wr.add_argument("payload", help="JSON file: lots plus the raw MCP responses")
    wr.add_argument("--execute", action="store_true", help="call the ledger as well as printing the SQL")
    wr.add_argument("--dry-run", action="store_true", help="print the SQL only")
    args = ap.parse_args(argv)
    if args.command == "plan":
        try:
            print(json.dumps(plan_calls(fetch_gap_lots()), default=str))
        except Exception as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
            return 1
        return 0
    try:
        doc = json.loads(open(args.payload).read())
        out = write_payload(doc, execute=bool(args.execute) and not args.dry_run)
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
        return 1
    print(json.dumps(out, default=str))
    return 1 if any(row.get("action") == "error" for row in out["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
