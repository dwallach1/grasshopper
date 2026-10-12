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


if __name__ == "__main__":
    unittest.main()
