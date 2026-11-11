"""The nightly earnings sheet ranks the full high-cap calendar, not only public.symbols.

AAON in the fixture is the lesson 245 case: outside the symbol list, six verified
beats, and it has to be on the sheet. Prices here are the fixture's inputs.
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCRIPT = HERE / "quantanamo" / "earnings_sheet.py"
SCHEMA = ROOT / "supabase" / "schemas" / "98_earnings_sheet_coverage.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20261111190000_earnings_sheet_coverage.sql"
EDGE = ROOT / "supabase" / "functions" / "steward-rpc" / "index.ts"
REPORT = "2026-11-12"


def _load():
    spec = importlib.util.spec_from_file_location("earnings_sheet", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _quarter(symbol: str, day: str, actual, estimate) -> dict:
    return {
        "symbol": symbol,
        "eps": {"actual": actual, "estimate": estimate},
        "report": {"date": day, "timing": "pm", "verified": True},
    }


def _beats(symbol: str, n: int, *, miss_at: int | None = None, extra_old_miss: bool = False) -> list[dict]:
    """n comparable quarters before REPORT. miss_at is an index in that window (0 = oldest)."""
    rows = []
    if extra_old_miss:
        rows.append(_quarter(symbol, "2024-01-15", "0.10", "0.50"))
    start = date(2025, 1, 15)
    for i in range(n):
        day = (start + timedelta(days=80 * i)).isoformat()
        if miss_at is not None and i == miss_at:
            rows.append(_quarter(symbol, day, "0.10", "0.50"))
        else:
            rows.append(_quarter(symbol, day, "1.20", "1.00"))
    rows.append(_quarter(symbol, REPORT, None, "1.50"))
    return rows


def _event(symbol: str, timing: str, day: str = REPORT) -> dict:
    return {
        "symbol": symbol,
        "year": 2026,
        "quarter": 3,
        "eps": {"estimate": "1.50", "actual": None},
        "report": {"date": day, "timing": timing, "verified": True},
    }


def _history(symbol: str, rows: list[dict]) -> dict:
    return {"data": {"results": rows}}


def _year_bars(mod, symbol: str, report: date, *, high: str, last_close: str,
               before_close: str, interpolated_high: str | None = None) -> dict:
    """One bar on every required session, plus a bar at the start of the 365-day window."""
    prior = mod.prior_session(report)
    before = mod.prior_session(prior)
    window_start = prior - timedelta(days=365)
    witness = window_start
    while mod.session_close_at(witness) is None:
        witness -= timedelta(days=1)
    days = {witness}
    cursor = prior
    floor = window_start if window_start > mod.CALENDAR_START else mod.CALENDAR_START
    while cursor >= floor:
        days.add(cursor)
        cursor = mod.prior_session(cursor)
    bars = []
    for day in sorted(days):
        if day == prior:
            close = last_close
        elif day == before:
            close = before_close
        else:
            close = high
        bars.append({
            "begins_at": f"{day.isoformat()}T00:00:00Z",
            "open_price": close,
            "high_price": high,
            "low_price": close,
            "close_price": close,
            "volume": 1000,
        })
    if interpolated_high is not None:
        bars.append({
            "begins_at": f"{prior.isoformat()}T00:00:00Z",
            "open_price": interpolated_high,
            "high_price": interpolated_high,
            "close_price": interpolated_high,
            "volume": 1000,
            "interpolated": True,
        })
    return {"data": {"results": [{"symbol": symbol, "historicals": bars}]}}


def _aaon_doc(mod=None, *, bars=None, in_symbols=("ENS",), history=None) -> dict:
    doc = {
        "sessions": ["2026-11-12", "2026-11-13"],
        "in_symbols": list(in_symbols) if in_symbols is not None else None,
        "get_earnings_calendar": {"data": {"results": [
            _event("AAON", "am"),
            _event("ENS", "pm", "2026-11-13"),
            _event("PLTR", "pm"),
            _event("GIB", "am"),
            {"symbol": "NOT A TICKER", "report": {"date": REPORT, "timing": "am"}},
        ]}},
        "get_earnings_results": {
            "AAON": _history("AAON", history if history is not None else _beats("AAON", 6, extra_old_miss=True)),
            "ENS": _history("ENS", _beats("ENS", 6, miss_at=5)),
            "GIB": _history("GIB", _beats("GIB", 4)),
            "PLTR": _history("PLTR", _beats("PLTR", 6)),
        },
    }
    if in_symbols is None:
        del doc["in_symbols"]
    if bars is not None:
        doc["get_equity_historicals"] = bars
    return doc


class EarningsSheet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def test_plan_after_the_close_is_the_next_two_sessions(self):
        mod = self.mod
        # 21:30 UTC on 2026-11-11 is 16:30 ET, after the close.
        out = mod.plan_calls(datetime(2026, 11, 11, 21, 30, tzinfo=timezone.utc), 2)
        self.assertEqual(out["sessions"], ["2026-11-12", "2026-11-13"])
        calendar = out["calls"][0]
        self.assertEqual(calendar["tool"], "get_earnings_calendar")
        self.assertEqual(calendar["arguments"], {
            "start_date": "2026-11-12",
            "days": 2,
            "filter": "high_market_cap",
        })
        self.assertEqual(out["calls"][1]["tool"], "get_earnings_results")
        self.assertIn("PLTR", out["calls"][1]["arguments"]["symbol"])
        self.assertEqual(out["calls"][2]["arguments"]["bounds"], "regular")
        self.assertEqual(out["calls"][2]["arguments"]["interval"], "day")
        self.assertEqual(out["calls"][2]["arguments"]["adjustment_type"], "split")
        self.assertTrue(out["calls"][2]["arguments"]["start_time"].endswith("Z"))
        self.assertLess(out["calls"][2]["arguments"]["start_time"], "2026-11-12")

    def test_plan_friday_morning_includes_monday(self):
        # 15:00 UTC Friday is 10:00 ET, before the close. The next session after Friday is Monday.
        out = self.mod.plan_calls(datetime(2026, 11, 13, 15, 0, tzinfo=timezone.utc), 2)
        self.assertEqual(out["sessions"], ["2026-11-13", "2026-11-16"])
        self.assertEqual(out["calls"][0]["arguments"]["start_date"], "2026-11-13")
        self.assertEqual(out["calls"][0]["arguments"]["days"], 4)

    def test_plan_friday_after_the_close_starts_monday(self):
        out = self.mod.plan_calls(datetime(2026, 11, 13, 21, 30, tzinfo=timezone.utc), 2)
        self.assertEqual(out["sessions"], ["2026-11-16", "2026-11-17"])
        self.assertEqual(out["calls"][0]["arguments"]["days"], 2)

    def test_aaon_outside_universe_ranks_with_six_beats(self):
        mod = self.mod
        out = mod.rank_document(_aaon_doc())
        symbols = [row["symbol"] for row in out["rows"]]
        self.assertEqual(symbols[0], "AAON")
        self.assertNotIn("PLTR", symbols)
        self.assertEqual(out["excluded"], ["PLTR"])
        self.assertIn("NOT A TICKER", out["skipped"])
        aaon = out["rows"][0]
        self.assertEqual(aaon["beats"], 6)
        self.assertEqual(aaon["compared"], 6)
        self.assertTrue(aaon["flags"]["beat_history_6of6"])
        self.assertFalse(aaon["in_symbols"])
        self.assertEqual(aaon["label"], "screened")
        self.assertIsNone(aaon["off_52w"])
        self.assertIn("bars_missing", aaon["missing"])
        ens = next(row for row in out["rows"] if row["symbol"] == "ENS")
        self.assertEqual(ens["beats"], 5)
        self.assertEqual(ens["compared"], 6)
        self.assertFalse(ens["flags"]["beat_history_6of6"])
        self.assertTrue(ens["in_symbols"])
        self.assertEqual(ens["label"], "screened")
        gib = next(row for row in out["rows"] if row["symbol"] == "GIB")
        self.assertEqual(gib["label"], "no_history")
        self.assertEqual(gib["beats"], 4)
        self.assertEqual(gib["compared"], 4)
        self.assertFalse(gib["flags"]["beat_history_6of6"])
        self.assertEqual(symbols.index("AAON") < symbols.index("ENS") < symbols.index("GIB"), True)
        self.assertEqual(out["counts"]["outside_symbols"], 2)
        self.assertEqual(out["counts"]["beat_history_6of6"], 1)
        self.assertEqual(out["counts"]["no_history"], 1)
        self.assertTrue(out["reason"].startswith("coverage ranked=3 outside_symbols=2 "))
        self.assertIn("1 with 6/6 beats, 2 outside public.symbols", out["topic"])
        self.assertNotIn("PLTR ", out["reason"].split("excluded PLTR", 1)[1])
        for key in ("ranked", "outside_symbols", "beat_history_6of6", "quality_drawdown", "crash_dump_am", "no_history"):
            found = re.search(rf"{key}=([0-9]+)", out["reason"])
            self.assertIsNotNone(found, key)
            self.assertEqual(int(found.group(1)), out["counts"][key], key)

    def test_missing_symbol_list_does_not_count_as_zero_outside(self):
        out = self.mod.rank_document(_aaon_doc(in_symbols=None))
        self.assertIsNone(out["counts"]["outside_symbols"])
        self.assertIn("outside_symbols=missing", out["reason"].split("\n", 1)[0])
        self.assertIsNone(re.search(r"outside_symbols=([0-9]+)", out["reason"]))
        self.assertIn("outside public.symbols not counted", out["topic"])
        aaon = out["rows"][0]
        self.assertIsNone(aaon["in_symbols"])
        self.assertIn("in_symbols=missing", out["reason"])

    def test_missing_estimate_is_not_a_beat_and_not_a_zero(self):
        rows = _beats("AAON", 5)
        rows.insert(0, _quarter("AAON", "2024-11-01", "2.00", None))
        out = self.mod.rank_document(_aaon_doc(history=rows, in_symbols=[]))
        aaon = next(row for row in out["rows"] if row["symbol"] == "AAON")
        self.assertEqual(aaon["label"], "no_history")
        self.assertEqual(aaon["beats"], 5)
        self.assertEqual(aaon["compared"], 5)
        self.assertFalse(aaon["flags"]["beat_history_6of6"])

    def test_tie_is_not_a_beat(self):
        rows = _beats("AAON", 6)
        rows[0] = _quarter("AAON", rows[0]["report"]["date"], "1.00", "1.00")
        out = self.mod.rank_document(_aaon_doc(history=rows))
        aaon = next(row for row in out["rows"] if row["symbol"] == "AAON")
        self.assertEqual(aaon["beats"], 5)
        self.assertEqual(aaon["compared"], 6)
        self.assertFalse(aaon["flags"]["beat_history_6of6"])
        self.assertEqual(aaon["label"], "screened")

    def test_disagreeing_quarters_stay_missing(self):
        day = "2025-06-01"
        rows = [
            _quarter("AAON", day, "1.20", "1.00"),
            _quarter("AAON", day, "0.10", "1.00"),
        ]
        out = self.mod.rank_document(_aaon_doc(history=rows))
        aaon = next(row for row in out["rows"] if row["symbol"] == "AAON")
        self.assertIsNone(aaon["beats"])
        self.assertEqual(aaon["label"], "no_history")
        self.assertIn("earnings_history_disagrees", aaon["missing"])

    def test_financial_datasets_fills_only_an_unreadable_robinhood_history(self):
        mod = self.mod
        doc = _aaon_doc()
        del doc["get_earnings_results"]["AAON"]
        doc["get_earnings"] = {"AAON": {"data": {"earnings": [
            {"ticker": "AAON", "report_period": day, "quarterly": {"eps": "1.20", "eps_estimate": "1.00"}}
            for day in ("2025-01-15", "2025-04-15", "2025-07-15", "2025-10-15", "2026-01-15", "2026-04-15")
        ]}}}
        out = mod.rank_document(doc)
        aaon = next(row for row in out["rows"] if row["symbol"] == "AAON")
        self.assertTrue(aaon["flags"]["beat_history_6of6"])
        self.assertEqual(aaon["history_source"], "financialdatasets_earnings")

        doc["get_earnings_results"]["AAON"] = {"data": {"results": []}}
        empty = mod.rank_document(doc)
        aaon = next(row for row in empty["rows"] if row["symbol"] == "AAON")
        self.assertEqual(aaon["label"], "no_history")
        self.assertEqual(aaon["history_source"], "robinhood_earnings_results")
        self.assertEqual(aaon["beats"], 0)

        # A file of someone else's quarters is not a zero for this symbol, and it must not
        # win over the Financial Datasets read either: the empty Robinhood list above did.
        merged = _aaon_doc()
        merged["get_earnings_results"] = {"data": {"results": _beats("ENS", 6)}}
        merged["get_earnings"] = doc["get_earnings"]
        other = mod.rank_document(merged)
        aaon = next(row for row in other["rows"] if row["symbol"] == "AAON")
        self.assertTrue(aaon["flags"]["beat_history_6of6"])
        self.assertEqual(aaon["history_source"], "financialdatasets_earnings")

    def test_drawdown_and_crash_use_real_bars_only(self):
        mod = self.mod
        report = date(2026, 11, 12)

        def one(symbol, timing, *, high, last, before, interpolated=None):
            doc = {
                "in_symbols": [],
                "get_earnings_calendar": {"data": {"results": [_event(symbol, timing)]}},
                "get_earnings_results": {symbol: _history(symbol, _beats(symbol, 6))},
                "get_equity_historicals": {
                    symbol: _year_bars(mod, symbol, report, high=high, last_close=last,
                                       before_close=before, interpolated_high=interpolated),
                },
            }
            row = mod.rank_document(doc)["rows"][0]
            return row

        quality = one("AAON", "pm", high="100", last="70", before="70", interpolated="999")
        self.assertEqual(quality["off_52w"], "0.300000")
        self.assertEqual(quality["prior_rth"], "0.000000")
        self.assertTrue(quality["flags"]["quality_drawdown"])
        self.assertFalse(quality["flags"]["crash_dump_am"])
        self.assertTrue(quality["flags"]["beat_history_6of6"])
        self.assertFalse(quality["in_symbols"])

        just_under = one("AAON", "pm", high="100", last="70.01", before="70.01")
        self.assertFalse(just_under["flags"]["quality_drawdown"])

        crash = one("AAON", "am", high="100", last="75", before="100")
        self.assertEqual(crash["off_52w"], "0.250000")
        self.assertEqual(crash["prior_rth"], "-0.250000")
        # prior close 75 vs before 100 is -25%, and 25% off the high. Both crash legs, not the 30% drawdown.
        self.assertTrue(crash["flags"]["crash_dump_am"])
        self.assertFalse(crash["flags"]["quality_drawdown"])

        exact_prior = one("AAON", "am", high="100", last="92", before="100")
        # 8% off the high is not 25%, so the prior -8% alone does not flag.
        self.assertEqual(exact_prior["prior_rth"], "-0.080000")
        self.assertFalse(exact_prior["flags"]["crash_dump_am"])

        # 92 vs 100 is exactly -8%. 92 vs a high of 125 is 26.4% off, so both crash legs are true.
        deep_exact = one("AAON", "am", high="125", last="92", before="100")
        self.assertEqual(deep_exact["prior_rth"], "-0.080000")
        self.assertTrue(deep_exact["flags"]["crash_dump_am"])

        same_day_pm = one("AAON", "pm", high="100", last="75", before="100")
        self.assertFalse(same_day_pm["flags"]["crash_dump_am"])
        self.assertTrue(same_day_pm["flags"]["beat_history_6of6"])

        short = {
            "in_symbols": ["AAON"],
            "get_earnings_calendar": {"data": {"results": [_event("AAON", "am")]}},
            "get_earnings_results": {"AAON": _history("AAON", _beats("AAON", 6))},
            "get_equity_historicals": {"AAON": {"data": {"results": [{"symbol": "AAON", "historicals": [
                {"begins_at": "2026-11-10T00:00:00Z", "high_price": "100", "close_price": "50", "volume": 10},
                {"begins_at": "2026-11-11T00:00:00Z", "high_price": "100", "close_price": "40", "volume": 10},
                {"begins_at": "2026-11-11T00:00:00Z", "high_price": "999", "close_price": "1", "volume": 0},
            ]}]}}},
        }
        row = mod.rank_document(short)["rows"][0]
        self.assertIsNone(row["off_52w"])
        self.assertIn("bars_short_of_52w", row["missing"])
        self.assertFalse(row["flags"]["quality_drawdown"])
        self.assertFalse(row["flags"]["crash_dump_am"])
        self.assertTrue(row["flags"]["beat_history_6of6"])

    def test_execute_trusts_the_ledger_list(self):
        seen = []

        def caller(fn, args, idempotent=False):
            seen.append((fn, idempotent, args))
            if fn == "steward_symbols_present":
                return {"present": ["ENS"]}
            if fn == "steward_write_earnings_sheet":
                return {"id": 9, "inserted_symbols": ["AAON", "GIB"], "outside_symbols": 2, "priority": 1}
            raise AssertionError(fn)

        doc = _aaon_doc(in_symbols=("AAON", "ENS", "GIB"))
        out = self.mod.rank_payload(doc, execute=True, caller=caller)
        self.assertEqual([item[0] for item in seen], ["steward_symbols_present", "steward_write_earnings_sheet"])
        self.assertTrue(seen[0][1])
        self.assertFalse(seen[1][1])
        self.assertEqual(seen[0][2]["symbols"], ["AAON", "ENS", "GIB"])
        self.assertNotIn("PLTR", seen[1][2]["calendar_symbols"])
        self.assertTrue(seen[1][2]["reason"].startswith("coverage ranked="))
        aaon = next(row for row in out["rows"] if row["symbol"] == "AAON")
        self.assertFalse(aaon["in_symbols"])
        self.assertEqual(out["counts"]["outside_symbols"], 2)
        self.assertIn("steward_write_earnings_sheet", out["sql"])
        self.assertEqual(out["wrote"]["priority"], 1)

        def refuse(fn, args, idempotent=False):
            raise AssertionError("rank without --execute must not call the ledger")

        dry = self.mod.rank_payload(doc, execute=False, caller=refuse)
        dry_aaon = next(row for row in dry["rows"] if row["symbol"] == "AAON")
        self.assertTrue(dry_aaon["in_symbols"])

    def test_cli_plan_and_rank(self):
        plan = subprocess.run(
            [sys.executable, str(SCRIPT), "plan", "--sessions", "2", "--now", "2026-11-11T21:30:00Z"],
            check=False, capture_output=True, text=True,
        )
        self.assertEqual(plan.returncode, 0, plan.stderr)
        body = json.loads(plan.stdout)
        self.assertEqual(body["calls"][0]["arguments"]["filter"], "high_market_cap")
        self.assertEqual(body["sessions"], ["2026-11-12", "2026-11-13"])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "payload.json"
            path.write_text(json.dumps(_aaon_doc()))
            rank = subprocess.run(
                [sys.executable, str(SCRIPT), "rank", str(path)],
                check=False, capture_output=True, text=True,
            )
        self.assertEqual(rank.returncode, 0, rank.stderr)
        ranked = json.loads(rank.stdout)
        self.assertEqual(ranked["rows"][0]["symbol"], "AAON")
        self.assertTrue(ranked["rows"][0]["flags"]["beat_history_6of6"])
        self.assertEqual(ranked["excluded"], ["PLTR"])
        bad = subprocess.run(
            [sys.executable, str(SCRIPT), "plan", "--sessions", "0"],
            check=False, capture_output=True, text=True,
        )
        self.assertEqual(bad.returncode, 1)

    def test_schema_is_the_migration_and_skips_retired_workers(self):
        sql = SCHEMA.read_text()
        self.assertEqual(sql, MIGRATION.read_text())
        self.assertIn("refusal:sheet: PLTR is not a candidate", sql)
        self.assertIn("source = 'earnings_sheet'", sql)
        self.assertIn("values (1, 'open'", sql)
        for fn in ("steward_symbols_present", "steward_write_earnings_sheet"):
            grant = re.search(rf"grant execute on function public\.{fn}\(jsonb\) to ([^;]+);", sql)
            self.assertIsNotNone(grant, fn)
            self.assertIn("quantanamo_worker", grant.group(1))
            self.assertNotIn("oddsborne", grant.group(1))
            self.assertNotIn("bandit", grant.group(1))
            self.assertIn(
                f"revoke all on function public.{fn}(jsonb) from public, anon, authenticated;",
                sql,
            )
        edge = EDGE.read_text()
        quant = edge[edge.index("quantanamo_worker"):edge.index("oddsborne_worker")]
        odds = edge[edge.index("oddsborne_worker"):edge.index("bandit_worker")]
        self.assertIn("'steward_write_earnings_sheet'", quant)
        self.assertIn("'steward_symbols_present'", quant)
        self.assertNotIn("steward_write_earnings_sheet", odds)
        self.assertNotIn("steward_symbols_present", odds)
        desk = (ROOT / "supabase" / "functions" / "desk-public-rest" / "index.ts").read_text()
        self.assertIn("'v_earnings_sheet_coverage'", desk)


if __name__ == "__main__":
    unittest.main()
