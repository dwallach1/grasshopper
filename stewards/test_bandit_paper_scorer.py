"""paper_path_score.py: unit tests + offline parity with edge2_path_score.py (fixed rows, fixed bars, no network).

Dependency-free: `requests` and `steward_rpc` are stubbed in sys.modules before import, and each module's `gt()`
(GeckoTerminal) is replaced by a fixture server, so nothing touches the network or the ledger.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

BANDIT = Path(__file__).resolve().parent / "bandit"


def _load(fname, modname):
    """Import a scorer with `requests` / `steward_rpc` stubbed only for the import, then restore sys.modules
    (so other test modules in the same run still see the real ones)."""
    saved = {n: sys.modules.get(n) for n in ("requests", "steward_rpc")}
    for n in saved:
        m = types.ModuleType(n)
        m.call = lambda *a, **k: []          # steward_rpc.call; replaced per test
        m.get = lambda *a, **k: None         # requests.get; never reached (gt() is replaced)
        sys.modules[n] = m
    try:
        spec = importlib.util.spec_from_file_location(modname, BANDIT / fname)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for n, m in saved.items():
            if m is None: sys.modules.pop(n, None)
            else: sys.modules[n] = m


PS = _load("paper_path_score.py", "paper_path_score_under_test")
E2 = _load("edge2_path_score.py", "edge2_path_score_under_test")
BAR = 300
T0 = 1_767_225_600                      # 2026-01-01 00:00 UTC (bar aligned)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def flat(start, n, px=1.0, close=None):
    """n flat 5m bars from `start`: [ts, o, h, l, c, v]; optional final close."""
    b = [[start + i * BAR, px, px * 1.02, px * 0.98, px, 1000.0] for i in range(n)]
    if close is not None:
        b[-1][4] = close
    return b


def with_bar(bars, i, **kw):
    o, h, l, c = bars[i][1:5]
    bars[i] = [bars[i][0], kw.get("o", o), kw.get("h", h), kw.get("l", l), kw.get("c", c), bars[i][5]]
    return bars


class Fixture:
    """GeckoTerminal stand-in: pools per mint (top reserve 'POOL_<mint>', a decoy) and bars per pool."""

    def __init__(self, bars_by_pool, no_pool=()):
        self.bars = bars_by_pool; self.no_pool = set(no_pool); self.calls = []

    def __call__(self, path, params=None):
        self.calls.append(path)
        params = params or {}
        if path.endswith("/pools"):
            mint = path.split("/")[3]
            if mint in self.no_pool:
                return {"data": []}
            return {"data": [{"attributes": {"address": f"DECOY_{mint}", "reserve_in_usd": "10"}},
                             {"attributes": {"address": f"POOL_{mint}", "reserve_in_usd": "5000"}}]}
        pool = path.split("/")[3]
        before = params.get("before_timestamp", 10**12)
        rows = [b for b in self.bars.get(pool, []) if b[0] < before]
        return {"data": {"attributes": {"ohlcv_list": list(reversed(rows))}}}


# ---- edge2 parity fixture: every exit path plus the unscored / open cases --------------------------------------
def edge2_fixture(now_ts):
    s = lambda k: T0 + k * 86400                # each pass on its own day
    bars, rows = {}, []

    def add(i, mint, decided, b):
        bars[f"POOL_{mint}"] = b
        rows.append({"decision_id": i, "decision": "skip", "thesis_id": "meme_pullback_reclaim", "instrument": mint,
                     "decided_at": iso(decided), "book_price": 1e-6, "source_id": f"fx_{i}"})

    add(1, "TP", s(1) + 10, with_bar(flat(s(1) + BAR, 48), 5, h=1.6))                    # +50% full exit
    add(2, "KILL", s(2) + 10, with_bar(flat(s(2) + BAR, 48), 7, l=0.55))                 # -40% kill
    add(3, "BOTH", s(3) + 10, with_bar(flat(s(3) + BAR, 48), 3, h=1.7, l=0.5))           # same bar -> kill wins
    add(4, "STOP_UP", s(4), flat(s(4), 48, close=1.10))                                  # aligned decided_at, 4h stop
    add(5, "STOP_DN", s(5) + 299, flat(s(5) + BAR, 48, close=0.85))
    add(6, "STOP_FLAT", s(6) + 1, flat(s(6) + BAR, 48, close=1.0))
    add(7, "NOENTRY", s(7) + 10, flat(s(7) + 2 * BAR, 48))                               # entry bar missing
    add(8, "SHORT", s(8) + 10, flat(s(8) + BAR, 30))                                     # window incomplete
    add(9, "NOPOOL", s(9) + 10, [])
    add(10, "OPEN", now_ts - 3600, flat(int(now_ts - 3600) // BAR * BAR, 12))            # 4h not closed
    add(11, "TP2", s(11) + 10, with_bar(flat(s(11) + BAR, 48), 47, h=1.5))               # TP on the last bar
    return rows, bars


class Parity(unittest.TestCase):
    def test_edge2_matches_edge2_path_score(self):
        now_ts = datetime.now(timezone.utc).timestamp()
        rows, bars = edge2_fixture(now_ts)
        res = {}
        for mod, outfile in ((E2, "edge2_paper_scores.json"), (PS, "paper_scores.json")):
            fx = Fixture(bars, no_pool={"NOPOOL"})
            with tempfile.TemporaryDirectory() as d, mock.patch.object(mod, "gt", fx), \
                    mock.patch.object(mod, "call", lambda *a, **k: rows), \
                    mock.patch.object(sys, "argv", ["x", "--out-dir", d] + (["--thesis", "meme_pullback_reclaim"] if mod is PS else [])), \
                    mock.patch("builtins.print"):
                mod.main()
                res[mod] = json.loads((Path(d) / outfile).read_text())
        old = {r["decision_id"]: r for r in res[E2]["passes"]}
        new = {r["decision_id"]: r for r in res[PS]["passes"]}
        self.assertEqual(old.keys(), new.keys())
        for k in old:
            for f in ("status", "net_pct", "gross_pct", "exit_trigger", "entry_usd", "exit_ts", "pool"):
                self.assertEqual(old[k].get(f), new[k].get(f), (k, f))
        so, sn = res[E2]["summary"], res[PS]["summary"][0]
        for f in ("passes", "n_scored", "n_open", "n_unscored", "mean_net_pct", "mean_net_top2_removed_pct", "promotion_bar_met"):
            self.assertEqual(so[f], sn[f], f)
        # the fixture really exercises every path
        st = {k: (v.get("status"), v.get("exit_trigger")) for k, v in old.items()}
        self.assertEqual(st[1], ("scored", "tp_full")); self.assertEqual(st[2], ("scored", "kill"))
        self.assertEqual(st[3], ("scored", "kill")); self.assertEqual(st[4][1], "4h_stop")
        self.assertEqual(st[7][0], "unscored"); self.assertEqual(st[8][0], "unscored")
        self.assertEqual(st[9][0], "unscored"); self.assertEqual(st[10][0], "open")
        self.assertEqual(st[11], ("scored", "tp_full"))
        self.assertEqual(old[1]["net_pct"], 48.0); self.assertEqual(old[2]["net_pct"], -42.0)
        self.assertEqual(new[4]["entry_ts"], T0 + 4 * 86400)                                  # aligned decided_at


# ---- edge3/4/5 unit tests --------------------------------------------------------------------------------------
def row(i, thesis, mint, decided, meta=None, blocked_by="paper_only"):
    r = {"decision_id": i, "decision": "skip", "thesis_id": thesis, "instrument": mint, "decided_at": iso(decided),
         "book_price": 1e-6, "source_id": f"fx_{i}", "blocked_by": blocked_by}
    if meta is not None:
        r["meta"] = meta
    return r


class Scorer(unittest.TestCase):
    NOW = datetime.fromtimestamp(T0 + 30 * 86400, timezone.utc)

    def run_rows(self, thesis, rows, bars):
        fx = Fixture(bars)
        with mock.patch.object(PS, "gt", fx), mock.patch.object(PS, "call", lambda *a, **k: rows):
            s, out = PS.run_thesis(thesis, PS.THESES[thesis], self.NOW)
        return s, {r["decision_id"]: r for r in out}, fx

    def test_edge3_entry_and_pool_from_meta(self):
        e = T0 + 86400 + 7 * BAR                       # prereg_entry_ts: NOT the bar after decided_at
        bars = {"P_META": with_bar(flat(e, 48), 2, h=1.6)}
        rows = [row(1, "meme_range_breakout", "M", e + 40 * 60, {"edge3": {"prereg_entry_ts": e, "pool": "P_META"}})]
        s, out, fx = self.run_rows("meme_range_breakout", rows, bars)
        self.assertEqual(out[1]["status"], "scored"); self.assertEqual(out[1]["entry_ts"], e)
        self.assertEqual(out[1]["pool"], "P_META"); self.assertEqual(out[1]["exit_trigger"], "tp_full")
        self.assertFalse(any(c.endswith("/pools") for c in fx.calls))      # meta pool used, no pool lookup

    def test_edge4_meta_as_json_string_uses_mig_pool(self):
        e = T0 + 2 * 86400
        bars = {"MIG": flat(e, 48, close=1.2), "POOL_M": with_bar(flat(e, 48), 1, l=0.1)}
        rows = [row(1, "meme_grad_pullback", "M", e + 600, json.dumps({"edge4": {"prereg_entry_ts": e, "mig_pool": "MIG"}}))]
        s, out, _ = self.run_rows("meme_grad_pullback", rows, bars)
        self.assertEqual((out[1]["pool"], out[1]["exit_trigger"]), ("MIG", "4h_stop"))
        self.assertAlmostEqual(out[1]["net_pct"], 18.0)

    def test_missing_meta_is_unscored_not_guessed(self):
        rows = [row(1, "meme_range_breakout", "M", T0 + 86400)]
        s, out, fx = self.run_rows("meme_range_breakout", rows, {})
        self.assertEqual(out[1]["status"], "unscored"); self.assertIn("prereg_entry_ts", out[1]["why"])
        self.assertEqual(fx.calls, []); self.assertEqual(s["n_scored"], 0)

    def test_edge5_entry_is_first_bar_after_decided_at(self):
        d = T0 + 3 * 86400 + 123                        # next-scan log time
        bars = {"POOL_M": flat(d - 123 + BAR, 48, close=0.9)}
        s, out, _ = self.run_rows("meme_liq_accum", [row(1, "meme_liq_accum", "M", d)], bars)
        self.assertEqual(out[1]["entry_ts"], d - 123 + BAR); self.assertAlmostEqual(out[1]["net_pct"], -12.0)

    def test_4h_dedupe_by_entry_time(self):
        e = T0 + 4 * 86400
        m = lambda t: {"edge3": {"prereg_entry_ts": t, "pool": "P"}}
        rows = [row(1, "meme_range_breakout", "A", e + 60, m(e)),
                row(2, "meme_range_breakout", "A", e + 3 * 3600, m(e + 3 * 3600)),        # < 4h -> dup
                row(3, "meme_range_breakout", "A", e + 4 * 3600, m(e + 4 * 3600)),        # exactly 4h -> counts
                row(4, "meme_range_breakout", "B", e + 60, m(e))]                          # other coin -> counts
        bars = {"P": flat(e, 48 * 3 + 12)}
        s, out, _ = self.run_rows("meme_range_breakout", rows, bars)
        self.assertEqual([out[i]["status"] for i in (1, 2, 3, 4)], ["scored", "dup_4h", "scored", "scored"])
        self.assertEqual((s["n_scored"], s["n_dup_4h"]), (3, 1))

    def test_open_window(self):
        e = int(self.NOW.timestamp()) // BAR * BAR - 3600
        rows = [row(1, "meme_range_breakout", "M", e, {"edge3": {"prereg_entry_ts": e, "pool": "P"}})]
        s, out, fx = self.run_rows("meme_range_breakout", rows, {"P": flat(e, 12)})
        self.assertEqual(out[1]["status"], "open"); self.assertEqual(fx.calls, []); self.assertEqual(s["n_open"], 1)

    def test_voids_counted_separately_never_scored_or_deduped_against(self):
        d = T0 + 5 * 86400
        rows = [row(1, "meme_liq_accum", "M", d, {"void": {"reason": "stale_2h"}, "blocked_by": "paper_void_stale"}, blocked_by="paper_void_stale"),
                row(2, "meme_liq_accum", "M", d + 60),                                       # same coin, minutes later
                row(3, "meme_liq_accum", "N", d, {"blocked_by": "paper_void_stale"}, blocked_by=None)]   # tag only in meta
        s, out, _ = self.run_rows("meme_liq_accum", rows, {"POOL_M": flat(d // BAR * BAR + BAR, 60)})
        self.assertEqual(out[1]["status"], "void"); self.assertIn("stale_2h", out[1]["why"])
        self.assertEqual(out[3]["status"], "void")
        self.assertEqual(out[2]["status"], "scored")                                        # not a dup of the void
        self.assertEqual((s["n_void"], s["n_scored"], s["n_dup_4h"], s["passes"]), (2, 1, 0, 3))

    def test_new_bar_mean_minus_se_and_top2(self):
        cfg = PS.THESES["meme_liq_accum"]
        mk = lambda vals: [{"status": "scored", "net_pct": v} for v in vals]
        good = PS.summarize("meme_liq_accum", cfg, mk([5.0] * 18 + [6.0, 4.0]), 20, self.NOW)
        self.assertTrue(good["promotion_bar_met"])
        few = PS.summarize("meme_liq_accum", cfg, mk([5.0] * 19), 19, self.NOW)
        self.assertFalse(few["promotion_bar_met"])                                           # n < 20
        noisy = PS.summarize("meme_liq_accum", cfg, mk([48.0, -42.0] * 10), 20, self.NOW)     # mean +3, SE ~10
        self.assertLess(noisy["mean_minus_se_pct"], 0); self.assertFalse(noisy["promotion_bar_met"])
        carried = PS.summarize("meme_liq_accum", cfg, mk([200.0, 200.0] + [-1.0] * 18), 20, self.NOW)
        self.assertLess(carried["mean_net_top2_removed_pct"], 0); self.assertFalse(carried["promotion_bar_met"])
        # edge2 keeps its locked bar: only n >= 20 and top-2-removed mean > 0 (no SE test)
        e2 = PS.summarize("meme_pullback_reclaim", PS.THESES["meme_pullback_reclaim"], mk([48.0, -42.0] * 9 + [48.0, 48.0]), 20, self.NOW)
        self.assertTrue(e2["promotion_bar_met"]); self.assertLess(e2["mean_minus_se_pct"], 0)


if __name__ == "__main__":
    unittest.main()
