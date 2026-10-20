"""ODDSBORNE pm_watch pre-kickoff fair-drift scratch (GRASSHOPPER ruling 10/20): a held sports YES lot before
kickoff whose current devig fair is more than 1c below entry trips with reason prekickoff_fair_drift (pm_exit sells
the full lot at the best bid); no pm_pnl from the watch on that trip. Post-kickoff / fair missing -> no scratch."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

import test_oddsborne_watch_pnl as T

W, X = T.W, T.X
LINES = __import__("lines")


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


class Client(T.FakeClient):
    """FakeClient whose market carries gameStartTime + team names (WAS long / SF short)."""

    def __init__(self, gst, bid="0.20", ask="0.22", last="0.21"):
        super().__init__(bid=bid, ask=ask, last=last)
        mkt = self.markets.retrieve_by_slug()["market"]
        self.calls.clear()
        mkt["gameStartTime"] = iso(gst)
        mkt["marketSides"] = [{"long": True, "id": "L", "team": {"name": "Washington Commanders"}},
                              {"long": False, "id": "S", "team": {"name": "San Francisco 49ers"}}]


def was_lot(entry="0.22", inval="0.10"):
    return {**T.lot("6faa297a", inval=inval), "average_cost": entry}


class FairDriftTests(unittest.TestCase):
    def setUp(self):
        self._orig = (W.current_fair, W.load_games)
        self.fetches = 0

        def lg():
            self.fetches += 1
            return [], []
        W.load_games = lg

    def tearDown(self):
        W.current_fair, W.load_games = self._orig

    def fair(self, v):
        W.current_fair = lambda m, games, gst, now: ({"fair": v, "method": "test"} if v is not None
                                                      else {"fair": None, "why": "no date-matched pre-game line"})

    def go(self, client, led, argv=("--position-id", "6faa297a")):
        return T.WatchPnlTests.run_main(self, list(argv), client, led)

    def future(self):
        return datetime.now(timezone.utc) + timedelta(hours=3)

    def test_was_case_fair_0198_scratches(self):
        self.fair(0.198)  # 0.198 < 0.22 - 0.01 = 0.21
        led, client = T.FakeLedger([was_lot()]), Client(self.future())
        rc, out, _ = self.go(client, led)
        self.assertEqual(rc, 10)
        self.assertEqual((out["watch_result"], out["trip_reason"]), ("trip", "prekickoff_fair_drift"))
        self.assertIn("--reason prekickoff_fair_drift", out["exit_command"])
        self.assertEqual(out["fair_drift"]["status"], "scratch")
        self.assertEqual(out["fair_drift"]["threshold"], 0.21)
        # exit first: no pm_pnl bookkeeping from the watch on a trip
        self.assertNotIn("oddsborne_pnl_snapshot", led.fns)
        self.assertNotIn("account.balances", client.calls)
        self.assertEqual(out["pm_pnl_refresh"]["decision"], "SKIPPED_TRIP")
        self.assertEqual(led.marks[0]["meta_patch"]["trip_reason"], "prekickoff_fair_drift")

    def test_fair_0215_holds(self):
        self.fair(0.215)
        led = T.FakeLedger([was_lot()])
        rc, out, _ = self.go(Client(self.future()), led)
        self.assertEqual((rc, out["watch_result"], out["fair_drift"]["status"]), (0, "hold_above_line", "ok"))
        self.assertEqual(len(led.pnl_rows), 1)

    def test_exactly_one_cent_below_holds(self):
        self.fair(0.21)  # "more than 1c below" -> 0.21 is not a scratch
        rc, out, _ = self.go(Client(self.future()), T.FakeLedger([was_lot()]))
        self.assertEqual((rc, out["fair_drift"]["status"]), (0, "ok"))

    def test_post_kickoff_no_fair_check(self):
        self.fair(0.10)
        led = T.FakeLedger([was_lot()])
        rc, out, _ = self.go(Client(datetime.now(timezone.utc) - timedelta(minutes=5)), led)
        self.assertEqual((rc, out["watch_result"]), (0, "hold_above_line"))
        self.assertNotIn("fair_drift", out)
        self.assertEqual(self.fetches, 0)

    def test_post_kickoff_invalidation_still_applies(self):
        self.fair(0.10)
        led = T.FakeLedger([was_lot(inval="0.20")])
        rc, out, _ = self.go(Client(datetime.now(timezone.utc) - timedelta(minutes=5)), led)
        self.assertEqual((rc, out["trip_reason"]), (10, "invalidation"))

    def test_fair_missing_no_scratch_logged(self):
        self.fair(None)
        led = T.FakeLedger([was_lot()])
        rc, out, err = self.go(Client(self.future()), led)
        self.assertEqual((rc, out["watch_result"], out["fair_drift"]["status"]), (0, "hold_above_line", "fair_unavailable"))
        self.assertIn("prekickoff fair unavailable", err)
        self.assertIsNone(out["fair_drift"]["fair"])

    def test_no_lot_without_gamestart_or_no_lines_fetch(self):
        self.fair(0.10)
        led = T.FakeLedger([was_lot()])
        rc, out, _ = self.go(T.FakeClient(bid="0.20"), led)  # no gameStartTime
        self.assertEqual(rc, 0)
        self.assertNotIn("fair_drift", out)
        self.assertEqual(self.fetches, 0)

    def test_one_line_fetch_per_pass(self):
        self.fair(0.215)
        led = T.FakeLedger([was_lot(), {**was_lot(), "id": "L2"}])
        self.go(Client(self.future()), led, argv=("--all-open",))
        self.assertEqual(self.fetches, 1)

    def test_current_fair_from_real_devig(self):
        """current_fair runs the session's lines.py devig on a Bovada quote; no line -> None (never invented)."""
        W.current_fair = self._orig[0]
        now = datetime.now(timezone.utc)
        gst = now + timedelta(hours=3)
        ml = LINES._ml([("Washington Commanders", 350), ("San Francisco 49ers", -450)])
        q = LINES._quote("bovada", "nfl", "WAS @ SF", ml, gst, False, now)
        m = Client(gst).markets.retrieve_by_slug()["market"]
        f = W.current_fair(m, LINES.group_games([q]), gst, now)
        self.assertIsNotNone(f["fair"])
        self.assertTrue(0.15 < f["fair"] < 0.22, f)
        self.assertIsNone(W.current_fair(m, [], gst, now)["fair"])
        self.assertIsNone(W.current_fair(m, None, gst, now)["fair"])

    def test_pm_exit_accepts_reason(self):
        self.assertIn("prekickoff_fair_drift", X.REASONS)


if __name__ == "__main__":
    unittest.main()
