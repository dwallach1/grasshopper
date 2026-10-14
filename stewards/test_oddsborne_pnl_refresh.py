"""ODDSBORNE pm_pnl refresh: sessions refresh the book row over HTTPS before the entry gate, dry-run writes
nothing, a failed refresh is a loud ERROR that blocks entries, and equity = cash + open lots at the venue mark."""
from __future__ import annotations

import ast
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "oddsborne"))
import pm_pnl_snapshot as PS  # noqa: E402

SESSIONS = [HERE / "oddsborne" / f for f in ("session_daily.py", "session_pm.py")]
BAL = {"balances": [{"currentBalance": 40.0, "buyingPower": 40.0, "assetNotional": None}]}
POS = {"availablePositions": {"mlb-a": {"cashValue": {"value": "6.50"}}, "nfl-b": {"cashValue": {"value": "3.25"}}}}


def load_write_pnl_safe(path: Path, dry_run: bool, out: Path):
    """Exec the session's own write_pnl_safe source with its module globals stubbed (no venue, no network)."""
    text = path.read_text()
    fn = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == "write_pnl_safe")
    g = {"DRY_RUN": dry_run, "OUT": out, "SESSION": "20261015_test", "json": json,
         "datetime": datetime, "timezone": timezone}
    exec(compile(ast.Module([fn], []), str(path), "exec"), g)
    return g["write_pnl_safe"]


class FakeLedger:
    """oddsborne_pnl_snapshot + the guidance stale_book gate (book age > 360 min -> refused)."""

    def __init__(self, last_as_of, fail=False):
        self.rows, self.last, self.fail = [], last_as_of, fail

    def rpc(self, fn, args, idempotent=False):
        assert fn == "oddsborne_pnl_snapshot"
        if self.fail:
            raise RuntimeError("steward-rpc: HTTP 503 db_unreachable")
        self.rows.append(args)
        self.last = datetime.fromisoformat(args["as_of"])
        return {"pm_pnl_id": f"id-{len(self.rows)}", "equity": args["equity"], "cash": args["cash"]}

    def entries_allowed(self, now):
        return (now - self.last) <= timedelta(minutes=360)


class ValuationTests(unittest.TestCase):
    def test_equity_includes_open_lots_from_positions(self):
        v = PS.venue_valuation(BAL, POS)
        self.assertEqual(v["equity"], Decimal("49.75"))
        a = PS.snapshot_args(BAL, "n", "0", datetime.now(timezone.utc), POS)
        self.assertEqual(Decimal(a["equity"]), Decimal("49.75"))
        self.assertEqual(Decimal(a["cash"]), Decimal("40.0"))

    def test_asset_notional_preferred(self):
        bal = {"balances": [{"currentBalance": 10, "assetNotional": 5}]}
        self.assertEqual(PS.venue_valuation(bal, POS)["equity"], Decimal("15"))

    def test_no_positions_equity_is_cash(self):
        self.assertEqual(PS.venue_valuation(BAL, {"availablePositions": {}})["equity"], Decimal("40.0"))

    def test_unvalued_position_refuses_never_invents(self):
        with self.assertRaises(ValueError):
            PS.venue_valuation(BAL, {"availablePositions": {"x": {"qty": 3}}})

    def test_snapshot_script_passes_positions(self):
        self.assertIn("vcall(c.portfolio.positions)", (HERE / "oddsborne" / "pm_pnl_snapshot.py").read_text())


class SessionRefreshTests(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        self.snap = {"bal": BAL, "pos": POS}

    def test_stale_snapshot_refreshed_then_entries_allowed(self):
        for path in SESSIONS:
            now = datetime.now(timezone.utc)
            led = FakeLedger(now - timedelta(hours=30))
            self.assertFalse(led.entries_allowed(now))
            pnl_id, hb, _, _ = load_write_pnl_safe(path, False, self.out)(self.snap, "notes", rpc=led.rpc)
            self.assertEqual(pnl_id, "id-1")
            self.assertEqual(Decimal(led.rows[0]["equity"]), Decimal("49.75"))  # open lots included
            self.assertTrue(led.entries_allowed(datetime.now(timezone.utc)))

    def test_refresh_failure_raises(self):
        for path in SESSIONS:
            led = FakeLedger(datetime.now(timezone.utc) - timedelta(hours=30), fail=True)
            with self.assertRaises(RuntimeError):
                load_write_pnl_safe(path, False, self.out)(self.snap, "notes", rpc=led.rpc)

    def test_dry_run_writes_nothing(self):
        for path in SESSIONS:
            led = FakeLedger(datetime.now(timezone.utc) - timedelta(hours=30))
            pnl_id, hb, _, _ = load_write_pnl_safe(path, True, self.out)(self.snap, "notes", rpc=led.rpc)
            self.assertEqual((pnl_id, hb), ("DRY_RUN", "DRY_RUN"))
            self.assertEqual(led.rows, [])
            ww = json.loads((self.out / "session_raw_20261015_test_pnl_would_write.json").read_text())
            self.assertEqual(Decimal(ww["would_write"]["args"]["equity"]), Decimal("49.75"))

    def test_main_refreshes_before_entry_gate_and_errors_loudly(self):
        for path in SESSIONS:
            text = path.read_text()
            main = text.split("def main():", 1)[1]
            self.assertLess(main.index("write_pnl_safe(snap, notes0)"), main.index("ENTER_ATTEMPT"))
            self.assertIn('pnl_refresh_error = f"ERROR pm_pnl refresh failed', main)
            self.assertIn('or bool(pnl_refresh_error)' if path.name == "session_pm.py" else '_no_enter = bool(pnl_refresh_error)', main)
            self.assertIn("if discovery_error or pnl_refresh_error:", main)
            self.assertNotIn('os.environ.get("PNL_ID"', main)


if __name__ == "__main__":
    unittest.main()
