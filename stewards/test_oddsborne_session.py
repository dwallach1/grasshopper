"""Same-game de-dup (maker_fee helpers) and static --dry-run guards for the oddsborne session scripts."""
from __future__ import annotations

import ast
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("maker_fee", HERE / "oddsborne" / "maker_fee.py")
MF = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MF)
SESSIONS = [HERE / "oddsborne" / f for f in ("session_daily.py", "session_pm.py")]


def run_loop(cands, comps, covered):
    """Mirror of the session entry loop: returns (attempted, same_game_skipped)."""
    taken = MF.held_game_keys(comps, covered)
    att, skip = [], []
    for p in sorted(cands, key=lambda x: x["post_fee_maker"], reverse=True):
        if MF.same_game_skip(p, taken, covered):
            skip.append((p["market"], p["outcome"]))
            continue
        taken.add(MF.game_key(p))
        att.append((p["market"], p["outcome"]))
    return att, skip


class DedupTests(unittest.TestCase):
    def c(self, ev, mkt, side, e):
        return {"event": ev, "market": mkt, "outcome": side, "post_fee_maker": e}

    def test_two_sides_of_one_market(self):
        a, s = run_loop([self.c("g1", "m1", "yes", 0.03), self.c("g1", "m1", "no", 0.02)], [], set())
        self.assertEqual(a, [("m1", "yes")])
        self.assertEqual(s, [("m1", "no")])

    def test_two_markets_same_game_keyed_by_event(self):
        a, s = run_loop([self.c("g1", "m1", "yes", 0.02), self.c("g1", "m1b", "no", 0.03)], [], set())
        self.assertEqual(a, [("m1b", "no")])
        self.assertEqual(s, [("m1", "yes")])

    def test_held_game_skipped_even_on_other_market(self):
        comps = [self.c("g1", "m1", "yes", 0), self.c("g1", "m1b", "yes", 0)]
        a, s = run_loop([self.c("g1", "m1b", "no", 0.05), self.c("g2", "m2", "yes", 0.02)], comps, {"m1"})
        self.assertEqual(a, [("m2", "yes")])
        self.assertEqual(s, [("m1b", "no")])

    def test_no_entry_count_cap(self):
        cands = [self.c(f"g{i}", f"m{i}", "yes", 0.01 + i / 1000) for i in range(6)]
        a, s = run_loop(cands, [], set())
        self.assertEqual(len(a), 6)
        self.assertEqual(s, [])

    def test_missing_event_falls_back_to_market_not_shared_none(self):
        a, _ = run_loop([self.c(None, "m1", "yes", 0.03), self.c(None, "m2", "yes", 0.02)], [], set())
        self.assertEqual(len(a), 2)


def _mentions_dry(node) -> bool:
    return any(isinstance(n, ast.Name) and n.id in ("DRY_RUN", "_no_enter") for n in ast.walk(node))


class DryRunGuardTests(unittest.TestCase):
    WRITE_CALLS = ("commit", "create", "oddsborne_touch_heartbeat")

    def test_every_write_path_is_dry_run_guarded(self):
        for path in SESSIONS:
            tree = ast.parse(path.read_text())
            for fn in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]:
                src = ast.get_source_segment(path.read_text(), fn) or ""
                writes = ".commit()" in src or "orders.create" in src or "pm_exit.py" in src
                if fn.name == "main":
                    continue  # main's write blocks are checked one by one below
                if writes:
                    self.assertTrue(_mentions_dry(fn), f"{path.name}:{fn.name} writes without a DRY_RUN guard")

    def test_main_write_blocks_guarded(self):
        for path in SESSIONS:
            text = path.read_text()
            tree = ast.parse(text)
            main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
            for node in ast.walk(main):
                if isinstance(node, ast.Try):
                    seg = ast.get_source_segment(text, node) or ""
                    body = "\n".join(ast.get_source_segment(text, b) or "" for b in node.body)
                    if ".commit()" in body:
                        self.assertIn("raise _DryRunNoWrite()", body.split("connect()")[0], f"{path.name}: commit block not dry-guarded")
            self.assertRegex(text, r'pid and DRY_RUN|subprocess.run\(\[x for x in cmd if x != "--dry-run"\]' )
            self.assertIn('if not DRY_RUN and os.environ.get("ODDS_LIVE") == "1"', text)

    def test_write_pnl_safe_returns_before_connect(self):
        for path in SESSIONS:
            text = path.read_text()
            body = text.split("def write_pnl_safe", 1)[1]
            self.assertLess(body.index("if DRY_RUN"), body.index("connect()"))


_dspec = importlib.util.spec_from_file_location("discover", HERE / "oddsborne" / "discover.py")
DISC = importlib.util.module_from_spec(_dspec)
_dspec.loader.exec_module(DISC)


class _NS:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeClient:
    """Read-only Polymarket US surface used by discover.py; records calls."""
    def __init__(self, events):
        self.calls = []

        def query(params):
            self.calls.append(("search", params))
            return {"events": events}

        def lst(params):
            self.calls.append(("list", params))
            return {"events": events if not params.get("offset") else []}

        def by_slug(slug):
            self.calls.append(("get", slug))
            return None
        self.search = _NS(query=query)
        self.events = _NS(list=lst, retrieve_by_slug=by_slug)


GAME = {"slug": "mlb-nyy-bos-2026-10-14", "title": "NYY @ BOS", "endDate": "2026-10-15T03:00:00Z",
        "markets": [{"slug": "aec-mlb-nyy-bos-2026-10-14"}]}
FED = {"slug": "usfed-fomc-2026-10-28", "title": "Fed", "endDate": "2026-10-28T18:00:00Z", "markets": []}


class DiscoverTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from datetime import datetime, timezone
        self.tmp = Path(tempfile.mkdtemp())
        self.now = datetime(2026, 10, 14, 13, 0, tzinfo=timezone.utc)
        self.kw = dict(raw_dir=self.tmp, now=self.now, sleep=lambda s: None, log=lambda *a, **k: None)

    def test_missing_output_runs_discovery_and_writes_dated_file(self):
        fc = FakeClient([GAME, FED])
        out = DISC.ensure("2026-10-14", "am", client=fc, **self.kw)
        self.assertEqual(out["n_seen"], 2)
        self.assertEqual(out["n_sports"], 1)
        self.assertTrue((self.tmp / "sweep_20261014_p2.json").exists())
        self.assertTrue(all(k in ("search", "list", "get") for k, _ in fc.calls))  # read-only endpoints only
        self.assertIn(("get", "temp-laxhigh-2026-10-15"), fc.calls)

    def test_pm_session_uses_pm_file(self):
        DISC.ensure("2026-10-14", "pm", client=FakeClient([GAME]), **self.kw)
        self.assertTrue((self.tmp / "sweep_20261014_pm_p2.json").exists())

    def test_fresh_output_reused_stale_or_empty_regenerated(self):
        from datetime import timedelta
        DISC.ensure("2026-10-14", "am", client=FakeClient([GAME]), **self.kw)
        fc = FakeClient([GAME, FED])
        self.assertEqual(DISC.ensure("2026-10-14", "am", client=fc, **self.kw)["n_seen"], 1)
        self.assertEqual(fc.calls, [])
        later = dict(self.kw, now=self.now + timedelta(hours=7))
        self.assertEqual(DISC.ensure("2026-10-14", "am", client=fc, **later)["n_seen"], 2)
        (self.tmp / "sweep_20261014_p2.json").write_text('{"n_seen": 0, "events": {}, "as_of": "2026-10-14T13:00:00Z"}')
        self.assertIn("empty", DISC.staleness(self.tmp / "sweep_20261014_p2.json", self.now))

    def test_zero_sports_with_games_is_error(self):
        out = DISC.ensure("2026-10-14", "am", client=FakeClient([FED]), **self.kw)
        self.assertEqual(out["n_sports"], 0)
        err = DISC.discovery_error(out, 0, 5)
        self.assertTrue(err and err.startswith("ERROR"))
        self.assertIsNone(DISC.discovery_error(out, 0, 0))
        self.assertIsNone(DISC.discovery_error(out, 3, 5))

    def test_zero_overall_is_error(self):
        out = DISC.ensure("2026-10-14", "am", client=FakeClient([]), **self.kw)
        self.assertTrue(DISC.discovery_error(out, 0, 0).startswith("ERROR"))
        self.assertTrue(DISC.discovery_error({}, 0, 0).startswith("ERROR"))

    def test_sessions_wire_discovery_and_error(self):
        for path in SESSIONS:
            text = path.read_text()
            self.assertIn("DISC.ensure(TODAY", text)
            self.assertIn("DISC.discovery_error(", text)
            self.assertIn('"ERROR" if discovery_error', text)
            self.assertIn("sys.exit(main())", text)
        self.assertIn("ERROR passlog", (HERE / "oddsborne" / "session_passlog.py").read_text())
        self.assertIn("deepdive_raw/discover.py", (HERE / "sync_box.sh").read_text())

    def test_sports_filter(self):
        self.assertTrue(DISC.is_sports_event("nfl-dal-phi-2026-10-18", {}))
        self.assertFalse(DISC.is_sports_event("nfl-most-passing-yards", {}))
        self.assertFalse(DISC.is_sports_event("usfed-2026", {}))


if __name__ == "__main__":
    unittest.main()
