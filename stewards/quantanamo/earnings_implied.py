#!/usr/bin/env python3
"""QUANTANAMO earnings implied move: the straddle a held equity can gap on the print.

The sweep is two commands. Python does not call Robinhood. On the box, sync_box.sh
copies this file to /workspace/quantanamo/earnings_implied.py.

  python3 stewards/quantanamo/earnings_implied.py plan
  python3 stewards/quantanamo/earnings_implied.py write payload.json
  python3 stewards/quantanamo/earnings_implied.py write payload.json --execute

plan prints the open lots that lack a current implied-move row (no row, or a report
still ahead with no straddle and no implied_move_missing flag), the Robinhood
calls, and any lot whose report has passed but whose realized move is not stored.
write reads the saved MCP responses and emits
select public.steward_record_equity_implied_move(...). --execute runs that call
and then scores passed prints. --dry-run prints the SQL only. A missing quote is
stored as implied_move_missing. This file never invents a price.

  python3 stewards/quantanamo/earnings_implied.py score
  python3 stewards/quantanamo/earnings_implied.py score --execute
  python3 stewards/quantanamo/earnings_implied.py score --price 105.25 --price-source robinhood_historicals_rth_close
  python3 stewards/quantanamo/earnings_implied.py score --price 105.25 --price-source financialdatasets_mcp --lot <lot_id>

score reads daily bars (Financial Datasets, else Robinhood historicals in a
payload) and emits select public.steward_record_equity_earnings_score(...).
AM uses the prior session's close. PM uses that session's close. The post
session is the report session for AM and the next session for PM. A missing
bar is score_missing_reason. --price is that post-session close already in
hand. It skips the Financial Datasets fetch (no FINANCIAL_DATASETS_API_KEY)
and scores the supplied close. --price-source names where it came from
(robinhood_historicals_rth_close, financialdatasets_mcp) and is stored with
the score. --lot scores one due lot; with --price it is required when more
than one lot is due. A non-positive --price is rejected. Without --price,
scoring is unchanged. On the box, after sync_box.sh, the morning after
NFLX (pm 2026-10-20) and EFX (am 2026-10-20) is:

  python3 /workspace/quantanamo/earnings_implied.py score --execute

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
            "expiry_gap_days": (expiry - report["report_date"]).days,
            "expiry_loose": (expiry - report["report_date"]).days > 7,
            # select_expiry already took the nearest listed date. A gap over 7
            # days means that chain had nothing closer.
            "nearer_expiry_listed": False if (expiry - report["report_date"]).days > 7 else None,
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
    if isinstance(direct, dict) and any(k in direct for k in ("earnings", "chains", "equity_quote", "instruments", "quotes", "historicals")):
        return direct
    sources = []
    nested = doc.get("responses")
    if isinstance(nested, dict):
        per = nested.get(symbol)
        if isinstance(per, dict):
            sources.append(per)
    sources.append(doc)
    results = calendar = chains = equity = instruments = quotes = historicals = None
    for source in sources:
        if not isinstance(source, dict):
            continue
        results = results or _pick_named(source, ("get_earnings_results", "earnings"), symbol)
        calendar = calendar or _pick_named(source, ("get_earnings_calendar",), symbol)
        chains = chains or _pick_named(source, ("get_option_chains", "chains"), symbol)
        equity = equity or _pick_named(source, ("get_equity_quotes", "equity_quote"), symbol)
        instruments = instruments or _pick_named(source, ("get_option_instruments", "instruments"), symbol)
        quotes = quotes or _pick_named(source, ("get_option_quotes", "quotes"), symbol)
        historicals = historicals or _pick_named(source, ("get_equity_historicals", "historicals"), symbol)
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
    if historicals is not None:
        out["historicals"] = historicals
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


LOOSE_DAYS = 7
OUTLIER_RATIO = Decimal("1.5")
THIN_N = 5
SCORE_SOURCE_FD = "financialdatasets_prices_day"
SCORE_SOURCE_RH = "robinhood_equity_historicals"
SCORE_SOURCE_SUPPLIED = "supplied_post_close"
OPEN_ET = time(9, 30)


def _pass_marks():
    """NYSE session close lives in pass_marks.py, copied beside this file on the box."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import pass_marks
    return pass_marks


def session_close_at(day: date):
    return _pass_marks().session_close_at(day)


def _walk_session(start: date, step: int) -> date | None:
    cursor = start
    for _ in range(12):
        cursor += timedelta(days=step)
        if session_close_at(cursor) is not None:
            return cursor
    return None


def prior_session(day: date) -> date | None:
    return _walk_session(day, -1)


def next_session(day: date) -> date | None:
    return _walk_session(day, 1)


def reference_session(report_date: date, timing: str | None) -> date | None:
    """AM: the prior session's close. PM: that session's close (or the prior one if the date is shut)."""
    if timing == "pm" and session_close_at(report_date) is not None:
        return report_date
    return prior_session(report_date)


def post_session(report_date: date, timing: str | None) -> date | None:
    """First regular session after the print. AM uses the report date when that date trades."""
    if timing == "am" and session_close_at(report_date) is not None:
        return report_date
    return next_session(report_date)


def expiry_gap_days(report_date: date | None, expiry: date | None) -> int | None:
    if report_date is None or expiry is None:
        return None
    return (expiry - report_date).days


def expiry_is_loose(report_date: date | None, expiry: date | None) -> bool:
    gap = expiry_gap_days(report_date, expiry)
    return gap is not None and gap > LOOSE_DAYS


def _decimal(value) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def line_was_jumped(post_open, invalidation, quantity) -> bool | None:
    """Long: the open printed at or below the exit. Short: at or above it. Missing prices stay unknown."""
    opened = _positive(post_open)
    line = _positive(invalidation)
    if opened is None or line is None:
        return None
    qty = _decimal(quantity)
    if qty is not None and qty < 0:
        return opened >= line
    return opened <= line


def move_fraction(later, reference) -> Decimal | None:
    after = _positive(later)
    base = _positive(reference)
    if after is None or base is None:
        return None
    return _q6((after - base) / base)


def realized_implied_ratio(realized, straddle, underlying) -> tuple[Decimal | None, Decimal | None]:
    """(ratio, implied fraction). Ratio is abs(close-to-close) / (straddle / underlying)."""
    move = _decimal(realized) if realized is not None else None
    leg = _positive(straddle)
    spot = _positive(underlying)
    implied = (leg / spot) if leg is not None and spot is not None else None
    if move is None or implied is None or implied <= 0:
        return None, implied
    return _q6(abs(move) / implied), implied


def is_earnings_outlier(ratio, jumped: bool | None) -> bool:
    """A clear miss: the close ran past 1.5x the priced move, or the open jumped the exit. 1.5x exactly is not."""
    if jumped:
        return True
    if ratio is None:
        return False
    return ratio > OUTLIER_RATIO


def pct_text(fraction) -> str:
    value = (abs(Decimal(str(fraction))) * Decimal(100)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    text = format(value, "f")
    if text.endswith(".0"):
        text = text[:-2]
    return f"{text}%"


def earnings_lesson_text(*, symbol: str, realized, implied, ratio, jumped: bool | None,
                         loose: bool, n: int | None) -> str:
    """Plain lesson. A sample under 5 prints is labeled thin and draws no verdict."""
    parts = []
    if realized is not None and implied is not None:
        ratio_bit = ""
        if ratio is not None:
            shown = ratio.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if isinstance(ratio, Decimal) else Decimal(str(ratio))
            ratio_bit = f" ({format(shown, 'f')}x)"
        parts.append(f"{symbol} moved {pct_text(realized)} on the print; options had priced {pct_text(implied)}{ratio_bit}.")
    elif realized is not None:
        parts.append(f"{symbol} moved {pct_text(realized)} on the print.")
    if jumped:
        parts.append("The open went through the exit line.")
    if not parts:
        parts.append(f"{symbol} opened outside the priced earnings move.")
    if loose:
        parts.append("The option expired more than a week after the report, so the priced move was a loose upper bound.")
    if n is None or n < THIN_N:
        label = "a handful of" if n is None else str(n)
        word = "print" if n == 1 else "prints"
        parts.append(f"{label} scored {word} so far, too few for a verdict.")
    return " ".join(parts)


def _session_open_at(day: date) -> datetime:
    return datetime.combine(day, OPEN_ET, tzinfo=ET)


def _close_in(day: date, now: datetime) -> bool:
    close = session_close_at(day)
    return close is not None and now >= close


def _open_in(day: date, now: datetime) -> bool:
    return session_close_at(day) is not None and now >= _session_open_at(day)


def _one_bar(row: dict, symbol: str) -> dict | None:
    if not isinstance(row, dict):
        return None
    ticker = str(row.get("ticker") or row.get("symbol") or "").upper()
    if ticker and ticker != symbol.upper():
        return None
    if row.get("interpolated") is True or str(row.get("interpolated") or "").lower() == "true":
        return None
    day = _parse_date(row.get("time") or row.get("begins_at") or row.get("date") or row.get("session"))
    if day is None:
        return None
    volume = row.get("volume")
    if volume is not None and str(volume).strip() != "":
        vol = _decimal(volume)
        if vol is None or vol <= 0:
            return None
    return {
        "day": day,
        "open": _positive(row.get("open") if row.get("open") is not None else row.get("open_price")),
        "close": _positive(row.get("close") if row.get("close") is not None else row.get("close_price")),
    }


def _historical_rows(payload, symbol: str) -> list | None:
    """None when the payload is not a bar response. [] when it is and lists nothing for the symbol."""
    if payload is None:
        return None
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return None
    data = _data(payload) or payload
    if isinstance(data.get("prices"), list):
        return data["prices"]
    historicals = data.get("historicals")
    if isinstance(historicals, list):
        return historicals
    results = data.get("results")
    if isinstance(results, list):
        rows = []
        want = symbol.upper()
        for item in results:
            if not isinstance(item, dict):
                continue
            named = str(item.get("symbol") or "").upper()
            if named and named != want:
                continue
            nested = item.get("historicals")
            if isinstance(nested, list):
                rows.extend(nested)
            elif item.get("open_price") is not None or item.get("open") is not None or item.get("time"):
                rows.append(item)
        return rows
    return None


def parse_daily_bars(payload, symbol: str) -> list[dict] | None:
    """Real daily bars only. None means the payload could not be read. Interpolated and zero-volume bars are dropped."""
    rows = _historical_rows(payload, symbol)
    if rows is None:
        return None
    found: dict[date, dict] = {}
    for row in rows:
        bar = _one_bar(row, symbol)
        if bar is None:
            continue
        previous = found.get(bar["day"])
        if previous is None or (previous.get("close") is None and bar.get("close") is not None):
            found[bar["day"]] = bar
    return [found[day] for day in sorted(found)]


def score_earnings_move(*, report_date: date, timing: str | None, bars: list[dict] | None, now: datetime,
                        invalidation, quantity, straddle, underlying) -> dict:
    """Reference close, post open, post close, percents, and a missing reason. Never fills a gap with a guess."""
    ref_day = reference_session(report_date, timing)
    post_day = post_session(report_date, timing)
    by_day = {bar["day"]: bar for bar in (bars or [])}
    ref_bar = by_day.get(ref_day) if ref_day else None
    post_bar = by_day.get(post_day) if post_day else None
    ref_close = ref_bar.get("close") if ref_bar and ref_day and _close_in(ref_day, now) else None
    post_open = post_bar.get("open") if post_bar and post_day and _open_in(post_day, now) else None
    post_close = post_bar.get("close") if post_bar and post_day and _close_in(post_day, now) else None
    reason = None
    if bars is None or ref_close is None and post_open is None and post_close is None and not bars:
        reason = "bars_unavailable" if bars is None or not bars else "no_reference_bar"
        ref_close = post_open = post_close = None
    elif ref_close is None:
        reason = "no_reference_bar"
        post_open = post_close = None
    elif post_open is None:
        reason = "no_post_open"
        post_close = None
    elif post_close is None:
        reason = "no_post_close"
    realized_close = move_fraction(post_close, ref_close)
    ratio, implied = realized_implied_ratio(realized_close, straddle, underlying)
    jumped = line_was_jumped(post_open, invalidation, quantity)
    return {
        "reference_session": ref_day,
        "post_session": post_day,
        "reference_close": ref_close,
        "post_open": post_open,
        "post_close": post_close,
        "realized_open_gap": move_fraction(post_open, ref_close),
        "realized_close_to_close": realized_close,
        "implied_fraction": implied,
        "realized_implied_ratio": ratio,
        "line_jumped": jumped,
        "score_missing_reason": reason,
        "outlier": is_earnings_outlier(ratio, jumped) and (realized_close is not None or jumped is True),
    }


def score_record_args(lot: dict, move: dict, source: str, price_source: str | None = None) -> dict:
    args = {
        "steward": STEWARD,
        "lot_id": str(lot.get("lot_id")),
        "symbol": str(lot.get("symbol") or "").upper(),
        "score_source": source,
    }
    if price_source:
        args["price_source"] = price_source
    if move.get("score_missing_reason"):
        args["score_missing_reason"] = move["score_missing_reason"]
    for key in ("reference_close", "reference_session", "post_open", "post_close", "post_session"):
        if move.get(key) is not None:
            args[key] = move[key]
    return args


def _dollar_sql(fn: str, args: dict) -> str:
    body = json.dumps(_jsonable(args), separators=(",", ":"), sort_keys=True)
    tag = "sc"
    while f"${tag}$" in body:
        tag += "x"
    return f"select public.{fn}(${tag}${body}${tag}$::jsonb);"


def bar_window(lot: dict, now: datetime) -> tuple[date, date]:
    report = lot.get("report_date")
    report = report if isinstance(report, date) and not isinstance(report, datetime) else _parse_date(report)
    timing = lot.get("report_timing") if lot.get("report_timing") in ("am", "pm") else None
    ref = reference_session(report, timing) if report else None
    start = (ref or now.astimezone(ET).date()) - timedelta(days=7)
    return start, now.astimezone(ET).date()


def score_calls(lots, now: datetime) -> list[dict]:
    calls = []
    for lot in _normalize_lots(lots):
        start, _end = bar_window(lot, now)
        calls.append({
            "tool": "get_equity_historicals",
            "arguments": {
                "symbols": [lot["symbol"]],
                "interval": "day",
                "bounds": "regular",
                "adjustment_type": "split",
                "start_time": datetime.combine(start, time(0, 0), tzinfo=ET).isoformat(),
            },
            "note": "regular daily bars only; skip a bar marked interpolated",
        })
    return calls


def fetch_score_pending() -> list:
    from steward_rpc import call
    rows = call(STEWARD, "steward_earnings_score_pending", {"steward": STEWARD}, idempotent=True) or []
    if not isinstance(rows, list):
        raise RuntimeError("steward_earnings_score_pending did not return a list")
    return rows


def fetch_fd_prices(symbol: str, start: date, end: date, api_key: str) -> dict:
    """Daily bars from Financial Datasets. Raises SourceError on transport. 404 is an empty list, not a guess."""
    import urllib.error
    import urllib.parse
    import urllib.request
    bars: list = []
    url = "https://api.financialdatasets.ai/prices/?" + urllib.parse.urlencode({
        "ticker": symbol,
        "interval": "day",
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
    })
    headers = {
        "X-API-KEY": api_key,
        "accept": "application/json",
        "user-agent": "grasshopper-quantanamo/earnings_implied",
    }
    for _ in range(5):
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {"prices": []}
            raise SourceError(f"financial datasets prices HTTP {exc.code}") from None
        except SourceError:
            raise
        except Exception as exc:
            raise SourceError(f"{type(exc).__name__}: {str(exc)[:200]}") from None
        if not isinstance(body, dict) or not isinstance(body.get("prices"), list):
            raise SourceError("financial datasets prices response has no prices array")
        bars.extend(body["prices"])
        nxt = body.get("next_page_url")
        if not nxt:
            return {"prices": bars}
        nxt = str(nxt)
        if not nxt.startswith("https://api.financialdatasets.ai/"):
            raise SourceError("financial datasets next_page_url is not on api.financialdatasets.ai")
        url = nxt
    raise SourceError("financial datasets prices still had another page after the page cap")


def load_fd_prices(symbol: str, start: date, end: date):
    key = _pass_marks()._api_key()
    if not key:
        raise SourceError("financialdatasets: FINANCIAL_DATASETS_API_KEY not set")
    return fetch_fd_prices(symbol, start, end, key)


def _lesson_args(lot: dict, move: dict, summary: str) -> dict:
    return {
        "steward": STEWARD,
        "lot_id": str(lot.get("lot_id")),
        "symbol": str(lot.get("symbol") or "").upper(),
        "summary": summary,
    }


def score_supplied_close(lot: dict, price: Decimal, now: datetime) -> dict:
    """Post-session close the caller already has. Does not read bars and does not invent an open.

    The reference close is the one already stored on the lot, else the underlying the straddle
    was marked on. A missing open leaves the gap and line_jumped unknown and keeps the close.
    """
    report = lot.get("report_date")
    report = report if isinstance(report, date) and not isinstance(report, datetime) else _parse_date(report)
    timing = lot.get("report_timing") if lot.get("report_timing") in ("am", "pm") else None
    ref_day = reference_session(report, timing) if report else None
    post_day = post_session(report, timing) if report else None
    stored_ref = _parse_date(lot.get("reference_session"))
    stored_post = _parse_date(lot.get("post_session"))
    if stored_ref is not None:
        ref_day = stored_ref
    if stored_post is not None:
        post_day = stored_post
    ref_close = _positive(lot.get("reference_close"))
    if ref_close is None:
        ref_close = _positive(lot.get("underlying_price"))
    post_open = _positive(lot.get("post_open"))
    post_close = _positive(price)
    reason = None
    if ref_close is None:
        reason = "no_reference_bar"
        post_open = None
        post_close = None
    elif post_close is None:
        reason = "no_post_close"
    realized_close = move_fraction(post_close, ref_close)
    ratio, implied = realized_implied_ratio(
        realized_close, lot.get("straddle_price"), lot.get("underlying_price"),
    )
    jumped = line_was_jumped(post_open, lot.get("invalidation_price"), lot.get("quantity"))
    return {
        "reference_session": ref_day,
        "post_session": post_day,
        "reference_close": ref_close,
        "post_open": post_open,
        "post_close": post_close,
        "realized_open_gap": move_fraction(post_open, ref_close),
        "realized_close_to_close": realized_close,
        "implied_fraction": implied,
        "realized_implied_ratio": ratio,
        "line_jumped": jumped,
        "score_missing_reason": reason,
        "outlier": is_earnings_outlier(ratio, jumped) and (realized_close is not None or jumped is True),
    }


def _due_lots(lots) -> list[dict]:
    return [lot for lot in lots or [] if isinstance(lot, dict)]


def parse_score_price(text: str) -> Decimal:
    """--price must be a real positive number. Zero and blanks are rejected."""
    number = _positive(text)
    if number is None:
        shown = text if isinstance(text, str) else repr(text)
        raise ValueError(f"score --price must be a positive number, got {shown}")
    return number


def score_lots(lots, *, load, execute: bool, now: datetime, source: str,
               caller_score=None, caller_lesson=None,
               supplied_close: Decimal | None = None, price_source: str | None = None) -> dict:
    """Score each lot from load(symbol, start, end). A transport error is a retry, not a missing bar.

    supplied_close skips load entirely: the caller already has the post-report close.
    """
    statements = []
    results = []
    for lot in lots or []:
        if not isinstance(lot, dict):
            continue
        symbol = str(lot.get("symbol") or "").upper()
        row = {"lot_id": str(lot.get("lot_id") or ""), "symbol": symbol}
        if price_source:
            row["price_source"] = price_source
        report = lot.get("report_date")
        report = report if isinstance(report, date) and not isinstance(report, datetime) else _parse_date(report)
        if report is None:
            row.update({"action": "error", "error": "score lot has no report_date"})
            results.append(row)
            continue
        timing = lot.get("report_timing") if lot.get("report_timing") in ("am", "pm") else None
        if supplied_close is None:
            start, end = bar_window(lot, now)
            try:
                raw = load(symbol, start, end)
            except SourceError as exc:
                row.update({"action": "retry", "error": str(exc)[:200]})
                results.append(row)
                continue
            if raw is None:
                row["action"] = "waiting"
                results.append(row)
                continue
            parsed = parse_daily_bars(raw, symbol)
            move = score_earnings_move(
                report_date=report, timing=timing, bars=parsed, now=now,
                invalidation=lot.get("invalidation_price"), quantity=lot.get("quantity"),
                straddle=lot.get("straddle_price"), underlying=lot.get("underlying_price"),
            )
        else:
            move = score_supplied_close(lot, supplied_close, now)
        args = _jsonable(score_record_args(lot, move, source, price_source))
        sql = _dollar_sql("steward_record_equity_earnings_score", args)
        statements.append(sql)
        row.update({
            "action": "scored" if move.get("realized_close_to_close") is not None else "missing",
            "score_missing_reason": move.get("score_missing_reason"),
            "reference_session": None if move.get("reference_session") is None else move["reference_session"].isoformat(),
            "post_session": None if move.get("post_session") is None else move["post_session"].isoformat(),
            "outlier": bool(move.get("outlier")),
            "sql": sql,
        })
        wrote = None
        if execute:
            try:
                wrote = (caller_score or _execute_score)(args)
            except Exception as exc:
                row.update({"action": "error", "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
                results.append(row)
                continue
            if isinstance(wrote, dict):
                row["outlier"] = bool(wrote.get("outlier"))
                row["reported"] = wrote.get("reported")
                row["thin"] = wrote.get("thin")
                row["n"] = wrote.get("n")
                if wrote.get("score_missing_reason"):
                    row["score_missing_reason"] = wrote["score_missing_reason"]
        if row.get("outlier"):
            n = None
            realized = move.get("realized_close_to_close")
            implied = move.get("implied_fraction")
            ratio = move.get("realized_implied_ratio")
            jumped = move.get("line_jumped")
            if isinstance(wrote, dict):
                n = wrote.get("n")
                if wrote.get("realized_close_to_close") is not None:
                    realized = _decimal(wrote.get("realized_close_to_close"))
                if wrote.get("implied_fraction") is not None:
                    implied = _decimal(wrote.get("implied_fraction"))
                if wrote.get("realized_implied_ratio") is not None:
                    ratio = _decimal(wrote.get("realized_implied_ratio"))
                if "line_jumped" in wrote:
                    jumped = wrote.get("line_jumped")
            summary = earnings_lesson_text(
                symbol=symbol, realized=realized, implied=implied, ratio=ratio,
                jumped=bool(jumped) if jumped is not None else None,
                loose=bool(lot.get("expiry_loose")),
                n=int(n) if n is not None and str(n).strip() != "" else None,
            )
            lesson = _jsonable(_lesson_args(lot, move, summary))
            lesson_sql = _dollar_sql("steward_record_earnings_lesson", lesson)
            statements.append(lesson_sql)
            row["lesson_sql"] = lesson_sql
            if execute:
                try:
                    noted = (caller_lesson or _execute_lesson)(lesson)
                    if isinstance(noted, dict):
                        row["lesson"] = noted.get("skipped") or ("replayed" if noted.get("replayed") else "written")
                except Exception as exc:
                    row["lesson_error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        results.append(row)
    return {"lots": len(results), "statements": statements, "results": results}


def _execute_score(args: dict):
    from steward_rpc import call
    return call(STEWARD, "steward_record_equity_earnings_score", args)


def _execute_lesson(args: dict):
    from steward_rpc import call
    return call(STEWARD, "steward_record_earnings_lesson", args)


def score_from_loads(lots, *, execute: bool, now: datetime | None = None, load=None,
                     caller_score=None, caller_lesson=None) -> dict:
    now_i = now or datetime.now(timezone.utc)
    return score_lots(
        lots,
        load=load or load_fd_prices,
        execute=execute,
        now=now_i,
        source=SCORE_SOURCE_FD if load is None else SCORE_SOURCE_RH,
        caller_score=caller_score,
        caller_lesson=caller_lesson,
    )


def score_document(doc: dict, *, execute: bool, now: datetime | None = None,
                   caller_score=None, caller_lesson=None) -> dict:
    """Score doc['score'] from saved historicals. --execute falls back to Financial Datasets."""
    now_i = now or datetime.now(timezone.utc)
    lots = doc.get("score") if isinstance(doc.get("score"), list) else []
    if execute and not lots:
        try:
            lots = fetch_score_pending()
        except Exception as exc:
            return {"lots": 0, "statements": [], "results": [],
                    "error": f"{type(exc).__name__}: {str(exc)[:300]}"}

    def load(symbol: str, start: date, end: date):
        raw = payloads_for(doc, symbol).get("historicals") if isinstance(doc, dict) else None
        if raw is not None:
            return raw
        if not execute:
            return None
        return load_fd_prices(symbol, start, end)

    source = SCORE_SOURCE_RH
    # A document with no historicals is scored from Financial Datasets.
    if not any(payloads_for(doc, str(lot.get("symbol") or "")) .get("historicals") is not None
               for lot in lots if isinstance(lot, dict)):
        source = SCORE_SOURCE_FD
    return score_lots(
        lots, load=load, execute=execute, now=now_i, source=source,
        caller_score=caller_score, caller_lesson=caller_lesson,
    )


def plan_document(gaps, pending, now: datetime | None = None) -> dict:
    now_i = now or datetime.now(timezone.utc)
    out = plan_calls(gaps)
    rows = pending if isinstance(pending, list) else []
    out["score"] = rows
    out["score_calls"] = score_calls(rows, now_i)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="earnings_implied.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="implied-move gaps, score-pending lots, and the Robinhood calls")
    wr = sub.add_parser("write", help="saved Robinhood responses to ledger SQL, then score passed prints")
    wr.add_argument("payload", help="JSON file: lots plus the raw MCP responses")
    wr.add_argument("--execute", action="store_true", help="call the ledger as well as printing the SQL")
    wr.add_argument("--dry-run", action="store_true", help="print the SQL only")
    sc = sub.add_parser(
        "score",
        help="score passed prints from Financial Datasets daily bars, or from --price",
        description=(
            "Score passed prints. Without --price, read Financial Datasets daily bars "
            "(FINANCIAL_DATASETS_API_KEY). With --price, skip that fetch and score the "
            "supplied post-report close. --price-source names that close "
            "(robinhood_historicals_rth_close, financialdatasets_mcp) and is stored "
            "with the score. --lot scores one due lot; it is required with --price "
            "when more than one lot is due. A non-positive --price is rejected."
        ),
    )
    sc.add_argument("--execute", action="store_true", help="call the ledger as well as printing the SQL")
    sc.add_argument("--dry-run", action="store_true", help="print the SQL only")
    sc.add_argument("--price", metavar="FLOAT", help="post-report close; skips the Financial Datasets fetch")
    sc.add_argument(
        "--price-source",
        help="where --price came from, e.g. robinhood_historicals_rth_close or financialdatasets_mcp",
    )
    sc.add_argument("--lot", metavar="LOT_ID", help="score this lot only; required with --price when several lots are due")
    args = ap.parse_args(argv)
    if args.command == "plan":
        try:
            gaps = fetch_gap_lots()
        except Exception as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
            return 1
        pending = []
        score_error = None
        try:
            pending = fetch_score_pending()
        except Exception as exc:
            score_error = f"{type(exc).__name__}: {str(exc)[:300]}"
        out = plan_document(gaps, pending)
        if score_error:
            out["score_error"] = score_error
        print(json.dumps(out, default=str))
        return 0
    if args.command == "score":
        execute = bool(args.execute) and not args.dry_run
        price = None
        if args.price is not None:
            try:
                price = parse_score_price(args.price)
            except ValueError as exc:
                print(json.dumps({"error": str(exc)}))
                return 1
        price_source = str(args.price_source).strip() if args.price_source else None
        if price_source == "":
            price_source = None
        try:
            pending = fetch_score_pending()
        except Exception as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
            return 1
        due = _due_lots(pending)
        lot_id = str(args.lot).strip() if args.lot else ""
        if price is not None and len(due) > 1 and not lot_id:
            print(json.dumps({"error": "score --price needs --lot when more than one lot is due"}))
            return 1
        if lot_id:
            due = [lot for lot in due if str(lot.get("lot_id") or "").strip() == lot_id]
            if not due:
                print(json.dumps({"error": f"score --lot {lot_id} is not a due lot"}))
                return 1
        if price is not None and not due:
            print(json.dumps({"error": "score --price found no due lot"}))
            return 1
        try:
            if price is None:
                out = score_from_loads(due, execute=execute)
            else:
                out = score_lots(
                    due,
                    load=load_fd_prices,
                    execute=execute,
                    now=datetime.now(timezone.utc),
                    source=price_source or SCORE_SOURCE_SUPPLIED,
                    supplied_close=price,
                    price_source=price_source,
                )
        except Exception as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
            return 1
        print(json.dumps(out, default=str))
        return 1 if any(row.get("action") == "error" for row in out.get("results", [])) else 0
    try:
        doc = json.loads(open(args.payload).read())
        execute = bool(args.execute) and not args.dry_run
        out = write_payload(doc, execute=execute)
        out["score"] = score_document(doc, execute=execute)
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
        return 1
    print(json.dumps(out, default=str))
    bad = any(row.get("action") == "error" for row in out["results"])
    bad = bad or any(row.get("action") == "error" for row in out["score"].get("results", []))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
