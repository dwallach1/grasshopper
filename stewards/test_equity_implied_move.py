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


def _sql_args(sql: str) -> dict:
    import json
    start = sql.index("$") + 1
    tag, rest = sql[start:].split("$", 1)
    body = rest.split(f"${tag}$", 1)[0]
    return json.loads(body)


def _contract(side: str, side_name: str, strike: str, expiry: str, iid: str) -> dict:
    return {
        "id": iid, "expiration_date": expiry, "strike_price": strike, "type": side_name,
        "state": "active", "tradability": "tradable", "chain_symbol": None,
    }


def _quote(iid: str, mark: str) -> dict:
    return {"quote": {"instrument_id": iid, "mark_price": mark, "updated_at": "2026-10-19T15:00:00Z"}}


def _mcp_payload() -> dict:
    """Raw MCP responses. AAPL has a weekly after the report. EFX is monthly-only.

    A decoy expiry sits in each chain (AAPL's later month, EFX's date before the report)
    so the writer has to pick the nearest listed expiry on or after the report.
    """
    aapl_expiry = "2026-10-23"
    efx_expiry = "2026-11-20"
    return {
        "lots": [
            {"lot_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "symbol": "AAPL"},
            {"lot_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "symbol": "EFX"},
        ],
        "get_earnings_results": {
            "AAPL": {"data": {"results": [{
                "symbol": "AAPL",
                "eps": {"estimate": "1.98", "actual": None},
                "report": {"date": "2026-10-22", "timing": "pm", "verified": True},
            }]}},
            "EFX": {"data": {"results": [{
                "symbol": "EFX",
                "eps": {"estimate": "1.80", "actual": None},
                "report": {"date": "2026-10-20", "timing": "am", "verified": True},
            }]}},
        },
        "get_option_chains": {
            "AAPL": {"data": {"chains": [{"symbol": "AAPL", "expiration_dates": [
                "2026-10-16", "2026-10-23", "2026-11-20",
            ]}]}},
            "EFX": {"data": {"chains": [{"symbol": "EFX", "expiration_dates": [
                "2026-10-16", "2026-11-20", "2026-12-18",
            ]}]}},
        },
        "get_equity_quotes": {"data": {"results": [
            {"quote": {
                "symbol": "AAPL", "last_trade_price": "100",
                "venue_last_trade_time": "2026-10-19T15:00:00Z",
                "has_traded": True, "state": "active",
            }},
            {"quote": {
                "symbol": "EFX", "last_trade_price": "50",
                "venue_last_trade_time": "2026-10-19T15:00:00Z",
                "has_traded": True, "state": "active",
            }},
        ]}},
        "get_option_instruments": {
            "AAPL": {"data": {"instruments": [
                _contract("c", "call", "100", aapl_expiry, "c100"),
                _contract("p", "put", "100", aapl_expiry, "p100"),
                _contract("c", "call", "110", aapl_expiry, "c110"),
                _contract("p", "put", "110", aapl_expiry, "p110"),
                # Later month, closer to nothing we should pick. Marks below are larger on purpose.
                _contract("c", "call", "100", "2026-11-20", "c100m"),
                _contract("p", "put", "100", "2026-11-20", "p100m"),
            ]}},
            "EFX": {"data": {"instruments": [
                # Before the report. Must not be the stored expiry.
                _contract("c", "call", "50", "2026-10-16", "c50early"),
                _contract("p", "put", "50", "2026-10-16", "p50early"),
                _contract("c", "call", "45", efx_expiry, "c45"),
                _contract("p", "put", "45", efx_expiry, "p45"),
                _contract("c", "call", "50", efx_expiry, "c50"),
                _contract("p", "put", "50", efx_expiry, "p50"),
            ]}},
        },
        "get_option_quotes": {
            "AAPL": {"data": {"results": [
                _quote("c100", "4.25"), _quote("p100", "3.75"),
                _quote("c110", "1.00"), _quote("p110", "9.00"),
                _quote("c100m", "9"), _quote("p100m", "9"),
            ]}},
            "EFX": {"data": {"results": [
                _quote("c50early", "1"), _quote("p50early", "1"),
                _quote("c45", "6"), _quote("p45", "1"),
                _quote("c50", "3.5"), _quote("p50", "2.5"),
            ]}},
        },
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
        # Schema 80 keeps the mechanism it shipped. The live paragraph is schema 86.
        self.assertIn("implied_move_missing", sql.split("$mech$", 1)[1].split("$mech$", 1)[0])
        self.assertNotIn("p_expected_move", sql)
        latest = (ROOT / "supabase" / "schemas" / "86_equity_expected_move_sizing.sql").read_text()
        self.assertEqual(latest.split("$mech$", 1)[1].split("$mech$", 1)[0], mechanism)
        rules = (ROOT / "tools" / "court" / "rules_data.py").read_text()
        start = rules.index('mechanism="', rules.index('id="portfolio-exposure"')) + len('mechanism="')
        self.assertEqual(rules[start:rules.index('",\n', start)], mechanism)
        self.assertIn("p_expected_move", mechanism)
        # Schema 44 keeps the old equity formula. This migration replaces the live function.
        old = (ROOT / "supabase" / "schemas" / "44_exposure_gap_full_notional.sql").read_text()
        self.assertIn("else m.quantity * greatest(m.mark - m.invalidation_price, 0)", old)
        self.assertNotIn("implied_move_missing", old)

    def test_implied_move_fraction_is_straddle_over_underlying(self) -> None:
        # ROL: straddle implied 9.4%. A missing leg is not a made-up move.
        self.assertEqual(self.m.implied_move_fraction(Decimal("3.1067"), Decimal("33.05")), Decimal("3.1067") / Decimal("33.05"))
        self.assertIsNone(self.m.implied_move_fraction(None, Decimal("33.05")))
        self.assertIsNone(self.m.implied_move_fraction(Decimal("1"), Decimal("0")))
        # 16 shares at the line, then scaled by 6.021% / 9.4%.
        line = (Decimal("33.05") - Decimal("31.06")) / Decimal("33.05")
        move = Decimal("0.094")
        self.assertEqual(round(Decimal(16) * line / move, 4), Decimal("10.2488"))

    def test_plan_lists_the_missing_lot_and_the_robinhood_calls(self) -> None:
        m = self.m
        lots = [
            {"lot_id": "lot-efx", "symbol": "efx", "quantity": Decimal(12)},
            {"lot_id": "lot-rol", "symbol": "ROL", "quantity": 4},
            {"lot_id": "lot-aapl", "symbol": "AAPL", "quantity": 1},
        ]
        # AAPL has a current straddle for a report that is still ahead. EFX has no row.
        # ROL's report is still ahead and the straddle was never stored.
        observations = {
            "lot-aapl": {
                "report_date": date(2026, 11, 2), "report_timing": "pm", "reported": False,
                "straddle_price": Decimal("8"), "missing_reason": None,
            },
            "lot-rol": {
                "report_date": date(2026, 11, 5), "report_timing": "am", "reported": False,
                "straddle_price": None, "missing_reason": None,
            },
        }
        gaps = m.gap_lots(lots, observations, BEFORE)
        self.assertEqual([row["symbol"] for row in gaps], ["EFX", "ROL"])
        self.assertEqual(gaps[0]["quantity"], "12")
        plan = m.plan_calls(gaps)
        self.assertEqual([row["lot_id"] for row in plan["lots"]], ["lot-efx", "lot-rol"])
        by_tool = {}
        for call in plan["calls"]:
            by_tool.setdefault(call["tool"], []).append(call)
        self.assertEqual(
            [call["arguments"] for call in by_tool["get_earnings_results"]],
            [{"symbol": "EFX"}, {"symbol": "ROL"}],
        )
        self.assertEqual(
            [call["arguments"] for call in by_tool["get_option_chains"]],
            [{"underlying_symbol": "EFX"}, {"underlying_symbol": "ROL"}],
        )
        self.assertEqual(by_tool["get_equity_quotes"][0]["arguments"], {"symbols": ["EFX", "ROL"]})
        instruments = by_tool["get_option_instruments"]
        self.assertEqual(instruments[0]["arguments"], {"chain_symbol": "EFX", "state": "active"})
        self.assertEqual(instruments[0]["fill"]["expiration_dates"].split()[0], "nearest")
        self.assertEqual(instruments[0]["after"], ["get_earnings_results", "get_option_chains"])
        quotes = by_tool["get_option_quotes"]
        self.assertEqual(quotes[1]["arguments"], {})
        self.assertIn("instrument_ids", quotes[1]["fill"])
        self.assertEqual(quotes[1]["after"], ["get_option_instruments", "get_equity_quotes"])
        # A written missing flag, and a passed report, are current: plan does not list them.
        covered = m.gap_lots(
            [{"lot_id": "lot-flag", "symbol": "CODA"}, {"lot_id": "lot-out", "symbol": "NBIS"}],
            {
                "lot-flag": {"report_date": date(2026, 10, 20), "report_timing": "am", "missing_reason": "implied_move_missing"},
                "lot-out": {"report_date": date(2026, 10, 20), "report_timing": "am", "reported": True},
            },
            BEFORE,
        )
        self.assertEqual(covered, [])

    def test_write_weekly_and_monthly_payloads(self) -> None:
        # Prices here are the fixture's inputs, not live quotes.
        # AAPL lists a weekly on 2026-10-23. EFX's nearest listed date on or after 2026-10-20 is 2026-11-20.
        payload = _mcp_payload()
        out = self.m.write_payload(payload, now=BEFORE)
        self.assertEqual(out["lots"], 2)
        self.assertEqual(len(out["statements"]), 2)
        by_symbol = {row["symbol"]: row for row in out["results"]}
        weekly = _sql_args(by_symbol["AAPL"]["sql"])
        self.assertEqual(weekly["expiry_date"], "2026-10-23")
        self.assertEqual(weekly["strike"], "100")
        self.assertEqual(weekly["call_price"], "4.25")
        self.assertEqual(weekly["put_price"], "3.75")
        self.assertEqual(weekly["straddle_price"], "8.00")
        self.assertEqual(weekly["underlying_price"], "100")
        self.assertEqual(weekly["report_date"], "2026-10-22")
        self.assertEqual(weekly["report_timing"], "pm")
        self.assertNotIn("missing_reason", weekly)
        self.assertIn("select public.steward_record_equity_implied_move(", by_symbol["AAPL"]["sql"])
        monthly = _sql_args(by_symbol["EFX"]["sql"])
        self.assertEqual(monthly["expiry_date"], "2026-11-20")
        self.assertEqual(monthly["strike"], "50")
        self.assertEqual(monthly["call_price"], "3.5")
        self.assertEqual(monthly["put_price"], "2.5")
        self.assertEqual(monthly["straddle_price"], "6.0")
        self.assertEqual(monthly["report_date"], "2026-10-20")
        self.assertEqual(monthly["report_timing"], "am")
        self.assertNotEqual(monthly["expiry_date"], "2026-10-16")

    def test_write_missing_data_flags_and_invents_no_price(self) -> None:
        payload = _mcp_payload()
        # mark_price 0, with a bid and an ask, is not a price. Neither is an absent mark.
        payload["get_option_quotes"] = {
            "AAPL": {"data": {"results": [
                {"quote": {"instrument_id": "c100", "mark_price": "0", "bid_price": "4.10", "ask_price": "4.40",
                           "updated_at": "2026-10-19T15:00:00Z"}},
                {"quote": {"instrument_id": "p100", "bid_price": "3.60", "ask_price": "3.90",
                           "updated_at": "2026-10-19T15:00:00Z"}},
            ]}},
            "EFX": {"data": {"results": []}},
        }
        called = []
        out = self.m.write_payload(payload, execute=True, now=BEFORE, caller=lambda args: called.append(args) or {"ok": True})
        self.assertEqual(called[0]["missing_reason"], "implied_move_missing")
        for row in out["results"]:
            args = _sql_args(row["sql"])
            self.assertEqual(args["missing_reason"], "implied_move_missing")
            self.assertEqual(row["action"], "implied_move_missing")
            for key in ("straddle_price", "underlying_price", "call_price", "put_price", "expiry_date", "strike"):
                self.assertNotIn(key, args, row["symbol"] + " " + key)
            self.assertNotIn("4.10", row["sql"])
            self.assertNotIn("4.40", row["sql"])
            self.assertNotIn("3.60", row["sql"])
            self.assertNotIn("3.90", row["sql"])
        self.assertEqual(_sql_args(out["results"][0]["sql"])["symbol"] in ("AAPL", "EFX"), True)
        # No responses at all is still a missing row, so the lot flags instead of staying silent.
        bare = self.m.write_payload(
            {"lots": [{"lot_id": "lot-new", "symbol": "NEW"}]}, now=BEFORE,
        )
        args = _sql_args(bare["statements"][0])
        self.assertEqual(args["missing_reason"], "implied_move_missing")
        self.assertNotIn("straddle_price", args)
        self.assertEqual(args["observed_at"], "2026-10-19T16:00:00Z")

    def test_watchdog_gap_count_matches_the_sql_predicate(self) -> None:
        # Same six rows as supabase/tests/81_equity_implied_move_gaps.sql. Two are gaps.
        m = self.m
        rows = [
            None,
            {"report_date": date(2026, 10, 20), "report_timing": "am", "reported": False, "straddle_price": Decimal(6)},
            {"report_date": date(2026, 10, 20), "report_timing": "am", "reported": False, "missing_reason": "implied_move_missing"},
            {"report_date": date(2026, 10, 20), "report_timing": "am", "reported": True},
            {"report_date": None, "reported": False},
            {"report_date": date(2026, 10, 20), "report_timing": "am", "reported": False, "straddle_price": None},
        ]
        lots = [{"lot_id": f"lot-{i}", "symbol": "EFX"} for i in range(len(rows))]
        observations = {lot["lot_id"]: row for lot, row in zip(lots, rows)}
        gaps = m.gap_lots(lots, observations, BEFORE)
        self.assertEqual(len(gaps), 2)
        self.assertEqual([row["lot_id"] for row in gaps], ["lot-0", "lot-5"])
        sql = (ROOT / "supabase" / "schemas" / "81_equity_implied_move_gaps.sql").read_text()
        mig = ROOT / "supabase" / "migrations" / "20261019193000_equity_implied_move_gaps.sql"
        self.assertEqual(mig.read_text(), sql)
        self.assertIn("as equity_implied_move_gaps", sql)
        self.assertIn("from public.v_equity_implied_move_gaps", sql)
        self.assertIn("public.equity_implied_move_is_gap", sql)
        self.assertIn("pe.status = 'open'", sql)
        self.assertIn("security invoker", sql[sql.index("function public.equity_implied_move_is_gap"):sql.index("function public.steward_implied_move_gaps")])
        self.assertIn("time '09:30'", sql)
        self.assertIn("time '20:00'", sql)
        self.assertIn("'steward_implied_move_gaps'", (ROOT / "supabase" / "functions" / "steward-rpc" / "index.ts").read_text())
