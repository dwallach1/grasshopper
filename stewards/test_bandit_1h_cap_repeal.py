"""Desk rule #127 bandit-1h-entry-cap (+30%) repealed 2026-10-18: no cap gate, no 1h_cap_30 auto-log; the +200%
ceiling is back; coins above +30% are tagged meta.hot_1h / meta.chg_1h on every decision the scan logs (non-blocking).
Dependency-free: functions are pulled out of the scan with ast; the scan itself never runs."""
from __future__ import annotations

import ast
import sys
import types
import unittest
from pathlib import Path

SCAN = Path(__file__).resolve().parent / "bandit" / "scan_https_once.py"
SRC = SCAN.read_text()
TREE = ast.parse(SRC)


def _fns(*names, **ns):
    keep = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(keep, []), str(SCAN), "exec"), ns)
    return ns


NS = _fns("_hot_meta", HOT_1H_PCT=30)
hot = NS["_hot_meta"]


class CapRepealed(unittest.TestCase):
    def test_cap_gate_and_autolog_removed(self):
        for gone in ("1h_cap_30", "CAP_TAG", "cap_blocked", "cap_logged", "CAP_BLOCKED", "% > +30%\"", "pc1 > 30", "_1hcap"):
            self.assertNotIn(gone, SRC, gone)
        self.assertIn('if pc1 is not None and pc1 > 200: f.append(f"1h +{pc1:.0f}% > +200%")', SRC)
        self.assertIn("repealed by GRASSHOPPER 2026-10-18", SRC)

    def test_hot_meta_values(self):
        self.assertEqual(hot({"pc1h": 45.123}), {"hot_1h": True, "chg_1h": 45.12})
        self.assertEqual(hot({"pc1h": 30}), {"hot_1h": False, "chg_1h": 30.0})       # strictly above +30%
        self.assertEqual(hot({"pc1h": "31.5"}), {"hot_1h": True, "chg_1h": 31.5})
        self.assertEqual(hot({"pc1h": -12}), {"hot_1h": False, "chg_1h": -12.0})
        self.assertEqual(hot({"pc1h": 250}), {"hot_1h": True, "chg_1h": 250.0})
        for unknown in ({"pc1h": None}, {}, None, {"pc1h": "n/a"}):
            self.assertEqual(hot(unknown), {})                                        # never guessed

    def test_every_log_decision_call_carries_the_tag(self):
        calls = []
        for fn in [TREE] + [n for n in TREE.body if isinstance(n, ast.FunctionDef)]:
            for node in ast.walk(fn):
                if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "log_decision":
                    calls.append(node)
        calls = list({id(c): c for c in calls}.values())
        self.assertEqual(len(calls), 3)                     # thesis_paused, edge2, _paper_log (edge3-6, edge5 voids)
        pl = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "_paper_log")
        pl_calls = {id(n) for n in ast.walk(pl)}
        self.assertEqual(ast.unparse(pl.body[1]), "meta = _log_meta(r, meta)")   # first statement after the docstring (audit + hot tag)
        for c in calls:
            meta = next(k.value for k in c.keywords if k.arg == "meta")
            if id(c) in pl_calls:
                self.assertEqual(ast.unparse(meta), "meta")
            else:
                self.assertIn("_log_meta(r", ast.unparse(meta))       # _log_meta = audit fields + _hot_meta

    def test_paper_log_passes_tag_through(self):
        got = []
        fake = types.SimpleNamespace(log_decision=lambda steward, **kw: got.append(kw) or {"ok": True, "id": 1})
        ns = _fns("_paper_log", "_hot_meta", "_audit_meta", "_log_meta", HOT_1H_PCT=30, LIQ_SRC="jupiter_tokens_v2_total", PAPER_TAG="paper_only", _no_log=False,
                  _px_sol=lambda r: (1e-6, 0.001, None), _dec_pt="2026-10-18T06:00:00-07:00", _stamp="20261018T0600")
        old = sys.modules.get("steward_rpc"); sys.modules["steward_rpc"] = fake
        try:
            ns["_paper_log"]({"mint": "MintHot111", "symbol": "HOT", "pc1h": 88.0}, "meme_flush_rebound", "edge6", "r", {"edge6": {"x": 1}})
            ns["_paper_log"]({"mint": "MintCold11", "symbol": "COLD", "pc1h": 4.0}, "meme_range_breakout", "edge3", "r", {"edge3": {}})
            ns["_paper_log"]({"mint": "MintStub11", "symbol": "STUB"}, "meme_liq_accum", "edge5", "r", {"edge5": {}})
        finally:
            if old is None: sys.modules.pop("steward_rpc", None)
            else: sys.modules["steward_rpc"] = old
        self.assertEqual(got[0]["meta"], {"edge6": {"x": 1}, "mint": "MintHot111", "hot_1h": True, "chg_1h": 88.0})
        self.assertEqual(got[1]["meta"], {"edge3": {}, "mint": "MintCold11", "hot_1h": False, "chg_1h": 4.0})
        self.assertEqual(got[2]["meta"], {"edge5": {}, "mint": "MintStub11"})         # no 1h change known -> no tag
        self.assertTrue(all(g["blocked_by"] == "paper_only" for g in got))


if __name__ == "__main__":
    unittest.main()
