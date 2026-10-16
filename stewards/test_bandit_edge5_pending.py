"""edge5 meme_liq_accum pending entries: retry on a failed log, void only when stale, voids are logged and kept.

Dependency-free: pulls edge5_process_pending (and its constants) out of bandit/scan_https_once.py with ast, so the
scan itself (network, secrets) never runs.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

SCAN = Path(__file__).resolve().parent / "bandit" / "scan_https_once.py"


def _load():
    tree = ast.parse(SCAN.read_text())
    keep = []
    for n in tree.body:
        if isinstance(n, ast.FunctionDef) and n.name == "edge5_process_pending":
            keep.append(n)
        elif isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith("E5_") for t in n.targets) \
                and isinstance(n.value, (ast.Constant, ast.BinOp)):
            keep.append(n)
    ns: dict = {}
    exec(compile(ast.Module(keep, []), str(SCAN), "exec"), ns)
    return ns


NS = _load()
process = NS["edge5_process_pending"]
NOW = 1_800_000_000


def pend(age_s, **kw):
    return dict(signal_ts=NOW - age_s, symbol="TEST", info={"liq_chg_pct": 60}, **kw)


class Calls:
    def __init__(self, *statuses):
        self.statuses = list(statuses); self.calls = []

    def __call__(self, mint, p):
        self.calls.append((mint, dict(p)))
        st = self.statuses.pop(0) if self.statuses else "ok"
        if isinstance(st, Exception):
            raise st
        return (101 if st == "ok" else None), st


class Edge5Pending(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(NS["E5_VOID_TAG"], "paper_void_stale")
        self.assertEqual(NS["E5_STALE_S"], 7200)
        text = SCAN.read_text()
        self.assertIn('"edge5void"', text)
        self.assertIn("blocked_by=E5_VOID_TAG", text)

    def test_failed_entry_stays_pending_and_counts_retries(self):
        st = {"pending": {"M1": pend(3600)}, "dedupe": {}}
        entry, void = Calls("quote_err Timeout"), Calls()
        out = process(st, NOW, entry, void)
        self.assertIn("M1", st["pending"])
        self.assertEqual(st["pending"]["M1"]["retries"], 1)
        self.assertEqual(st["pending"]["M1"]["last_error"], "quote_err Timeout")
        self.assertEqual(st["dedupe"], {})
        self.assertEqual(void.calls, [])
        self.assertEqual(out, [("M1", None, "entry: quote_err Timeout")])
        # an exception from log_decision is a failure too, not a drop
        process(st, NOW + 60, Calls(RuntimeError("rpc 503")), void)
        self.assertEqual(st["pending"]["M1"]["retries"], 2)
        self.assertIn("RuntimeError", st["pending"]["M1"]["last_error"])
        # next scan succeeds -> entered, deduped, history carries the retry count
        out = process(st, NOW + 120, Calls("ok"), void)
        self.assertEqual(st["pending"], {})
        self.assertEqual(st["dedupe"]["M1"], NOW - 3600)
        self.assertEqual(st["history"][-1]["outcome"], "entered")
        self.assertEqual(st["history"][-1]["retries"], 2)
        self.assertEqual(out, [("M1", 101, "entry: ok")])

    def test_stale_is_voided_and_logged_not_deleted_silently(self):
        st = {"pending": {"M2": pend(2 * 3600 + 1, retries=3, last_error="no_price")}, "dedupe": {}}
        entry, void = Calls(), Calls("ok")
        out = process(st, NOW, entry, void)
        self.assertEqual(entry.calls, [])                       # stale -> no entry attempt
        self.assertEqual(len(void.calls), 1)                    # the void goes to the ledger
        self.assertEqual(st["pending"], {})
        self.assertNotIn("M2", st["dedupe"])
        h = st["history"][-1]
        self.assertEqual((h["outcome"], h["retries"], h["ledger_id"], h["last_error"]), ("void_stale", 3, 101, "no_price"))
        self.assertEqual(out, [("M2", 101, "void_stale: ok")])

    def test_failed_void_log_is_retried(self):
        st = {"pending": {"M3": pend(3 * 3600)}, "dedupe": {}}
        process(st, NOW, Calls(), Calls("refusal:unscoreable"))
        self.assertIn("M3", st["pending"])
        self.assertEqual(st["pending"]["M3"]["void_retries"], 1)
        self.assertEqual(st.get("history"), [])
        process(st, NOW + 3600, Calls(), Calls("ok"))
        self.assertEqual(st["pending"], {})
        self.assertEqual(st["history"][-1]["void_retries"], 1)

    def test_fresh_at_exactly_2h_is_not_void(self):
        st = {"pending": {"M4": pend(2 * 3600)}, "dedupe": {}}
        entry, void = Calls("ok"), Calls()
        process(st, NOW, entry, void)
        self.assertEqual((len(entry.calls), len(void.calls)), (1, 0))

    def test_dry_run_changes_nothing(self):
        st = {"pending": {"M5": pend(60), "M6": pend(3 * 3600)}, "dedupe": {}}
        before = repr(st)
        out = process(st, NOW, Calls("dry_run would_log"), Calls("dry_run would_log"), no_log=True)
        self.assertEqual(len(out), 2)
        st.pop("history")
        self.assertEqual(repr(st), before)


if __name__ == "__main__":
    unittest.main()
