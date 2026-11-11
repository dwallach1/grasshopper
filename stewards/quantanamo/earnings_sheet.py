#!/usr/bin/env python3
"""QUANTANAMO earnings sheet: rank the full high-cap calendar, not only names already in public.symbols.

Lessons 190, 223, 226, 230, 241, and 245 (earnings_gap_structure) are the same miss:
a day-0 winner was never on the nightly sheet because the sheet only ranked names
already in public.symbols or on the quality_drawdown list. The Robinhood high-cap
calendar was already being pulled. This script ranks every name on it.

Python does not call Robinhood. On the box, sync_box.sh copies this file to
/workspace/quantanamo/earnings_sheet.py.

  python3 stewards/quantanamo/earnings_sheet.py plan --sessions 2
  python3 stewards/quantanamo/earnings_sheet.py rank payload.json
  python3 stewards/quantanamo/earnings_sheet.py rank payload.json --execute

plan prints the tool calls for the next 1-2 NYSE sessions (after the close, those
are the following sessions). rank reads the saved responses and prints one
research_queue row: priority 1, source earnings_sheet, the same shape the autopsy
sheet uses. --execute writes that row and inserts any calendar symbol that is not
in public.symbols yet. PLTR is never a candidate.

A beat is a reported EPS greater than the estimate on that quarter. The last 6
such quarters, all beats, is beat_history_6of6. Fewer than 6 comparable quarters
is no_history. quality_drawdown is the screen in the 2026-09-25 playbook rule:
at least 30% below the high of the last 365 days of regular sessions, on a name
this calendar already lists. crash_dump_am is lesson 230: an AM print, at least
25% below that high, and a prior regular session close-to-close of -8% or worse.
A missing EPS, estimate, or bar stays missing. Nothing here is invented, and
nothing here places an order.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

STEWARD = "quantanamo"
SOURCE = "earnings_sheet"
WRITER = "earnings_sheet.py"
PRIORITY = 1
BEATS_N = 6
BEATS_MAX = 8  # get_earnings_results returns at most 8 quarters
QD_OFF = Decimal("0.30")  # quality_drawdown_into_print: >= 30% off the 52-week high
CRASH_OFF = Decimal("0.25")  # lesson 230: >= 25% off that high
CRASH_PRIOR = Decimal("-0.08")  # prior RTH close-to-close <= -8%
YEAR = timedelta(days=365)
YEAR_SLACK = timedelta(days=10)  # a bar within this of the window start shows the series reaches it
CALENDAR_START = date(2026, 1, 1)  # us_equity_market_calendar begins here; earlier holidays are not listed
EXCLUDED = frozenset({"PLTR"})
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
SIX = Decimal("0.000001")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
ET_NAME = "America/New_York"

PLAIN = (
    "Ranked every high-cap calendar name. beat_history_6of6 means the last 6 quarters "
    "with both a reported EPS and an estimate were all beats. quality_drawdown means "
    "at least 30% below the high of the regular sessions in the 365 days before the "
    "prior session. crash_dump_am means an AM print, at least 25% below that high, "
    "and a prior regular session close-to-close of -8% or worse. A missing EPS, "
    "estimate, or bar stays missing."
)


class PayloadError(ValueError):
    """The saved responses cannot be read. Not a reason to write an empty sheet."""


def _zone():
    from zoneinfo import ZoneInfo
    return ZoneInfo(ET_NAME)


def _pass_marks():
    """NYSE session close lives in pass_marks.py, copied beside this file on the box."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import pass_marks
    return pass_marks


def session_close_at(day: date):
    return _pass_marks().session_close_at(day)


def prior_session(day: date) -> date | None:
    cursor = day
    for _ in range(14):
        cursor -= timedelta(days=1)
        if session_close_at(cursor) is not None:
            return cursor
    return None


def next_sessions(n: int, now: datetime) -> list[date]:
    """The next n NYSE sessions. A session already closed is not one of them."""
    if n < 1:
        raise ValueError("sessions must be at least 1")
    et = now.astimezone(_zone())
    day = et.date()
    close = session_close_at(day)
    if close is None or et >= close:
        day += timedelta(days=1)
    found: list[date] = []
    for _ in range(n * 5 + 21):
        if session_close_at(day) is not None:
            found.append(day)
            if len(found) == n:
                return found
        day += timedelta(days=1)
    raise ValueError(f"could not find {n} NYSE sessions")


def calendar_window(sessions: list[date]) -> dict:
    """Robinhood get_earnings_calendar arguments that cover these sessions, including a weekend between them."""
    if not sessions:
        raise ValueError("no sessions")
    start, end = sessions[0], sessions[-1]
    days = (end - start).days + 1
    if days < 1 or days > 31:
        raise ValueError(f"calendar window is {days} days; Robinhood allows 1 to 31")
    return {"start_date": start.isoformat(), "days": days, "filter": "high_market_cap"}


def _short(day: date) -> str:
    return f"{WEEKDAYS[day.weekday()]} {day.month}/{day.day}"


def _decimal(value) -> Decimal | None:
    """A real number. Blank, bool, and garbage are not numbers. Zero is allowed (an estimate can be 0)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _q6(number: Decimal) -> str:
    return format(number.quantize(SIX, rounding=ROUND_HALF_UP), "f")


def _parse_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raw = str(value or "")[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _symbol(value) -> str | None:
    text = str(value or "").upper().strip()
    if not SYMBOL_RE.match(text):
        return None
    return text


def _data(payload) -> dict | None:
    if isinstance(payload, list):
        return {"results": payload}
    if not isinstance(payload, dict):
        return None
    inner = payload.get("data")
    if isinstance(inner, dict):
        return inner
    return payload


def _results(payload) -> list | None:
    """None when this is not a list response. [] when it is and lists nothing."""
    data = _data(payload)
    if data is None:
        return None
    for key in ("results", "prices", "historicals", "earnings"):
        rows = data.get(key)
        if isinstance(rows, list):
            return rows
    return None


def _per_symbol(payload) -> dict[str, object] | None:
    """A map of ticker to one raw response. A single MCP response is not a map."""
    if not isinstance(payload, dict) or not payload:
        return None
    if any(key in payload for key in ("data", "results", "prices", "historicals", "earnings", "guide")):
        return None
    out: dict[str, object] = {}
    for key, value in payload.items():
        symbol = _symbol(key)
        if symbol is None or not isinstance(value, (dict, list)):
            return None
        out[symbol] = value
    return out


def _timing(value) -> str | None:
    text = str(value or "").lower().strip()
    if text in ("am", "pm"):
        return text
    return None


def _eps_pair(row: dict) -> tuple[Decimal | None, Decimal | None, date | None]:
    """(actual, estimate, report date). Missing stays None. Neither side is filled from the other."""
    eps = row.get("eps") if isinstance(row.get("eps"), dict) else {}
    quarterly = row.get("quarterly") if isinstance(row.get("quarterly"), dict) else {}
    report = row.get("report") if isinstance(row.get("report"), dict) else {}
    actual = _decimal(eps.get("actual") if eps else None)
    estimate = _decimal(eps.get("estimate") if eps else None)
    if actual is None:
        actual = _decimal(quarterly.get("eps"))
        if actual is None:
            actual = _decimal(row.get("eps") if not isinstance(row.get("eps"), dict) else None)
    if estimate is None:
        for key in ("eps_estimate", "estimated_eps", "eps_estimated", "estimate"):
            estimate = _decimal(quarterly.get(key))
            if estimate is not None:
                break
        if estimate is None:
            estimate = _decimal(row.get("eps_estimate") or row.get("estimate"))
    day = _parse_date(report.get("date") or row.get("report_period") or row.get("period") or row.get("date"))
    return actual, estimate, day


def earnings_quarters(payload, symbol: str) -> list[dict] | None:
    """Past and upcoming quarters for one symbol. None means the payload cannot be read."""
    if payload is None:
        return None
    rows = _results(payload)
    if rows is None:
        return None
    want = symbol.upper()
    found = []
    saw_other = False
    saw_self = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        named = _symbol(row.get("symbol") or row.get("ticker"))
        if named is not None and named != want:
            saw_other = True
            continue
        if named == want:
            saw_self = True
        actual, estimate, day = _eps_pair(row)
        if day is None:
            continue
        found.append({"date": day, "actual": actual, "estimate": estimate})
    # A response that names other tickers and not this one was not this symbol's read.
    if saw_other and not saw_self:
        return None
    found.sort(key=lambda item: item["date"])
    return found


def calendar_events(payload) -> tuple[list[dict], list[str]] | None:
    """(events, skipped tickers). One event per symbol, the soonest report. None when unreadable."""
    rows = _results(payload)
    if rows is None:
        return None
    by_symbol: dict[str, list[dict]] = {}
    skipped = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = _symbol(row.get("symbol") or row.get("ticker"))
        report = row.get("report") if isinstance(row.get("report"), dict) else {}
        day = _parse_date(report.get("date") or row.get("date"))
        if symbol is None or day is None:
            raw = str(row.get("symbol") or row.get("ticker") or "").strip().upper()
            if raw and raw not in skipped:
                skipped.append(raw)
            continue
        by_symbol.setdefault(symbol, []).append({
            "symbol": symbol,
            "report_date": day,
            "timing": _timing(report.get("timing") or row.get("timing")),
        })
    events = []
    for symbol, group in sorted(by_symbol.items()):
        soonest = min(item["report_date"] for item in group)
        same_day = [item for item in group if item["report_date"] == soonest]
        timings = {item["timing"] for item in same_day}
        timing = same_day[0]["timing"] if len(timings) == 1 else None
        events.append({
            "symbol": symbol,
            "report_date": soonest,
            "timing": timing,
            "timing_disagrees": len(timings) > 1,
        })
    return events, skipped


def _one_bar(row: dict, symbol: str) -> dict | None:
    if not isinstance(row, dict):
        return None
    ticker = _symbol(row.get("ticker") or row.get("symbol"))
    if ticker is not None and ticker != symbol:
        return None
    if row.get("interpolated") is True or str(row.get("interpolated") or "").lower() == "true":
        return None
    day = _parse_date(row.get("begins_at") or row.get("time") or row.get("date") or row.get("session"))
    if day is None or session_close_at(day) is None:
        return None
    volume = row.get("volume")
    if volume is not None and str(volume).strip() != "":
        vol = _decimal(volume)
        if vol is None or vol <= 0:
            return None
    high = row.get("high_price") if row.get("high_price") is not None else row.get("high")
    close = row.get("close_price") if row.get("close_price") is not None else row.get("close")
    return {"day": day, "high": _decimal(high), "close": _decimal(close)}


def _historical_rows(payload, symbol: str) -> list | None:
    if payload is None:
        return None
    rows = _results(payload)
    if rows is None:
        return None
    flat = []
    want = symbol.upper()
    saw_other = False
    saw_self = False
    for item in rows:
        if not isinstance(item, dict):
            continue
        named = _symbol(item.get("symbol") or item.get("ticker"))
        nested = item.get("historicals")
        if named is not None and named != want:
            saw_other = True
            continue
        if named == want or named is None:
            saw_self = True
        if isinstance(nested, list):
            flat.extend(row for row in nested if isinstance(row, dict))
            continue
        flat.append(item)
    if saw_other and not saw_self:
        return None
    return flat


def daily_bars(payload, symbol: str) -> dict[date, dict] | None:
    """Regular session bars keyed by session date. None when the payload cannot be read."""
    rows = _historical_rows(payload, symbol)
    if rows is None:
        return None
    found: dict[date, dict] = {}
    for row in rows:
        bar = _one_bar(row, symbol)
        if bar is None:
            continue
        previous = found.get(bar["day"])
        if previous is None or (previous.get("high") is None and bar.get("high") is not None):
            found[bar["day"]] = bar
    return found


def bars_for(doc: dict, symbol: str) -> dict[date, dict] | None:
    """Bars for one symbol from a batched response or a per-symbol map. None when nothing was saved."""
    raw = doc.get("get_equity_historicals")
    if raw is None:
        raw = doc.get("historicals")
    mapped = _per_symbol(raw)
    if mapped is not None:
        if symbol not in mapped:
            return None
        return daily_bars(mapped[symbol], symbol)
    if raw is None:
        return None
    return daily_bars(raw, symbol)


def history_for(doc: dict, symbol: str) -> tuple[list[dict] | None, str | None]:
    """Robinhood quarters, else Financial Datasets when Robinhood was not saved or cannot be read.

    An empty Robinhood list is a real read (no quarters), not a reason to switch sources.
    """
    raw = doc.get("get_earnings_results")
    if raw is None:
        raw = doc.get("earnings")
    mapped = _per_symbol(raw)
    rh = None
    if mapped is not None:
        if symbol in mapped:
            rh = earnings_quarters(mapped[symbol], symbol)
    elif raw is not None:
        rh = earnings_quarters(raw, symbol)
    if rh is not None:
        return rh, "robinhood_earnings_results"
    fd_raw = doc.get("get_earnings")
    fd_mapped = _per_symbol(fd_raw)
    if fd_mapped is not None and symbol in fd_mapped:
        fd = earnings_quarters(fd_mapped[symbol], symbol)
        if fd is not None:
            return fd, "financialdatasets_earnings"
    if fd_raw is not None and fd_mapped is None:
        fd = earnings_quarters(fd_raw, symbol)
        if fd is not None:
            return fd, "financialdatasets_earnings"
    if raw is None and fd_raw is None:
        return None, None
    return None, None


def beat_window(quarters: list[dict] | None, report_date: date, n: int) -> dict:
    """Last n quarters strictly before the report that have both an EPS and an estimate.

    A beat is actual > estimate. A tie is not a beat. A quarter missing either number
    is not counted and is not filled in. The upcoming report is not part of the history.
    """
    if quarters is None:
        return {"beats": None, "compared": None, "flag": False, "missing": "earnings_history_missing"}
    comparable = []
    seen: dict[date, list[tuple[Decimal, Decimal]]] = {}
    for row in quarters:
        if row["date"] >= report_date:
            continue
        if row["actual"] is None or row["estimate"] is None:
            continue
        seen.setdefault(row["date"], []).append((row["actual"], row["estimate"]))
    for day in sorted(seen):
        pairs = seen[day]
        if len(pairs) > 1 and len({pair for pair in pairs}) > 1:
            return {
                "beats": None,
                "compared": None,
                "flag": False,
                "missing": "earnings_history_disagrees",
            }
        actual, estimate = pairs[0]
        comparable.append(actual > estimate)
    if len(comparable) < n:
        return {
            "beats": sum(1 for beat in comparable if beat),
            "compared": len(comparable),
            "flag": False,
            "missing": f"comparable_quarters_{len(comparable)}_of_{n}",
        }
    last = comparable[-n:]
    return {
        "beats": sum(1 for beat in last if beat),
        "compared": n,
        "flag": all(last),
        "missing": None,
    }


def prior_rth_move(report_date: date, bars: dict[date, dict] | None) -> tuple[Decimal | None, str | None]:
    """Close-to-close of the session before the report versus the session before that. No bar, no number."""
    if bars is None:
        return None, "bars_missing"
    prior = prior_session(report_date)
    if prior is None:
        return None, "no_prior_session"
    before = prior_session(prior)
    if before is None:
        return None, "no_prior_rth_bar"
    later = bars.get(prior)
    earlier = bars.get(before)
    if later is None or earlier is None or later.get("close") is None or earlier.get("close") is None:
        return None, "no_prior_rth_bar"
    base = earlier["close"]
    if base <= 0:
        return None, "no_prior_rth_bar"
    return (later["close"] - base) / base, None


def off_52w(report_date: date, bars: dict[date, dict] | None) -> tuple[Decimal | None, str | None]:
    """(high - prior close) / high over the 365 days ending the prior session.

    The prior session's bar has to be there. A bar within 10 days of the window
    start shows the series reaches back a year. From 2026-01-01 on, every session
    in the window has to be present: the calendar lists those holidays, so a gap
    is a missing bar, not a session that did not happen. Earlier holidays are not
    in the calendar, so those dates are not required one by one. A bar with no
    high drops the percent. The high is never filled from a close.
    """
    if bars is None:
        return None, "bars_missing"
    prior = prior_session(report_date)
    if prior is None:
        return None, "no_prior_session"
    window_start = prior - YEAR
    if prior not in bars or bars[prior].get("close") is None:
        return None, "no_bar_for_prior_session"
    if not any(window_start - YEAR_SLACK <= day <= window_start for day in bars):
        return None, "bars_short_of_52w"
    floor = window_start if window_start > CALENDAR_START else CALENDAR_START
    cursor = prior
    for _ in range(400):
        if cursor < floor:
            break
        if cursor not in bars:
            return None, "bars_short_of_52w"
        nxt = prior_session(cursor)
        if nxt is None:
            return None, "bars_short_of_52w"
        cursor = nxt
    else:
        return None, "bars_short_of_52w"
    in_window = [bars[day] for day in bars if window_start <= day <= prior]
    if any(bar.get("high") is None for bar in in_window):
        return None, "bar_missing_high"
    if not in_window:
        return None, "bars_short_of_52w"
    high = max(bar["high"] for bar in in_window)
    close = bars[prior]["close"]
    if high <= 0 or close is None:
        return None, "bar_missing_high"
    return (high - close) / high, None


def _known_symbols(doc: dict) -> set[str] | None:
    """None when the payload did not say which symbols are already in public.symbols."""
    if "in_symbols" not in doc:
        return None
    raw = doc.get("in_symbols")
    if not isinstance(raw, list):
        raise PayloadError("in_symbols must be a list of tickers")
    found = set()
    for item in raw:
        symbol = _symbol(item)
        if symbol is None:
            raise PayloadError(f"in_symbols has a value that is not a ticker: {item!r}")
        found.add(symbol)
    return found


def _sessions_filter(doc: dict) -> set[date] | None:
    raw = doc.get("sessions")
    if raw is None:
        return None
    if not isinstance(raw, list) or not raw:
        raise PayloadError("sessions must be a list of YYYY-MM-DD")
    found = set()
    for item in raw:
        day = _parse_date(item)
        if day is None:
            raise PayloadError(f"sessions has a value that is not a date: {item!r}")
        found.add(day)
    return found


def _flag_name(n: int) -> str:
    return "beat_history_6of6" if n == BEATS_N else f"beat_history_{n}of{n}"


def rank_events(events: list[dict], doc: dict, *, beats_n: int, known: set[str] | None) -> dict:
    """One row per calendar name except PLTR. Sort puts a verified 6/6 beat history first."""
    session_days = _sessions_filter(doc)
    excluded = []
    skipped = []
    rows = []
    flag_name = _flag_name(beats_n)
    for event in events:
        symbol = event["symbol"]
        if session_days is not None and event["report_date"] not in session_days:
            continue
        if symbol in EXCLUDED:
            excluded.append(symbol)
            continue
        quarters, source = history_for(doc, symbol)
        window = beat_window(quarters, event["report_date"], beats_n)
        bars = bars_for(doc, symbol)
        move, move_why = prior_rth_move(event["report_date"], bars)
        off, off_why = off_52w(event["report_date"], bars)
        six = bool(window["flag"]) and beats_n == BEATS_N
        # When --beats is not 6, still record whether the last 6 comparable quarters were beats.
        if beats_n != BEATS_N and quarters is not None:
            six = bool(beat_window(quarters, event["report_date"], BEATS_N)["flag"])
        quality = off is not None and off >= QD_OFF
        crash = (
            event["timing"] == "am"
            and off is not None and off >= CRASH_OFF
            and move is not None and move <= CRASH_PRIOR
        )
        missing = []
        if window["missing"]:
            missing.append(window["missing"])
        if event.get("timing_disagrees"):
            missing.append("calendar_timing_disagrees")
        if off_why and off_why not in missing:
            missing.append(off_why)
        elif move_why and move_why not in missing and move_why != off_why:
            missing.append(move_why)
        label = "no_history" if window["missing"] else "screened"
        flags = []
        if six:
            flags.append("beat_history_6of6")
        if quality:
            flags.append("quality_drawdown")
        if crash:
            flags.append("crash_dump_am")
        in_symbols = None if known is None else symbol in known
        rows.append({
            "symbol": symbol,
            "report_date": event["report_date"].isoformat(),
            "timing": event["timing"],
            "beats": window["beats"],
            "compared": window["compared"],
            "n": beats_n,
            "off_52w": None if off is None else _q6(off),
            "prior_rth": None if move is None else _q6(move),
            "in_symbols": in_symbols,
            "flags": {
                "beat_history_6of6": six,
                "quality_drawdown": quality,
                "crash_dump_am": crash,
            },
            "flag_list": flags,
            "label": label,
            "missing": missing,
            "history_source": source,
            "_sort_beats": -1 if window["beats"] is None else window["beats"],
            "_flag_name": flag_name,
        })
    rows.sort(key=lambda row: (
        0 if row["flags"]["beat_history_6of6"] else 1,
        0 if row["label"] != "no_history" else 1,
        -row["_sort_beats"],
        0 if row["flags"]["crash_dump_am"] else 1,
        0 if row["flags"]["quality_drawdown"] else 1,
        row["report_date"],
        row["symbol"],
    ))
    for row in rows:
        row.pop("_sort_beats", None)
        row.pop("_flag_name", None)
    return {"rows": rows, "excluded": sorted(set(excluded)), "skipped": skipped}


def _counts(rows: list[dict]) -> dict:
    if not rows:
        outside = 0
    elif any(row["in_symbols"] is None for row in rows):
        outside = None
    else:
        outside = sum(1 for row in rows if row["in_symbols"] is False)
    return {
        "ranked": len(rows),
        "outside_symbols": outside,
        "beat_history_6of6": sum(1 for row in rows if row["flags"]["beat_history_6of6"]),
        "quality_drawdown": sum(1 for row in rows if row["flags"]["quality_drawdown"]),
        "crash_dump_am": sum(1 for row in rows if row["flags"]["crash_dump_am"]),
        "no_history": sum(1 for row in rows if row["label"] == "no_history"),
    }


def coverage_line(counts: dict) -> str:
    outside = counts["outside_symbols"]
    outside_text = "missing" if outside is None else str(outside)
    return (
        f"coverage ranked={counts['ranked']} outside_symbols={outside_text} "
        f"beat_history_6of6={counts['beat_history_6of6']} "
        f"quality_drawdown={counts['quality_drawdown']} "
        f"crash_dump_am={counts['crash_dump_am']} "
        f"no_history={counts['no_history']} writer={WRITER}"
    )


def _name_line(row: dict) -> str:
    beats = "missing" if row["beats"] is None or row["compared"] is None else f"{row['beats']}/{row['compared']}"
    timing = row["timing"] or "missing"
    in_symbols = "missing" if row["in_symbols"] is None else ("true" if row["in_symbols"] else "false")
    flags = ",".join(row["flag_list"]) if row["flag_list"] else "none"
    missing = ",".join(row["missing"]) if row["missing"] else "none"
    off = "missing" if row["off_52w"] is None else row["off_52w"]
    prior = "missing" if row["prior_rth"] is None else row["prior_rth"]
    return (
        f"{row['symbol']} {row['report_date']} {timing} beats={beats} "
        f"off_52w={off} prior_rth={prior} in_symbols={in_symbols} "
        f"flags={flags} label={row['label']} missing={missing}"
    )


def sheet_text(rows: list[dict], excluded: list[str], counts: dict, sessions: list[date] | None) -> tuple[str, str]:
    """Topic and reason for one research_queue row. The reason starts with the coverage line."""
    dates = sorted({_parse_date(row["report_date"]) for row in rows if _parse_date(row["report_date"])})
    if not dates and sessions:
        dates = sorted(sessions)
    if not dates:
        when = "Earnings"
    elif len(dates) == 1:
        when = _short(dates[0])
    else:
        when = f"{_short(dates[0])}-{_short(dates[-1])}"
    outside = counts["outside_symbols"]
    outside_bit = "outside public.symbols not counted" if outside is None else f"{outside} outside public.symbols"
    topic = (
        f"{when} earnings sheet ({WRITER}): {counts['beat_history_6of6']} with 6/6 beats, {outside_bit}"
    )
    lines = [coverage_line(counts), PLAIN]
    if excluded:
        lines.append("excluded " + " ".join(excluded))
    lines.extend(_name_line(row) for row in rows)
    if not rows:
        lines.append("no calendar names")
    return topic, "\n".join(lines)


def load_calendar(doc: dict) -> tuple[list[dict], list[str]]:
    raw = doc.get("get_earnings_calendar")
    if raw is None:
        raw = doc.get("calendar")
    if raw is None:
        raise PayloadError("payload has no get_earnings_calendar response")
    parsed = calendar_events(raw)
    if parsed is None:
        raise PayloadError("get_earnings_calendar response has no results array")
    return parsed


def rank_document(doc: dict, *, beats_n: int = BEATS_N, known: set[str] | None | object = ...) -> dict:
    """Rank doc's calendar. `known` overrides doc['in_symbols'] (the execute path passes the ledger)."""
    if not isinstance(doc, dict):
        raise PayloadError("payload must be a JSON object")
    if beats_n < 1 or beats_n > BEATS_MAX:
        raise PayloadError(f"beats must be from 1 to {BEATS_MAX}")
    events, skipped = load_calendar(doc)
    if known is ...:
        known = _known_symbols(doc)
    ranked = rank_events(events, doc, beats_n=beats_n, known=known)
    ranked["skipped"] = sorted(set(ranked["skipped"]) | set(skipped))
    sessions = _sessions_filter(doc)
    counts = _counts(ranked["rows"])
    topic, reason = sheet_text(
        ranked["rows"], ranked["excluded"], counts,
        None if sessions is None else sorted(sessions),
    )
    symbols = [row["symbol"] for row in ranked["rows"]]
    return {
        "topic": topic,
        "reason": reason,
        "rows": ranked["rows"],
        "excluded": ranked["excluded"],
        "skipped": ranked["skipped"],
        "counts": counts,
        "ranked_symbols": symbols,
        "calendar_symbols": symbols,
        "args": {
            "topic": topic,
            "reason": reason,
            "ranked_symbols": symbols,
            "calendar_symbols": symbols,
        },
    }


def sheet_sql(args: dict) -> str:
    body = json.dumps(args, separators=(",", ":"), sort_keys=True)
    tag = "es"
    while f"${tag}$" in body:
        tag += "x"
    return f"select public.steward_write_earnings_sheet(${tag}${body}${tag}$::jsonb);"


def _symbols_present(args: dict):
    from steward_rpc import call
    return call(STEWARD, "steward_symbols_present", args, idempotent=True)


def _write_sheet(args: dict):
    from steward_rpc import call
    return call(STEWARD, "steward_write_earnings_sheet", args)


def _present_set(got) -> set[str]:
    if not isinstance(got, dict) or not isinstance(got.get("present"), list):
        raise PayloadError("steward_symbols_present did not return present")
    found = set()
    for item in got["present"]:
        symbol = _symbol(item)
        if symbol is not None:
            found.add(symbol)
    return found


def rank_payload(doc: dict, *, execute: bool = False, beats_n: int = BEATS_N, caller=None) -> dict:
    """Print-shaped result. --execute reads public.symbols, then ranks, then writes."""
    known = ...
    if execute:
        events, _skipped = load_calendar(doc)
        session_days = _sessions_filter(doc)
        symbols = sorted({
            event["symbol"] for event in events
            if event["symbol"] not in EXCLUDED and (
                session_days is None or event["report_date"] in session_days
            )
        })
        got = (
            caller("steward_symbols_present", {"symbols": symbols}, idempotent=True)
            if caller is not None
            else _symbols_present({"symbols": symbols})
        )
        known = _present_set(got)
    ranked = rank_document(doc, beats_n=beats_n, known=known)
    out = {
        "topic": ranked["topic"],
        "reason": ranked["reason"],
        "rows": ranked["rows"],
        "excluded": ranked["excluded"],
        "counts": ranked["counts"],
        "sql": sheet_sql(ranked["args"]),
    }
    if execute:
        wrote = (
            caller("steward_write_earnings_sheet", ranked["args"], idempotent=False)
            if caller is not None
            else _write_sheet(ranked["args"])
        )
        out["wrote"] = wrote
    return out


def plan_calls(now: datetime, sessions: int) -> dict:
    """The Robinhood calls for the next `sessions` NYSE sessions, plus the optional earnings alternate."""
    days = next_sessions(sessions, now)
    window = calendar_window(days)
    start = datetime.combine(days[0] - timedelta(days=420), time(0, 0), tzinfo=timezone.utc)
    start_time = start.isoformat().replace("+00:00", "Z")
    return {
        "writer": WRITER,
        "sessions": [day.isoformat() for day in days],
        "calls": [
            {
                "tool": "get_earnings_calendar",
                "arguments": window,
                "note": "high-cap names only. Rank every symbol this returns. Do not drop a name because it is absent from public.symbols.",
            },
            {
                "tool": "get_earnings_results",
                "arguments": {"symbol": "<each calendar symbol except PLTR>"},
                "after": ["get_earnings_calendar"],
                "note": "one call per symbol. A beat is actual EPS greater than the estimate. Do not fill a missing actual or estimate.",
            },
            {
                "tool": "get_equity_historicals",
                "arguments": {
                    "symbols": "<calendar symbols except PLTR, at most 10 per call>",
                    "start_time": start_time,
                    "interval": "day",
                    "bounds": "regular",
                    "adjustment_type": "split",
                },
                "after": ["get_earnings_calendar"],
                "note": "regular daily bars. Skip a bar marked interpolated. The date on the bar is the session date. Used for the 52-week high and the prior session close-to-close.",
            },
            {
                "tool": "get_earnings",
                "provider": "financial_datasets",
                "arguments": {"ticker": "<a symbol whose get_earnings_results response was unreadable>"},
                "note": "optional. Used only when that symbol's Robinhood history cannot be read. Same rule: both EPS and estimate, or the quarter does not count.",
            },
        ],
        "then": "Save the raw responses and public.symbols for those tickers as in_symbols, then run rank payload.json",
    }


def _parse_now(text: str | None) -> datetime:
    if not text:
        return datetime.now(timezone.utc)
    raw = text.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"--now must be an ISO timestamp, got {text}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="earnings_sheet.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="Robinhood calls for the next NYSE sessions")
    plan.add_argument("--sessions", type=int, default=2, help="how many NYSE sessions the calendar should cover (default 2)")
    plan.add_argument("--now", help="ISO timestamp used as the clock (default: now)")
    rank = sub.add_parser("rank", help="rank a saved calendar payload and print the research_queue row")
    rank.add_argument("payload", help="JSON file: calendar, per-symbol earnings, bars, optional in_symbols")
    rank.add_argument("--execute", action="store_true", help="write the row and insert calendar symbols missing from public.symbols")
    rank.add_argument("--beats", type=int, default=BEATS_N, help="comparable quarters in the beat window (default 6)")
    args = ap.parse_args(argv)
    if args.command == "plan":
        if args.sessions < 1 or args.sessions > 10:
            print(json.dumps({"error": "plan --sessions must be from 1 to 10"}))
            return 1
        try:
            out = plan_calls(_parse_now(args.now), args.sessions)
        except (ValueError, OSError) as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
            return 1
        print(json.dumps(out))
        return 0
    try:
        doc = json.loads(open(args.payload).read())
        out = rank_payload(doc, execute=bool(args.execute), beats_n=args.beats)
    except (OSError, ValueError, PayloadError) as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
        return 1
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
        return 1
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
