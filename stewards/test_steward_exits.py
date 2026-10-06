"""Dependency-free unit tests for the steward exit/mark/P&L helpers (run in CI)."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent


def load(steward: str, module: str):
    """Import a steward script by path (both dirs have a close_lesson.py), with its dir on sys.path."""
    d = str(HERE / steward)
    if d not in sys.path:
        sys.path.insert(0, d)
    spec = importlib.util.spec_from_file_location(f"{steward}_{module}", HERE / steward / f"{module}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cc = load("bandit", "clip_common")
pm_exit = load("oddsborne", "pm_exit")
pm_watch = load("oddsborne", "pm_watch")
pm_fills_sync = load("oddsborne", "pm_fills_sync")
pm_pnl = load("oddsborne", "pm_pnl_snapshot")
lesson = load("oddsborne", "close_lesson")


def execution(fill_id, order_id, action, qty, px, fee, ts, aggressor=False, outcome="OUTCOME_SIDE_YES"):
    ex = {"id": fill_id, "order": {"id": order_id, "outcomeSide": outcome, "action": action}, "lastShares": qty,
          "lastPx": {"value": px}, "commissionNotionalCollected": {"value": fee}, "transactTime": ts}
    tr = {"id": "T" + fill_id, "isAggressor": aggressor, ("aggressorExecution" if aggressor else "passiveExecution"): ex}
    return {"type": "ACTIVITY_TYPE_TRADE", "trade": tr}


# The real 10/1 TEN lot: three passive maker fills on one buy order, one aggressive sell on 10/4.
TEN = [
    execution("CX3DZT41EYHR", "CX3A2QTFJYG6", "ORDER_ACTION_SELL", "14", "0.0825", "0.07", "2026-10-04T17:45:48.953882973Z", True),
    execution("CV64CCWB2YHR", "CV44MW19GYH4", "ORDER_ACTION_BUY", "0.31", "0.1475", "0", "2026-10-01T18:20:53.122572693Z"),
    execution("CV64605MPYHR", "CV44MW19GYH4", "ORDER_ACTION_BUY", "12.06", "0.1475", "-0.02", "2026-10-01T18:20:24.693662197Z"),
    execution("CV5YSPRW2YHR", "CV44MW19GYH4", "ORDER_ACTION_BUY", "1.63", "0.1475", "0", "2026-10-01T18:08:34.236180593Z"),
    {"type": "ACTIVITY_TYPE_DEPOSIT"},
]


class BanditRails(unittest.TestCase):
    def test_decide_order(self) -> None:
        inval = Decimal("0.6")
        self.assertEqual(cc.decide(80, Decimal("1.8"), inval, True)[0], "deadline_exit")  # time stop wins
        self.assertEqual(cc.decide(-40, Decimal("0.6"), inval, False), ("kill_exit", "hit_-40pct"))
        self.assertEqual(cc.decide(-30, Decimal("0.59"), inval, False), ("kill_exit", "hit_invalidation_price"))
        self.assertEqual(cc.decide(50, Decimal("1.5"), inval, False)[0], "tp50_full_exit")
        self.assertEqual(cc.decide(-25, Decimal("0.75"), inval, False)[0], "warn")
        self.assertEqual(cc.decide(40, Decimal("1.4"), inval, False)[0], "warn")
        self.assertEqual(cc.decide(10, Decimal("1.1"), None, False), ("hold", "in_band"))
        for action, trigger in cc.ACTION_TRIGGER.items():
            self.assertIn(trigger, cc.TRIGGERS, action)

    def test_deadline_and_atoms(self) -> None:
        self.assertEqual(cc.deadline_for("2026-10-06T10:00:00+00:00"), datetime(2026, 10, 6, 14, tzinfo=timezone.utc))
        self.assertEqual(cc.to_atoms(Decimal("1.2345678"), 6), 1234567)

    def test_exit_fill_args_realized_and_close_meta(self) -> None:
        pos = {"id": "P1", "average_cost_sol": "0.000001", "token": {"symbol": "ZZB"}, "meta": {"tp50_realized_sol": "0.01"}}
        now = datetime(2026, 10, 6, 14, 3, tzinfo=timezone.utc)
        a = cc.exit_fill_args(pos, "O1", "tp50_full_bank", "SIG", 100_000 * 10**6, 150_000_000, 6, 0, 1_850_000_000, 7,
                              Decimal("0.00011"), {}, {"requestId": "R", "transaction": "BIG"}, "jupiter_execute", 300, {}, now)
        self.assertEqual(Decimal(a["exit_price"]), Decimal("0.0000015"))
        self.assertEqual(Decimal(a["_computed"]["realized_this_sol"]), Decimal("0.05"))
        self.assertEqual(Decimal(a["realized_total"]), Decimal("0.06"))  # includes the earlier tp50 bank
        self.assertEqual(a["close_meta"]["exit_reason"], "tp50_full_bank")  # read by trade_outcome_capture
        self.assertEqual(a["close_meta"]["deadline_exit"]["writer"], "exit_clip")
        self.assertEqual(Decimal(a["remain_tokens"]), 0)
        self.assertEqual(a["venue_order_id"], "R")
        self.assertNotIn("transaction", a["order_payload"]["order_meta"])
        self.assertEqual(a["as_of"], now.isoformat())


class OddsborneExit(unittest.TestCase):
    def test_parse_trades(self) -> None:
        t = pm_exit.parse_trades(TEN)
        self.assertEqual(len(t), 4)
        sell = pm_exit.exit_fills_for(t, "CX3A2QTFJYG6", "yes")
        self.assertEqual([(x["quantity"], x["price"], x["fee"]) for x in sell], [("14", "0.0825", "0.07")])
        self.assertTrue(sell[0]["payload"]["is_aggressor"])
        buys = pm_exit.entry_fills_for(t, {"CV44MW19GYH4"}, "yes")
        self.assertEqual(sum(Decimal(b["quantity"]) for b in buys), Decimal("14"))
        self.assertEqual(pm_exit.entry_fills_for(t, {"CV44MW19GYH4"}, "no"), [])
        self.assertEqual(pm_exit._ts("2026-10-01T18:20:53.122572693Z").microsecond, 122572)

    def test_lot_entry_fills_cutoff(self) -> None:
        t = pm_exit.parse_trades(TEN)
        fills, cutoff = pm_exit.lot_entry_fills(t, {"CV44MW19GYH4"}, "yes", "2026-10-01T18:08:35+00:00")
        self.assertEqual((len(fills), cutoff), (3, None))
        # A later lot on the same market: the 10/4 sell closed the earlier lot, so the old buys are not this lot's.
        later = t + pm_exit.parse_trades([execution("NEWBUY", "CV44MW19GYH4", "ORDER_ACTION_BUY", "5", "0.2", "0",
                                                    "2026-10-05T12:00:00Z")])
        fills, cutoff = pm_exit.lot_entry_fills(later, {"CV44MW19GYH4"}, "yes", "2026-10-05T12:00:01+00:00")
        self.assertEqual([f["venue_fill_id"] for f in fills], ["NEWBUY"])
        self.assertTrue(cutoff.startswith("2026-10-04T17:45:48"))

    def test_lot_quantities_ledger_behind(self) -> None:
        entry, _ = pm_exit.lot_entry_fills(pm_exit.parse_trades(TEN), {"CV44MW19GYH4"}, "yes", "2026-10-01T18:08:35+00:00")
        q = pm_exit.lot_quantities({"quantity": "1.63", "linked_fills": {"buy_qty": "1.63", "sell_qty": "0"}}, entry)
        self.assertEqual(Decimal(q["lot_qty"]), Decimal("14"))  # sell what the venue holds, not the stale ledger 1.63
        self.assertTrue(q["ledger_behind"])
        self.assertTrue(q["complete"])
        q = pm_exit.lot_quantities({"quantity": "14", "linked_fills": {}}, entry[:1])
        self.assertFalse(q["complete"])  # entry fills missing: the close would be unpriced

    def test_sell_params_and_print(self) -> None:
        p = pm_exit.sell_params("s", "yes", 0.0775, 14, "ioc")
        self.assertEqual((p["intent"], p["price"]["value"], p["quantity"]), ("ORDER_INTENT_SELL_LONG", "0.0775", 14))
        p = pm_exit.sell_params("s", "no", 0.30, 3, "fok")
        self.assertEqual((p["intent"], p["price"]["value"]), ("ORDER_INTENT_SELL_SHORT", "0.7000"))  # long price
        self.assertEqual(pm_exit.print_price({"bid": None, "last": 0.08, "mid": 0.07}), (0.08, "last"))
        self.assertEqual(pm_exit.print_price({}), (None, None))
        self.assertEqual(pm_exit.net_position({"positions": {"s": {"netPosition": "-14"}}}, "s")[0], Decimal("14"))
        self.assertEqual(pm_exit.net_position({"positions": {}}, "s")[0], Decimal(0))
        self.assertEqual(pm_exit.venue_cash({"balances": [{"currentBalance": 274.7, "assetNotional": 1.2}]}),
                         (Decimal("274.7"), 1.2))

    def test_build_record_args(self) -> None:
        pos = {"id": "L1", "market": {"slug": "s"}}
        a = pm_exit.build_record_args(pos, "SELL1", {"state": "ORDER_STATE_FILLED", "createTime": "t"}, {"quantity": 14},
                                      "ioc", 0.0775, [{"f": 1}], [{"e": 1}], "invalidation", Decimal("274.7"), "", None,
                                      {"gate_results": {"forced": False}})
        self.assertEqual((a["position_id"], a["exit_reason"], a["order"]["size"]), ("L1", "invalidation", 14))
        self.assertEqual(a["cash"], "274.7")
        self.assertNotIn("allow_unpriced", a)
        a = pm_exit.build_record_args(pos, "SELL1", None, None, "ioc", None, [], [], "manual", None, "", "venue lost history", {})
        self.assertEqual((a["allow_unpriced"], a["unpriced_reason"]), (True, "venue lost history"))
        self.assertNotIn("cash", a)

    def test_watch_decision(self) -> None:
        self.assertEqual(pm_watch.watch_decision(None, 0.08), "no_print")
        self.assertEqual(pm_watch.watch_decision(0.08, 0.0858), "trip")
        self.assertEqual(pm_watch.watch_decision(0.0858, 0.0858), "trip")
        self.assertEqual(pm_watch.watch_decision(0.09, 0.0858), "hold_above_line")

    def test_fills_sync_plan(self) -> None:
        buys = pm_exit.entry_fills_for(pm_exit.parse_trades(TEN), {"CV44MW19GYH4"}, "yes")
        order = {"venue_order_id": "CV44MW19GYH4", "side": "buy", "fills": {"qty": "1.63"}, "invalidation_price": "0.0858"}
        self.assertEqual(pm_fills_sync.plan(order, buys, Decimal("14"))["action"], "record_and_open_or_add")
        p = pm_fills_sync.plan(order, buys, Decimal("0"))  # TEN/MIA today: already sold, so no new lot
        self.assertEqual(p["refuse"][0], "venue")
        self.assertEqual(Decimal(p["new_qty"]), Decimal("12.37"))
        self.assertEqual(pm_fills_sync.plan({**order, "fills": {"qty": "14"}}, buys, Decimal("14"))["action"], "none")
        self.assertEqual(pm_fills_sync.plan({**order, "side": "sell"}, buys, Decimal("14"))["refuse"][0], "input")
        self.assertEqual(pm_fills_sync.plan({**order, "invalidation_price": None}, buys, Decimal("14"))["refuse"][0], "input")

    def test_pnl_snapshot_args(self) -> None:
        now = datetime(2026, 10, 6, 14, tzinfo=timezone.utc)
        a = pm_pnl.snapshot_args({"balances": [{"currentBalance": 274.7, "assetNotional": 2.3}]}, "n", "0", now)
        self.assertEqual((a["cash"], a["equity"], a["as_of"]), ("274.7", "277.0", now.isoformat()))
        self.assertNotIn("equity", pm_pnl.snapshot_args({"balances": [{"currentBalance": 1}]}, "n", "0", now))
        with self.assertRaises(SystemExit):
            pm_pnl.snapshot_args({"balances": []}, "n", "0", now)


class CloseLesson(unittest.TestCase):
    def test_args_and_steward(self) -> None:
        self.assertEqual(lesson.steward_from_path("/x/oddsborne"), "oddsborne")
        self.assertEqual(lesson.steward_from_path("/x/bandit/"), "bandit")
        self.assertIsNone(lesson.steward_from_path("/x/other"))
        a = SimpleNamespace(position_id="L1", rationale="r", kind="trade_close_lesson", new_confidence=37.0, prior=None,
                            thesis=None, meta_json='{"k": 1}')
        self.assertEqual(lesson.lesson_args("oddsborne", a), {"steward": "oddsborne", "position_id": "L1", "rationale": "r",
                                                               "kind": "trade_close_lesson", "new_confidence": 37.0,
                                                               "meta": {"k": 1}})
        with self.assertRaises(SystemExit):
            lesson.lesson_args("bandit", SimpleNamespace(**{**a.__dict__, "meta_json": "[1]"}))


if __name__ == "__main__":
    unittest.main()
