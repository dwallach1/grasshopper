"""ODDSBORNE pm_watch -> pm_pnl: when the watch marks an open lot from the venue it also writes one pm_pnl row through
pm_pnl_snapshot.refresh_snapshot (cash + open lots at the venue mark, writer pm_watch). No mark -> no pm_pnl write;
a refused or failed refresh is a WARN that never changes the watch result or exit code (exits are not blocked)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "oddsborne"))
spec = importlib.util.spec_from_file_location("oddsborne_pm_watch_pnl", HERE / "oddsborne" / "pm_watch.py")
W = importlib.util.module_from_spec(spec)
spec.loader.exec_module(W)
sys.modules["pm_enter"].CALL_SLEEP = 0  # vcall spacing off (no venue here)

SLUG = "aec-nfl-was-sf-2026-10-19"
BAL = {"balances": [{"currentBalance": 40.0, "buyingPower": 40.0, "assetNotional": None}]}
POS = {"availablePositions": {SLUG: {"cashValue": {"value": "6.50"}}, "nfl-b": {"cashValue": {"value": "3.25"}}}}
UNVALUED = {"availablePositions": {SLUG: {"qty": 4}}}


class FakeClient:
    """Venue stub: market + BBO for the watch, balances + positions for the pm_pnl valuation. Counts calls."""

    def __init__(self, bid="0.52", ask="0.54", last="0.53", positions=POS, balances=BAL, status="MARKET_STATUS_OPEN", closed=False):
        self.calls = []
        market = {"slug": SLUG, "status": status, "closed": closed,
                  "marketSides": [{"long": True, "id": "L"}, {"long": False, "id": "S"}]}
        bbo = {"marketData": {"bestBid": {"value": bid} if bid else None, "bestAsk": {"value": ask} if ask else None,
                              "lastTradePx": {"value": last} if last else None, "state": "MARKET_STATE_OPEN"}}

        def rec(name, value):
            def f(*a, **k):
                self.calls.append(name)
                if isinstance(value, Exception):
                    raise value
                return value
            return f
        self.markets = SimpleNamespace(retrieve_by_slug=rec("markets.retrieve_by_slug", {"market": market}),
                                       bbo=rec("markets.bbo", bbo))
        self.account = SimpleNamespace(balances=rec("account.balances", balances))
        self.portfolio = SimpleNamespace(positions=rec("portfolio.positions", positions))


class FakeLedger:
    """steward-rpc stub: open positions, position_get, mark_position, pnl_snapshot (optionally failing)."""

    def __init__(self, lots, pnl_fail=False, updated=True):
        self.lots, self.pnl_fail, self.updated = {str(p["id"]): p for p in lots}, pnl_fail, updated
        self.marks, self.pnl_rows, self.fns = [], [], []

    def rpc(self, fn, args, idempotent=False):
        self.fns.append(fn)
        if fn == "oddsborne_open_positions":
            return [{"id": k} for k, p in self.lots.items() if p["status"] == "open"]
        if fn == "oddsborne_position_get":
            return self.lots.get(args["position_id"])
        if fn == "oddsborne_mark_position":
            self.marks.append(args)
            return {"updated": self.updated}
        if fn == "oddsborne_pnl_snapshot":
            if self.pnl_fail:
                raise RuntimeError("steward-rpc: HTTP 503 db_unreachable")
            self.pnl_rows.append(args)
            return {"pm_pnl_id": f"pnl-{len(self.pnl_rows)}", "equity": args["equity"], "cash": args["cash"]}
        raise AssertionError(f"unexpected rpc {fn}")


def lot(pid="L1", inval="0.1613", status="open"):
    return {"id": pid, "status": status, "outcome": "yes", "quantity": "4", "invalidation_price": inval,
            "market": {"slug": SLUG}}


class WatchPnlTests(unittest.TestCase):
    def run_main(self, argv, client, ledger):
        orig = (W._require_runtime, W.make_client, W.make_rpc)
        W._require_runtime = lambda *a, **k: None
        W.make_client, W.make_rpc = (lambda: client), (lambda: ledger.rpc)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = W.main(argv)
        finally:
            W._require_runtime, W.make_client, W.make_rpc = orig
        return rc, json.loads(out.getvalue()), err.getvalue()

    def test_mark_writes_one_pnl_row_same_valuation(self):
        led = FakeLedger([lot()])
        rc, out, err = self.run_main(["--position-id", "L1", "--routine", "r1"], FakeClient(), led)
        self.assertEqual(rc, 0)
        self.assertEqual(len(led.marks), 1)
        self.assertEqual(led.marks[0]["mark"], "0.52")
        self.assertEqual(len(led.pnl_rows), 1)
        row = led.pnl_rows[0]
        self.assertEqual(row["payload"]["writer"], "pm_watch")
        self.assertEqual(Decimal(row["cash"]), Decimal("40.0"))
        self.assertEqual(Decimal(row["equity"]), Decimal("49.75"))  # cash + open lots at venue cashValue
        self.assertEqual(row["payload"]["asset_source"], "portfolio.positions.cashValue")
        self.assertIn("r1", row["notes"])
        self.assertLess(led.fns.index("oddsborne_mark_position"), led.fns.index("oddsborne_pnl_snapshot"))
        self.assertEqual(out["pm_pnl_refresh"]["pm_pnl_id"], "pnl-1")
        self.assertEqual(out["watch_result"], "hold_above_line")
        self.assertNotIn("WARN", err)

    def test_all_open_writes_one_row_for_many_marks(self):
        led = FakeLedger([lot("L1"), lot("L2")])
        rc, out, _ = self.run_main(["--all-open"], FakeClient(), led)
        self.assertEqual((rc, len(led.marks), len(led.pnl_rows)), (0, 2, 1))
        self.assertIn("marked 2 open lot(s)", led.pnl_rows[0]["notes"])
        self.assertEqual(out["pm_pnl_refresh"]["decision"], "WRITTEN")

    def test_no_mark_no_pnl_write(self):
        for client, lots in ((FakeClient(), []),                                     # no open lots
                             (FakeClient(bid=None, ask=None, last=None), [lot()]),               # no venue print: not marked
                             (FakeClient(status="MARKET_STATUS_RESOLVED", closed=True), [lot()])):  # settled
            led = FakeLedger(lots)
            rc, out, _ = self.run_main(["--all-open"], client, led)
            self.assertEqual((led.marks, led.pnl_rows), ([], []))
            self.assertNotIn("oddsborne_pnl_snapshot", led.fns)
            self.assertNotIn("account.balances", client.calls)
            self.assertNotIn("pm_pnl_refresh", out)
        led = FakeLedger([lot()], updated=False)  # ledger refused the mark: nothing marked, no pm_pnl
        _, out, _ = self.run_main(["--position-id", "L1"], FakeClient(), led)
        self.assertEqual(led.pnl_rows, [])
        self.assertNotIn("pm_pnl_refresh", out)

    def test_unvalued_position_refuses_warns_and_watch_continues(self):
        led = FakeLedger([lot()])
        rc, out, err = self.run_main(["--position-id", "L1"], FakeClient(positions=UNVALUED), led)
        self.assertEqual(rc, 0)
        self.assertEqual(len(led.marks), 1)  # the mark still landed
        self.assertEqual(led.pnl_rows, [])   # never an invented mark
        self.assertNotIn("oddsborne_pnl_snapshot", led.fns)
        self.assertIn("WARN pm_pnl refresh failed", err)
        self.assertEqual(out["pm_pnl_refresh"]["decision"], "WARN")
        self.assertIn("invented mark", out["pm_pnl_refresh"]["warn"])

    def test_rpc_failure_on_trip_keeps_trip_exit_code(self):
        led = FakeLedger([lot(inval="0.60")], pnl_fail=True)
        rc, out, err = self.run_main(["--position-id", "L1"], FakeClient(), led)
        self.assertEqual(rc, 10)  # trip still signalled so the wrapper runs pm_exit
        self.assertEqual(out["watch_result"], "trip")
        self.assertIn("pm_exit.py --position-id L1", out["exit_command"])
        self.assertIn("WARN pm_pnl refresh failed", err)
        self.assertIn("db_unreachable", out["pm_pnl_refresh"]["warn"])

    def test_venue_balance_failure_warns(self):
        led = FakeLedger([lot()])
        rc, out, err = self.run_main(["--position-id", "L1"], FakeClient(balances=ValueError("boom")), led)
        self.assertEqual((rc, len(led.marks), led.pnl_rows), (0, 1, []))
        self.assertIn("WARN pm_pnl refresh failed: ValueError: boom", err)

    def test_dry_run_writes_nothing_reports_would_write(self):
        led = FakeLedger([lot()])
        rc, out, _ = self.run_main(["--position-id", "L1", "--dry-run"], FakeClient(), led)
        self.assertEqual((rc, led.marks, led.pnl_rows), (0, [], []))
        self.assertEqual(out["pm_pnl_refresh"]["decision"], "DRY_RUN_OK")
        ww = out["pm_pnl_refresh"]["would_write"]
        self.assertEqual((ww["fn"], ww["args"]["payload"]["writer"]), ("oddsborne_pnl_snapshot", "pm_watch"))
        self.assertEqual(Decimal(ww["args"]["equity"]), Decimal("49.75"))

    def test_watch_never_sweeps_decision_markets(self):
        text = (HERE / "oddsborne" / "pm_watch.py").read_text()
        self.assertNotIn("sweep", text.replace("no pm_decision_markets sweep", ""))
        self.assertIn("PS.refresh_snapshot(", text)


if __name__ == "__main__":
    unittest.main()
