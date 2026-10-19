"""Pins for QUANTANAMO equity open risk (GRASSHOPPER 2026-10-19).

The SQL copy is private.equity_lot_open_risk in schema 80. These tests pin the
Python mirror the steward uses to decide what to store, and the SQL text of that rule.
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BEFORE = datetime(2026, 10, 19, 16, 0, tzinfo=timezone.utc)  # before the 2026-10-20 print


def _load():
    path = HERE / "quantanamo" / "earnings_implied.py"
    spec = importlib.util.spec_from_file_location("earnings_implied", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _risk(mod, *, invalidation, straddle, reported=False, has_observation=True,
          missing_reason=None, now=BEFORE, report_date=date(2026, 10, 20), timing="am",
          expiry=date(2026, 11, 20), underlying=Decimal(50)):
    return mod.equity_open_risk(
        quantity=Decimal(10), mark=Decimal(50), invalidation=invalidation,
        report_date=report_date, report_timing=timing, reported=reported,
        straddle=straddle, underlying=underlying, expiry=expiry,
        has_observation=has_observation, missing_reason=missing_reason, now=now,
    )


def _book(*, actual=None, quotes=None, dates=None):
    """Robinhood-shaped payloads. Prices below are the test's inputs, not live quotes."""
    dates = dates or ["2026-10-16", "2026-11-20", "2026-12-18"]
    if quotes is None:
        quotes = {"data": {"results": [
            {"quote": {"instrument_id": "c50", "mark_price": "3.5", "bid_price": "3.4", "ask_price": "3.6",
                       "updated_at": "2026-10-19T15:00:00Z"}},
            {"quote": {"instrument_id": "p50", "mark_price": "2.5", "bid_price": "2.4", "ask_price": "2.6",
                       "updated_at": "2026-10-19T15:00:00Z"}},
        ]}}
    return {
        "earnings": {"data": {"results": [{
            "symbol": "EFX",
            "eps": {"estimate": "1.80", "actual": actual},
            "report": {"date": "2026-10-20", "timing": "am", "verified": True},
        }]}},
        "chains": {"data": {"chains": [{"id": "chain", "symbol": "EFX", "expiration_dates": dates}]}},
        "equity_quote": {"data": {"results": [{"quote": {
            "last_trade_price": "50",
            "venue_last_trade_time": "2026-10-19T15:00:00Z",
            "last_non_reg_trade_price": "49.50",
            "venue_last_non_reg_trade_time": "2026-10-19T12:00:00Z",
            "has_traded": True,
            "state": "active",
        }}]}},
        "instruments": {"data": {"instruments": [
            {"id": side + strike, "expiration_date": "2026-11-20", "strike_price": strike,
             "type": side_name, "state": "active", "tradability": "tradable"}
            for strike in ("45", "50", "55")
            for side, side_name in (("c", "call"), ("p", "put"))
        ]}},
        "quotes": quotes,
    }


class EquityImpliedMove(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.m = _load()

    def test_pre_report_lot_uses_the_max(self) -> None:
        # qty 10, mark 50, invalidation 45 -> line 50. Straddle 6 / underlying 50 -> implied 60.
        implied_wins = _risk(self.m, invalidation=Decimal(45), straddle=Decimal(6))
        self.assertEqual(implied_wins["line_risk"], Decimal(50))
        self.assertEqual(implied_wins["implied_move"], Decimal(60))
        self.assertEqual(implied_wins["risk"], Decimal(60))
        self.assertIsNone(implied_wins["risk_flag"])
        # invalidation 40 -> line 100, which beats the same implied 60.
        line_wins = _risk(self.m, invalidation=Decimal(40), straddle=Decimal(6))
        self.assertEqual(line_wins["line_risk"], Decimal(100))
        self.assertEqual(line_wins["implied_move"], Decimal(60))
        self.assertEqual(line_wins["risk"], Decimal(100))
        self.assertIsNone(line_wins["risk_flag"])

        got = self.m.build_observation("EFX", _book(), BEFORE)
        self.assertIsNone(got["missing_reason"])
        self.assertEqual(got["expiry_date"], date(2026, 11, 20))
        self.assertEqual(got["straddle_price"], Decimal("6"))
        self.assertEqual(got["underlying_price"], Decimal(50))
        self.assertEqual(got["call_price"] + got["put_price"], got["straddle_price"])
        args = self.m.record_args("lot-1", "EFX", got, BEFORE)
        self.assertEqual(args["expiry_date"], date(2026, 11, 20))
        self.assertEqual(args["straddle_price"], Decimal("6"))
        self.assertNotIn("missing_reason", args)

    def test_post_report_lot_uses_line_distance(self) -> None:
        # Same inputs that implied would have won on, once the print is out.
        for kwargs in (
            {"reported": True},
            {"now": datetime(2026, 10, 20, 13, 30, tzinfo=timezone.utc)},  # 09:30 ET
        ):
            got = _risk(self.m, invalidation=Decimal(45), straddle=Decimal(6), **kwargs)
            self.assertEqual(got["risk"], Decimal(50), kwargs)
            self.assertIsNone(got["implied_move"], kwargs)
            self.assertIsNone(got["risk_flag"], kwargs)
        # A passed report with no straddle is the line, and it is not a missing-quote flag.
        bare = _risk(self.m, invalidation=Decimal(45), straddle=None, reported=True, missing_reason=None)
        self.assertEqual(bare["risk"], Decimal(50))
        self.assertIsNone(bare["implied_move"])
        self.assertIsNone(bare["risk_flag"])

        got = self.m.build_observation("EFX", _book(actual="1.91"), BEFORE)
        self.assertTrue(got["reported"])
        self.assertIsNone(got["missing_reason"])
        self.assertNotIn("straddle_price", got)
        self.assertNotIn("expiry_date", got)
        args = self.m.record_args("lot-1", "EFX", got, BEFORE)
        self.assertTrue(args["reported"])
        for key in ("straddle_price", "underlying_price", "call_price", "put_price", "expiry_date", "strike"):
            self.assertNotIn(key, args)

    def test_missing_option_data_falls_back_and_flags(self) -> None:
        flagged = _risk(self.m, invalidation=Decimal(45), straddle=None, has_observation=True,
                        missing_reason="implied_move_missing")
        self.assertEqual(flagged["risk"], Decimal(50))
        self.assertEqual(flagged["line_risk"], Decimal(50))
        self.assertIsNone(flagged["implied_move"])
        self.assertEqual(flagged["risk_flag"], "implied_move_missing")
        # No row at all is the same dollars and the same flag.
        unseen = _risk(self.m, invalidation=Decimal(45), straddle=None, has_observation=False, missing_reason=None)
        self.assertEqual(unseen["risk"], Decimal(50))
        self.assertEqual(unseen["risk_flag"], "implied_move_missing")

        # mark_price 0 or absent, with a bid and ask present, is not a price.
        quotes = {"data": {"results": [
            {"quote": {"instrument_id": "c50", "mark_price": "0", "bid_price": "3.40", "ask_price": "3.60",
                       "updated_at": "2026-10-19T15:00:00Z"}},
            {"quote": {"instrument_id": "p50", "bid_price": "2.40", "ask_price": "2.60",
                       "updated_at": "2026-10-19T15:00:00Z"}},
        ]}}
        got = self.m.build_observation("EFX", _book(quotes=quotes), BEFORE)
        self.assertEqual(got["missing_reason"], "implied_move_missing")
        self.assertEqual(got["report_date"], date(2026, 10, 20))
        for key in ("straddle_price", "underlying_price", "call_price", "put_price", "expiry_date", "strike"):
            self.assertNotIn(key, got, key)
        args = self.m.record_args("lot-1", "EFX", got, BEFORE)
        self.assertEqual(args["missing_reason"], "implied_move_missing")
        self.assertNotIn("straddle_price", args)
        self.assertNotIn("call_price", args)
        self.assertNotIn("put_price", args)
        self.assertFalse(args["reported"])

    def test_nearest_listed_expiry_is_stored_and_not_corrected(self) -> None:
        # EFX / ROL have no weeklies. 2026-11-20 is the nearest listed date on or after 2026-10-20.
        self.assertEqual(
            self.m.select_expiry([date(2026, 10, 16), date(2026, 11, 20), date(2026, 12, 18)], date(2026, 10, 20)),
            date(2026, 11, 20),
        )
        # A same-day expiry is the nearest one. No rule pulls a later month forward or back.
        self.assertEqual(
            self.m.select_expiry([date(2026, 10, 16), date(2026, 10, 20), date(2026, 11, 20)], date(2026, 10, 20)),
            date(2026, 10, 20),
        )
        got = self.m.build_observation("EFX", _book(), BEFORE)
        self.assertEqual(got["expiry_date"], date(2026, 11, 20))
        self.assertEqual(got["meta"]["expiry_date"], "2026-11-20")

    def test_release_clock(self) -> None:
        m = self.m
        am = date(2026, 10, 20)
        self.assertFalse(m.report_passed(am, "am", False, datetime(2026, 10, 20, 13, 0, tzinfo=timezone.utc)))
        self.assertTrue(m.report_passed(am, "am", False, datetime(2026, 10, 20, 13, 30, tzinfo=timezone.utc)))
        pm = date(2026, 10, 21)
        self.assertFalse(m.report_passed(pm, "pm", False, datetime(2026, 10, 21, 23, 59, tzinfo=timezone.utc)))
        self.assertTrue(m.report_passed(pm, "pm", False, datetime(2026, 10, 22, 0, 0, tzinfo=timezone.utc)))
        # No timing: the next midnight in America/New_York (04:00 UTC while EDT).
        self.assertFalse(m.report_passed(am, None, False, datetime(2026, 10, 21, 3, 59, tzinfo=timezone.utc)))
        self.assertTrue(m.report_passed(am, None, False, datetime(2026, 10, 21, 4, 0, tzinfo=timezone.utc)))
        # Still pending with no am/pm: the straddle counts. A null "not yet" must not drop it.
        pending = _risk(m, invalidation=Decimal(45), straddle=Decimal(6), timing=None,
                        now=datetime(2026, 10, 21, 3, 59, tzinfo=timezone.utc))
        self.assertEqual(pending["risk"], Decimal(60))
        self.assertIsNone(pending["risk_flag"])
        out = _risk(m, invalidation=Decimal(45), straddle=Decimal(6), timing=None,
                    now=datetime(2026, 10, 21, 4, 0, tzinfo=timezone.utc))
        self.assertEqual(out["risk"], Decimal(50))
        self.assertIsNone(out["implied_move"])
        self.assertIsNone(out["risk_flag"])
        self.assertTrue(m.report_passed(am, "pm", True, datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)))

    def test_tie_on_distance_takes_the_lower_strike(self) -> None:
        instruments = [
            {"id": "c48", "expiration_date": "2026-11-20", "strike_price": "48", "type": "call", "state": "active"},
            {"id": "p48", "expiration_date": "2026-11-20", "strike_price": "48", "type": "put", "state": "active"},
            {"id": "c52", "expiration_date": "2026-11-20", "strike_price": "52", "type": "call", "state": "active"},
            {"id": "p52", "expiration_date": "2026-11-20", "strike_price": "52", "type": "put", "state": "active"},
            # A second call at 48 is not a quote to pick from.
            {"id": "c48b", "expiration_date": "2026-11-20", "strike_price": "48", "type": "call", "state": "active"},
        ]
        quotes = {"data": {"results": [
            {"quote": {"instrument_id": iid, "mark_price": px, "updated_at": "2026-10-19T15:00:00Z"}}
            for iid, px in (("c48", "4"), ("p48", "2"), ("c52", "1"), ("p52", "5"), ("c48b", "9"))
        ]}}
        # 48 is discarded (two calls). 52 remains and is the straddle.
        got = self.m.select_atm_straddle(instruments, quotes, Decimal(50), date(2026, 11, 20))
        self.assertIsNotNone(got)
        assert got is not None
        self.assertEqual(got["strike"], Decimal(52))
        self.assertEqual(got["straddle_price"], Decimal(6))
        # Without the duplicate, 48 and 52 are the same distance and the lower strike wins.
        got = self.m.select_atm_straddle(instruments[:4], quotes, Decimal(50), date(2026, 11, 20))
        assert got is not None
        self.assertEqual(got["strike"], Decimal(48))

    def test_schema_states_the_formula(self) -> None:
        sql = (ROOT / "supabase" / "schemas" / "80_equity_implied_move_risk.sql").read_text()
        self.assertIn("(p_straddle / p_underlying) * (p_quantity * p_mark)", sql)
        self.assertIn("greatest(v_line, v_implied)", sql)
        self.assertIn("'implied_move_missing'", sql)
        self.assertIn("time '09:30'", sql)
        self.assertIn("time '20:00'", sql)
        self.assertIn("security invoker", sql[sql.index("function private.equity_lot_open_risk"):sql.index("function private.open_risk_lots")])
        migs = sorted((ROOT / "supabase" / "migrations").glob("*_equity_implied_move_risk.sql"))
        self.assertEqual(len(migs), 1, [p.name for p in migs])
        self.assertEqual(migs[0].read_text(), sql)
        md = (ROOT / "docs" / "rules" / "portfolio-exposure.md").read_text()
        mechanism = md.split("## Mechanism\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(sql.split("$mech$", 1)[1].split("$mech$", 1)[0], mechanism)
        rules = (ROOT / "tools" / "court" / "rules_data.py").read_text()
        start = rules.index('mechanism="', rules.index('id="portfolio-exposure"')) + len('mechanism="')
        self.assertEqual(rules[start:rules.index('",\n', start)], mechanism)
        # Schema 44 keeps the old equity formula. This migration replaces the live function.
        old = (ROOT / "supabase" / "schemas" / "44_exposure_gap_full_notional.sql").read_text()
        self.assertIn("else m.quantity * greatest(m.mark - m.invalidation_price, 0)", old)
        self.assertNotIn("implied_move_missing", old)
