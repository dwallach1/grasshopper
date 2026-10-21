"""edge6 meme_flush_rebound: prereg hash, locked rule (research/edge6_rule.py), scan parity and wiring.
Dependency-free: the scan's edge6_signal/_e2_bar are pulled out with ast, so the scan (network, secrets) never runs."""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import random
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE / "bandit" / "research"
SCAN = HERE / "bandit" / "scan_https_once.py"
SHA = "d4770a56b42bf33a1d1f7dcfd114c896ae3bbaec1c2d76f99fee8e8c12b893ca"
spec = importlib.util.spec_from_file_location("edge6_rule", RES / "edge6_rule.py")
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)


def _scan_fns():
    keep = [n for n in ast.parse(SCAN.read_text()).body if isinstance(n, ast.FunctionDef) and n.name in ("edge6_signal", "_e2_bar")]
    ns: dict = {}
    exec(compile(ast.Module(keep, []), str(SCAN), "exec"), ns)
    return ns


SC = _scan_fns()


def bars(closes, vol=1000.0, start=1_800_000_000):
    out = []; prev = closes[0]
    for i, c in enumerate(closes):
        o = prev; out.append([start + i * 300, o, max(o, c) * 1.001, min(o, c) * 0.999, c, vol]); prev = c
    return out


def flush_series(depth, n=80, vol=1000.0):
    """Flat at 1.0 for n-1 bars, then the last bar closes at 1 - depth (all within the 6h window)."""
    return bars([1.0] * (n - 1) + [1.0 - depth], vol=vol)


class Edge6(unittest.TestCase):
    def test_prereg_hash_locked(self):
        self.assertEqual(hashlib.sha256((RES / "edge6_prereg.md").read_bytes()).hexdigest(), SHA)
        self.assertTrue((RES / "edge6_prereg.sha256").read_text().startswith(SHA + "  edge6_prereg.md"))
        self.assertIn(SHA, (RES / "edge6_oos_run.py").read_text())

    def test_band_edges_and_volume_floor(self):
        H = 1.0 * 1.001                                   # the flat bars' high
        for depth, want in ((0.25, False), (1 - 0.70 * H + 1e-9, True), (0.40, True), (1 - 0.50 * H - 1e-9, True), (0.52, False)):
            b = flush_series(depth)
            self.assertEqual(bool(R.signal(b, len(b) - 1)), want, depth)
        thin = flush_series(0.40, vol=600.0)              # 72 bars x $600 = $43.2k < $50k
        self.assertIsNone(R.signal(thin, len(thin) - 1))
        self.assertIsNone(R.signal(flush_series(0.40), 71))   # needs t >= 72

    def test_edge2_bar_is_not_edge6(self):
        # 6h run +60% to a 1.6 peak close, decline to 1.0, then a reclaim bar closing 1.04 (65% of the peak close,
        # about 65% of the 6h high): an edge2 bar AND inside edge6's band -> edge2 has precedence
        cl = [1.0] * 25 + [1.0 + 0.6 * i / 30 for i in range(1, 31)] + [1.6] * 5 + [1.6 - 0.06 * i for i in range(1, 11)] + [1.0] * 5 + [1.04]
        b = bars(cl, vol=2000.0)
        t = len(b) - 1
        self.assertTrue(R.e2_bar(b, t))
        self.assertTrue(0.50 <= b[t][4] / max(x[2] for x in b[t-71:t+1]) <= 0.70)
        self.assertIsNone(R.signal(b, t))
        b2 = [list(x) for x in b]; b2[t][4] = 1.0          # same depth, no reclaim -> not edge2 -> edge6 signal
        self.assertFalse(R.e2_bar(b2, t)); self.assertIsNotNone(R.signal(b2, t))

    def test_scan_signal_matches_locked_rule(self):
        rnd = random.Random(6)
        for k in range(300):
            px = 1.0; cl = []
            for i in range(110):
                px *= 1 + rnd.gauss(0, 0.04) - (0.08 if rnd.random() < 0.03 else 0)
                cl.append(max(px, 1e-6))
            b = bars(cl, vol=rnd.choice([300.0, 800.0, 3000.0]))
            for t in range(60, len(b)):
                self.assertEqual(SC["edge6_signal"](b, t), R.signal(b, t), (k, t))
                self.assertEqual(SC["_e2_bar"](b, t), R.e2_bar(b, t), (k, t))

    def test_exit_path_kill_first_tp_and_stop(self):
        b = bars([1.0] * 60); i = 1
        b[5][2], b[5][3] = 1.6, 0.5                       # TP and kill in one bar -> kill
        self.assertEqual(R.exit_path(b, i)[:2], (R.KILL - 1, "kill"))
        b = bars([1.0] * 60); b[7][2] = 1.55
        self.assertEqual(R.exit_path(b, i)[:2], (R.TP - 1, "tp_full"))
        b = bars([1.0] * 60); b[48][4] = 1.1
        g, trig, xts, inc = R.exit_path(b, i)
        self.assertEqual((trig, inc), ("4h_stop", False)); self.assertAlmostEqual(g, 0.1, places=6)
        self.assertTrue(R.exit_path(bars([1.0] * 20), 1)[3])   # data ends early -> flagged

    def test_trades_dedupe_48_bars(self):
        cl = [1.0] * 79 + [0.6] * 100                     # flushed and stays flushed: signal on many bars
        tr = R.trades(bars(cl, vol=1000.0))
        self.assertGreaterEqual(len(tr), 1)
        for a, b_ in zip(tr, tr[1:]):
            self.assertGreaterEqual(b_["signal_ts"] - a["signal_ts"], 48 * 300)
            self.assertGreaterEqual(b_["signal_ts"], a["exit_ts"])
        self.assertTrue(all(abs(t["net"] - (t["gross"] - 0.02)) < 1e-12 for t in tr))

    def test_edge6_retired_default_off(self):
        s = SCAN.read_text()
        self.assertIn('E6_ENABLED = os.environ.get("BANDIT_E6_ENABLED", "0") == "1"', s)
        self.assertIn("for r in (universe345 if E6_ENABLED else []):", s)
        self.assertIn('out["edge6_enabled"] = E6_ENABLED', s)
        e6 = s[s.index("# ---- edge6"):s.index('out["edge3_checked"]')]
        # the only edge6 work outside the gated loop is loading state; the paper log sits inside the gated loop
        self.assertLess(e6.index("for r in (universe345 if E6_ENABLED else []):"), e6.index('_paper_log(r, "meme_flush_rebound"'))
        ns = {"os": __import__("os")}
        line = 'E6_ENABLED = os.environ.get("BANDIT_E6_ENABLED", "0") == "1"'
        import os as _os
        old = _os.environ.pop("BANDIT_E6_ENABLED", None)
        try:
            exec(line, ns); self.assertFalse(ns["E6_ENABLED"])
        finally:
            if old is not None: _os.environ["BANDIT_E6_ENABLED"] = old

    def test_scan_wiring(self):
        s = SCAN.read_text()
        for needle in ('_paper_log(r, "meme_flush_rebound", "edge6",', 'E6_STATE = os.environ.get("BANDIT_E6_STATE", "/workspace/bandit/_edge6_dedupe.json")',
                       'if r["mint"] in E2_HITS: edge6_logged.append((r["symbol"], None, "edge2_precedence")); continue',
                       'if r["mint"] in E345_HITS: edge6_logged.append((r["symbol"], None, "edge345_precedence")); continue',
                       'if last and b[t][0] - last < 4 * 3600: edge6_logged.append((r["symbol"], None, "dedupe_4h")); continue',
                       'prereg_entry_ts=b[t][0] + 300', '_save(E6_STATE, e6_state)', 'out["edge6_logged"] = edge6_logged',
                       'E345_HITS.add(r["mint"])', 'E345_HITS.update(_e5_syms)'):
            self.assertIn(needle, s, needle)
        # paper only: _paper_log defaults to blocked_by=PAPER_TAG ('paper_only') and edge6 does not override it
        self.assertIn('def _paper_log(r, thesis, suffix, reason, meta, blocked_by=PAPER_TAG', s)
        self.assertIn('PAPER_TAG = "paper_only"', s)
        e6 = s[s.index("# ---- edge6"):s.index('out["edge3_checked"]')]
        self.assertNotIn("blocked_by=", e6.split("_paper_log(")[1].split(")\n")[0])
        self.assertNotRegex(e6, r"place_order|live_trade|swap|execute")
        # the state write is inside the not-dry-run block and edge6 runs before it
        self.assertLess(s.index("# ---- edge6"), s.index("_save(E6_STATE, e6_state)"))
        self.assertIn("if not _no_log:\n    _save(E3_STATE, e3_state); _save(E4_STATE, e4_state); _save(E5_STATE, e5_state); _save(E6_STATE, e6_state)", s)


if __name__ == "__main__":
    unittest.main()
