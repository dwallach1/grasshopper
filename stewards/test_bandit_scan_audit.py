"""Scan audit fields (GRASSHOPPER 2026-10-19): every decision the hourly scan logs carries meta.mint / liq_usd / liq_src /
age_h next to hot_1h / chg_1h; NEAR/CLEAR lines show mint[:8] beside the symbol; each scan output is archived into a dated
directory pruned to 7 days. Dependency-free: functions are pulled out of the scan with ast; the scan itself never runs."""
from __future__ import annotations

import ast
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
SCAN = HERE / "bandit" / "scan_https_once.py"
SRC = SCAN.read_text()
TREE = ast.parse(SRC)
PT = ZoneInfo("America/Los_Angeles")
LIQ_SRC = "jupiter_tokens_v2_total"


def _fns(*names, **ns):
    keep = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in keep} == set(names), names
    exec(compile(ast.Module(keep, []), str(SCAN), "exec"), ns)
    return ns


NS = _fns("_audit_meta", "_log_meta", "_hot_meta", "_sym_mint", HOT_1H_PCT=30, LIQ_SRC=LIQ_SRC)
ROW = {"mint": "D3S6J9s1byrNBt3ZKwEDiPsNRqHtoEP8zQKdhyBdpump", "symbol": "PIERRE", "liq": 231833.72919704317,
       "age_h": 19.982709908055558, "pc1h": 14.200239865560595}


class AuditMeta(unittest.TestCase):
    def test_constant_and_thresholds_untouched(self):
        self.assertIn('LIQ_SRC = "jupiter_tokens_v2_total"', SRC)
        self.assertIn("MIN_LIQ = 100_000", SRC)
        self.assertIn("MAX_AGE_H = 14 * 24", SRC)
        self.assertIn('universe345 = [r for r in elig if r["liq"] >= MIN_LIQ and r["age_h"] is not None and r["age_h"] < MAX_AGE_H]', SRC)

    def test_audit_values(self):
        self.assertEqual(NS["_audit_meta"](ROW), {"mint": ROW["mint"], "liq_usd": 231833.73, "liq_src": LIQ_SRC, "age_h": 19.98})
        self.assertEqual(NS["_audit_meta"]({"mint": "M", "liq": "100000", "age_h": 0}),
                         {"mint": "M", "liq_usd": 100000.0, "liq_src": LIQ_SRC, "age_h": 0.0})

    def test_unknown_fields_omitted_never_guessed(self):
        am = NS["_audit_meta"]
        self.assertEqual(am({"mint": "M", "symbol": "S", "decimals": 6}), {"mint": "M"})   # edge5 stub row
        self.assertEqual(am({"mint": "M", "liq": None, "age_h": None}), {"mint": "M"})
        self.assertEqual(am({"mint": "M", "liq": "n/a", "age_h": "x"}), {"mint": "M"})
        self.assertEqual(am(None), {}); self.assertEqual(am({}), {})

    def test_log_meta_keeps_base_and_hot_tag(self):
        got = NS["_log_meta"](ROW, {"edge2": {"pool": "P"}, "horizon": "4h"})
        self.assertEqual(got, {"edge2": {"pool": "P"}, "horizon": "4h", "mint": ROW["mint"], "liq_usd": 231833.73,
                               "liq_src": LIQ_SRC, "age_h": 19.98, "hot_1h": False, "chg_1h": 14.2})
        self.assertEqual(NS["_log_meta"]({"mint": "M", "liq": 1, "age_h": 2, "pc1h": 45})["hot_1h"], True)
        self.assertEqual(NS["_log_meta"](None), {})

    def test_all_three_log_sites_use_log_meta(self):
        calls = {id(n): n for n in ast.walk(TREE) if isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "log_decision"}
        self.assertEqual(len(calls), 3)          # thesis_paused, edge2, _paper_log (edge3-6, edge5 entries/voids)
        metas = sorted(ast.unparse(next(k.value for k in c.keywords if k.arg == "meta")) for c in calls.values())
        self.assertEqual(metas, ["_log_meta(r) or None", "_log_meta(r, {'edge2': info, 'horizon': '4h'})", "meta"])
        pl = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "_paper_log")
        self.assertEqual(ast.unparse(pl.body[1]), "meta = _log_meta(r, meta)")

    def test_paper_log_end_to_end_mocked(self):
        got = []
        fake = types.SimpleNamespace(log_decision=lambda steward, **kw: got.append(kw) or {"ok": True, "id": "x"})
        ns = _fns("_paper_log", "_hot_meta", "_audit_meta", "_log_meta", HOT_1H_PCT=30, LIQ_SRC=LIQ_SRC, PAPER_TAG="paper_only",
                  _no_log=False, _px_sol=lambda r: (1e-6, 0.001, None), _dec_pt="2026-10-18T14:24:00-07:00", _stamp="20261018T1424")
        old = sys.modules.get("steward_rpc"); sys.modules["steward_rpc"] = fake
        try:
            self.assertEqual(ns["_paper_log"](ROW, "meme_grad_pullback", "edge4", "r", {"edge4": {"G_ts": 1}, "horizon": "4h"}), ("x", "ok"))
        finally:
            if old is None: sys.modules.pop("steward_rpc", None)
            else: sys.modules["steward_rpc"] = old
        m = got[0]["meta"]
        self.assertEqual(m["edge4"], {"G_ts": 1}); self.assertEqual(m["horizon"], "4h")
        self.assertEqual((m["mint"], m["liq_usd"], m["liq_src"], m["age_h"], m["hot_1h"], m["chg_1h"]),
                         (ROW["mint"], 231833.73, LIQ_SRC, 19.98, False, 14.2))
        self.assertEqual(got[0]["instrument"], ROW["mint"])

    def test_dry_run_paper_log_reports_audit_fields_without_logging(self):
        ns = _fns("_paper_log", "_hot_meta", "_audit_meta", "_log_meta", HOT_1H_PCT=30, LIQ_SRC=LIQ_SRC, PAPER_TAG="paper_only",
                  _no_log=True, _px_sol=lambda r: (1e-6, 0.001, None), _dec_pt="", _stamp="")
        lid, st = ns["_paper_log"](ROW, "meme_flush_rebound", "edge6", "r", {"edge6": {}})
        self.assertIsNone(lid); self.assertIn("'liq_src': 'jupiter_tokens_v2_total'", st)


class NearClearIds(unittest.TestCase):
    def test_sym_mint(self):
        self.assertEqual(NS["_sym_mint"](ROW), "PIERRE (D3S6J9s1)")
        self.assertEqual(NS["_sym_mint"]({"symbol": "X"}), "X ()")

    def test_console_and_output_lines(self):
        self.assertIn('print("CLEAR", len(clear), [_sym_mint(r) for r in clear])', SRC)
        self.assertIn('print("NEAR", [(_sym_mint(r), r["all_fails"]) for r in near[:8]])', SRC)
        self.assertIn('"clear_ids": [_sym_mint(r) for r in clear], "near_ids": [(_sym_mint(r), r["all_fails"]) for r in near[:12]]', SRC)


class Archive(unittest.TestCase):
    def setUp(self):
        self.ns = _fns("archive_scan_out", os=os, shutil=shutil, datetime=datetime, ARCHIVE_KEEP_DAYS=7,
                       _DAY_RE=re.compile(r"^\d{4}-\d{2}-\d{2}$"))
        self.tmp = tempfile.mkdtemp(); self.root = os.path.join(self.tmp, "arch")
        self.src = os.path.join(self.tmp, "_scan_https_out.json")
        with open(self.src, "w") as fh: fh.write('{"scan_pt": "x"}')

    def tearDown(self): shutil.rmtree(self.tmp)

    def test_default_dir_is_box_only(self):
        self.assertIn('ARCHIVE_DIR = os.environ.get("BANDIT_SCAN_ARCHIVE", "/workspace/bandit/_scan_archive")', SRC)
        self.assertNotIn("_scan_archive", (HERE / "sync_box.sh").read_text())        # never synced / never in the repo

    def test_copy_named_by_pt_date_and_time(self):
        dt = datetime(2026, 10, 18, 14, 24, 16, tzinfo=PT)
        dst, pruned = self.ns["archive_scan_out"](self.src, self.root, dt)
        self.assertEqual(dst, os.path.join(self.root, "2026-10-18", "_scan_https_out_142416.json"))
        self.assertEqual(open(dst).read(), '{"scan_pt": "x"}'); self.assertEqual(pruned, [])
        dst2, _ = self.ns["archive_scan_out"](self.src, self.root, dt.replace(second=17), dry_run=True)
        self.assertTrue(dst2.endswith("2026-10-18/_scan_https_out_142417_dryrun.json"))

    def test_prune_to_seven_days_only_dated_dirs(self):
        dt = datetime(2026, 10, 19, 5, 21, tzinfo=PT)
        for k in range(0, 12):
            os.makedirs(os.path.join(self.root, (dt - timedelta(days=k)).strftime("%Y-%m-%d")))
        os.makedirs(os.path.join(self.root, "keepme")); os.makedirs(os.path.join(self.root, "2026-13-99"))
        open(os.path.join(self.root, "2026-01-01"), "w").close()                        # a file, not a dated dir
        _, pruned = self.ns["archive_scan_out"](self.src, self.root, dt)
        self.assertEqual(pruned, ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"])
        left = sorted(os.listdir(self.root))
        self.assertIn("2026-10-12", left)                                               # exactly 7 days back: kept
        for keep in ("keepme", "2026-13-99", "2026-01-01", "2026-10-19"): self.assertIn(keep, left)

    def test_archive_failure_never_blocks_scan(self):
        self.assertIn('print("ARCHIVE_ERR", type(e).__name__, str(e)[:120])', SRC)


class StatePathsOverridable(unittest.TestCase):
    def test_env_overrides_keep_defaults(self):
        for env, default in (("BANDIT_E2_STATE", "_edge2_dedupe.json"), ("BANDIT_E3_STATE", "_edge3_dedupe.json"),
                             ("BANDIT_E4_STATE", "_edge4_state.json"), ("BANDIT_LAST_SCAN", "_edge34_last_scan.json"),
                             ("BANDIT_E5_STATE", "_edge5_state.json"), ("BANDIT_E6_STATE", "_edge6_dedupe.json"),
                             ("BANDIT_LIQ_SNAP", "_liq_snapshots.json"), ("BANDIT_SCAN_OUT", "_scan_https_out.json")):
            self.assertIn(f'os.environ.get("{env}", "/workspace/bandit/{default}")', SRC)


if __name__ == "__main__":
    unittest.main()
