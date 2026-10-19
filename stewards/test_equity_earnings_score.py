"""Realized earnings move vs the priced straddle.

AM uses the prior session close. PM uses that session's close. The post session
is the report's own session for AM and the next session for PM. A missing bar
is a reason, never a filled-in price. Fixture bars below are not live quotes.
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load():
    path = HERE / "quantanamo" / "earnings_implied.py"
    spec = importlib.util.spec_from_file_location("earnings_implied_score", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _bar(day, open_px, close_px, volume=1000, **extra):
    row = {"time": day, "open": open_px, "close": close_px, "volume": volume, "ticker": extra.pop("ticker", "NFLX")}
    row.update(extra)
    return row


class EarningsScoreMath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = _load()

    def test_am_uses_the_prior_close_and_the_report_session(self):
        # EFX reports 2026-10-20 before the open. Monday 10/19 is the reference.
        m = self.m
        self.assertEqual(m.reference_session(date(2026, 10, 20), "am"), date(2026, 10, 19))
        self.assertEqual(m.post_session(date(2026, 10, 20), "am"), date(2026, 10, 20))
        now = datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc)  # Tuesday 10:00 ET, after Monday's close
        bars = [
            _bar("2026-10-19", 200, 210, ticker="EFX"),
            _bar("2026-10-20", 190, 198, ticker="EFX"),
        ]
        scored = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="am", bars=m.parse_daily_bars({"prices": bars}, "EFX"),
            now=now, invalidation=Decimal("195"), quantity=Decimal(4),
            straddle=Decimal("20"), underlying=Decimal("210"),
        )
        self.assertEqual(scored["reference_session"], date(2026, 10, 19))
        self.assertEqual(scored["reference_close"], Decimal("210"))
        self.assertEqual(scored["post_open"], Decimal("190"))
        self.assertEqual(scored["post_close"], Decimal("198"))
        self.assertEqual(scored["realized_open_gap"], Decimal("-0.095238"))
        self.assertEqual(scored["realized_close_to_close"], Decimal("-0.057143"))
        self.assertIsNone(scored["score_missing_reason"])
        self.assertTrue(scored["line_jumped"])  # 190 <= 195

    def test_pm_uses_the_same_day_close_and_the_next_session(self):
        # NFLX reports 2026-10-20 after the close. Wednesday 10/21 is the post session.
        m = self.m
        self.assertEqual(m.reference_session(date(2026, 10, 20), "pm"), date(2026, 10, 20))
        self.assertEqual(m.post_session(date(2026, 10, 20), "pm"), date(2026, 10, 21))
        # Morning of 10/21, 10:00 ET: the open is in, the close is not.
        now = datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc)
        bars = [
            _bar("2026-10-20", 1100, 1140),
            _bar("2026-10-21", 1200, 1210),  # close on this bar is a partial and must be ignored
        ]
        scored = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=m.parse_daily_bars({"prices": bars}, "NFLX"),
            now=now, invalidation=Decimal("1000"), quantity=Decimal(2),
            straddle=Decimal("110"), underlying=Decimal("1140"),
        )
        self.assertEqual(scored["reference_close"], Decimal("1140"))
        self.assertEqual(scored["post_open"], Decimal("1200"))
        self.assertIsNone(scored["post_close"])
        self.assertEqual(scored["score_missing_reason"], "no_post_close")
        self.assertIsNone(scored["realized_close_to_close"])
        self.assertIsNone(scored["realized_implied_ratio"])
        self.assertFalse(scored["line_jumped"])
        self.assertFalse(scored["outlier"])

    def test_pm_close_scores_once_the_session_has_closed(self):
        m = self.m
        now = datetime(2026, 10, 21, 20, 30, tzinfo=timezone.utc)  # 16:30 ET
        bars = [_bar("2026-10-20", 1100, 100), _bar("2026-10-21", 90, 80)]
        scored = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=m.parse_daily_bars({"prices": bars}, "NFLX"),
            now=now, invalidation=Decimal("95"), quantity=Decimal(1),
            straddle=Decimal("10"), underlying=Decimal("100"),
        )
        self.assertEqual(scored["post_close"], Decimal("80"))
        self.assertEqual(scored["realized_close_to_close"], Decimal("-0.200000"))
        self.assertEqual(scored["realized_implied_ratio"], Decimal("2.000000"))
        self.assertTrue(scored["line_jumped"])  # 90 <= 95
        self.assertTrue(scored["outlier"])
        self.assertIsNone(scored["score_missing_reason"])

    def test_missing_bars_do_not_invent_a_price(self):
        m = self.m
        now = datetime(2026, 10, 21, 20, 30, tzinfo=timezone.utc)
        empty = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=[],
            now=now, invalidation=Decimal("10"), quantity=Decimal(1),
            straddle=Decimal("1"), underlying=Decimal("10"),
        )
        self.assertEqual(empty["score_missing_reason"], "bars_unavailable")
        self.assertIsNone(empty["reference_close"])
        self.assertIsNone(empty["post_open"])
        self.assertIsNone(empty["post_close"])
        self.assertIsNone(empty["realized_open_gap"])
        self.assertFalse(empty["outlier"])

        unread = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=None,
            now=now, invalidation=None, quantity=None, straddle=None, underlying=None,
        )
        self.assertEqual(unread["score_missing_reason"], "bars_unavailable")
        self.assertIsNone(unread["reference_close"])

        wrong_day = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="am",
            bars=m.parse_daily_bars({"prices": [_bar("2026-10-01", 1, 1, ticker="EFX")]}, "EFX"),
            now=now, invalidation=Decimal("1"), quantity=Decimal(1),
            straddle=Decimal("1"), underlying=Decimal("10"),
        )
        self.assertEqual(wrong_day["score_missing_reason"], "no_reference_bar")
        self.assertIsNone(wrong_day["post_open"])

    def test_zero_volume_and_interpolated_bars_are_not_trades(self):
        m = self.m
        now = datetime(2026, 10, 21, 20, 30, tzinfo=timezone.utc)
        payload = {"prices": [
            _bar("2026-10-20", 10, 10, volume=0),
            _bar("2026-10-21", 11, 12, volume=0),
            {"time": "2026-10-20", "open": 99, "close": 99, "volume": 5, "interpolated": True, "ticker": "NFLX"},
        ]}
        self.assertEqual(m.parse_daily_bars(payload, "NFLX"), [])
        robinhood = {"data": {"results": [{
            "symbol": "NFLX",
            "historicals": [{
                "begins_at": "2026-10-20T00:00:00Z",
                "open_price": "100",
                "close_price": "114",
                "volume": "10",
                "interpolated": False,
            }, {
                "begins_at": "2026-10-21T00:00:00Z",
                "open_price": "120",
                "close_price": "118",
                "volume": "10",
                "interpolated": False,
            }],
        }]}}
        bars = m.parse_daily_bars(robinhood, "NFLX")
        self.assertEqual([bar["day"] for bar in bars], [date(2026, 10, 20), date(2026, 10, 21)])
        scored = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=bars, now=now,
            invalidation=Decimal("130"), quantity=Decimal("2"),
            straddle=Decimal("11"), underlying=Decimal("114"),
        )
        self.assertEqual(scored["reference_close"], Decimal("114"))
        self.assertEqual(scored["post_open"], Decimal("120"))
        # A long jumps when the open is at or below the exit. 120 <= 130.
        self.assertTrue(scored["line_jumped"])

    def test_line_jump_is_unknown_without_an_exit_or_an_open(self):
        m = self.m
        self.assertIsNone(m.line_was_jumped(None, Decimal("10"), Decimal(1)))
        self.assertIsNone(m.line_was_jumped(Decimal("9"), None, Decimal(1)))
        self.assertTrue(m.line_was_jumped(Decimal("10"), Decimal("10"), Decimal(1)))
        self.assertFalse(m.line_was_jumped(Decimal("10.01"), Decimal("10"), Decimal(1)))
        self.assertTrue(m.line_was_jumped(Decimal("11"), Decimal("10"), Decimal("-1")))
        self.assertFalse(m.line_was_jumped(Decimal("9"), Decimal("10"), Decimal("-1")))

    def test_outlier_is_above_one_and_a_half_or_a_jumped_line(self):
        m = self.m
        self.assertFalse(m.is_earnings_outlier(Decimal("1.5"), False))
        self.assertTrue(m.is_earnings_outlier(Decimal("1.500001"), False))
        self.assertTrue(m.is_earnings_outlier(Decimal("0.2"), True))
        self.assertFalse(m.is_earnings_outlier(None, False))
        self.assertFalse(m.is_earnings_outlier(None, None))

    def test_loose_expiry_is_more_than_seven_days_and_the_nearest_listed(self):
        m = self.m
        self.assertFalse(m.expiry_is_loose(date(2026, 10, 20), date(2026, 10, 23)))  # NFLX weekly
        self.assertTrue(m.expiry_is_loose(date(2026, 10, 20), date(2026, 11, 20)))  # EFX monthly
        self.assertEqual(m.expiry_gap_days(date(2026, 10, 21), date(2026, 11, 20)), 30)  # ROL
        self.assertFalse(m.expiry_is_loose(date(2026, 10, 20), None))

    def test_lesson_labels_a_thin_sample_and_states_the_print(self):
        m = self.m
        text = m.earnings_lesson_text(
            symbol="NFLX", realized=Decimal("-0.20"), implied=Decimal("0.097"),
            ratio=Decimal("2.06"), jumped=True, loose=False, n=1,
        )
        self.assertIn("NFLX moved 20% on the print", text)
        self.assertIn("options had priced 9.7%", text)
        self.assertIn("The open went through the exit line.", text)
        self.assertIn("1 scored print so far, too few for a verdict.", text)
        self.assertNotIn("the priced move is wrong", text.lower())
        thin = m.earnings_lesson_text(
            symbol="EFX", realized=Decimal("0.04"), implied=Decimal("0.02"),
            ratio=Decimal("2"), jumped=False, loose=True, n=None,
        )
        self.assertIn("loose upper bound", thin)
        self.assertIn("a handful of scored prints so far, too few for a verdict.", thin)
        self.assertGreaterEqual(len(text), 20)

    def test_a_later_empty_read_is_not_what_the_math_stores_over_a_close(self):
        # The SQL keeps a stored close when the next payload has none. The math
        # itself still reports the bars it was given, and does not borrow a close.
        m = self.m
        now = datetime(2026, 10, 22, 20, 0, tzinfo=timezone.utc)
        scored = m.score_earnings_move(
            report_date=date(2026, 10, 20), timing="pm", bars=[],
            now=now, invalidation=Decimal("1"), quantity=Decimal(1),
            straddle=Decimal("1"), underlying=Decimal("10"),
        )
        self.assertIsNone(scored["post_close"])
        self.assertEqual(scored["score_missing_reason"], "bars_unavailable")

    def test_schema_does_not_change_the_risk_max_and_flags_a_loose_expiry(self):
        sql = (HERE.parent / "supabase" / "schemas" / "82_equity_earnings_score.sql").read_text()
        self.assertNotIn("create or replace function private.equity_lot_open_risk", sql)
        self.assertNotIn("steward_sizing_guidance", sql)
        self.assertIn("expiry_loose", sql)
        self.assertIn("> 7", sql)
        self.assertIn("score_missing_reason", sql)
        self.assertIn("n < 5", sql)
        self.assertIn("> 1.5", sql)
        self.assertIn("security invoker", sql)
        self.assertNotIn("security definer", sql.lower())
        mig = HERE.parent / "supabase" / "migrations" / "20261019220000_equity_earnings_score.sql"
        self.assertEqual(mig.read_text(), sql)


if __name__ == "__main__":
    unittest.main()
