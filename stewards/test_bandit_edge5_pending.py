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


class FakeRpc:
    """Stands in for steward_rpc: records log_decision calls; refuse=True mimics the RPC before migration 20261016200000."""
    def __init__(self, refuse=False):
        self.calls = []; self.refuse = refuse

    def log_decision(self, steward, **kw):
        self.calls.append(kw)
        if kw.get("price") is None and (self.refuse or not kw.get("no_price_reason")):
            return {"ok": False, "error": "refusal:unscoreable: price must be the price at decision time"}
        return {"ok": True, "id": 202}


def paper_log_fn(rpc, quote=(None, None, "quote_err Timeout"), no_log=False):
    """_paper_log from the scan, with the quote, the dry-run flag and steward_rpc replaced by fakes (no network)."""
    import sys, types
    fn = next(n for n in ast.parse(SCAN.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == "_paper_log")
    ns = {"PAPER_TAG": "paper_only", "_px_sol": lambda r: quote, "_no_log": no_log, "_dec_pt": "2026-10-16T12:00:00-07:00",
          "_stamp": "20261016T1200"}
    exec(compile(ast.Module([fn], []), str(SCAN), "exec"), ns)
    def call(*a, **kw):
        old = sys.modules.get("steward_rpc"); sys.modules["steward_rpc"] = types.SimpleNamespace(log_decision=rpc.log_decision)
        try:
            return ns["_paper_log"](*a, **kw)
        finally:
            if old is None: sys.modules.pop("steward_rpc", None)
            else: sys.modules["steward_rpc"] = old
    return call


ROW = {"mint": "MintNoPrice1111", "symbol": "TEST"}


def void_via_paper_log(rpc, signal_px=None, **kw):
    """The scan's _e5_void call shape: blocked_by paper_void_stale, signal-time price as fallback, priceless allowed."""
    pl = paper_log_fn(rpc, **kw)
    return lambda mint, p: pl(ROW, "meme_liq_accum", "edge5void", "TEST: edge5 pending entry VOID", {"void": {"reason": "stale_2h"}},
                              blocked_by=NS["E5_VOID_TAG"], px_fallback=signal_px, allow_priceless=True)
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


    def test_scan_void_call_allows_priceless(self):
        self.assertIn('px_fallback=pend.get("signal_px_sol"), allow_priceless=True)', SCAN.read_text())

    def test_stale_no_price_logs_priceless_void_and_clears(self):
        st = {"pending": {"M7": pend(3 * 3600, retries=4, last_error="quote_err Timeout")}, "dedupe": {}}
        rpc = FakeRpc()
        out = process(st, NOW, Calls(), void_via_paper_log(rpc))      # no live quote, no signal_px_sol stored
        self.assertEqual(len(rpc.calls), 1)
        kw = rpc.calls[0]
        self.assertIsNone(kw["price"])                                # never an invented price
        self.assertIn("no live quote", kw["no_price_reason"])   # RPC stores it as unscoreable_reason "no_price: ..."
        self.assertTrue(kw["reason"].startswith("[no_price] "))
        self.assertEqual((kw["blocked_by"], kw["decision"], kw["thesis_id"]), ("paper_void_stale", "skip", "meme_liq_accum"))
        self.assertTrue(kw["source_id"].endswith("_edge5void"))
        self.assertEqual(st["pending"], {})                           # cleared: the coin is no longer blocked
        self.assertEqual((st["history"][-1]["outcome"], st["history"][-1]["ledger_id"]), ("void_stale", 202))
        self.assertEqual(out, [("M7", 202, "void_stale: ok")])

    def test_priceless_void_refused_by_old_rpc_stays_pending(self):
        st = {"pending": {"M8": pend(3 * 3600)}, "dedupe": {}}
        process(st, NOW, Calls(), void_via_paper_log(FakeRpc(refuse=True)))
        self.assertIn("M8", st["pending"])
        self.assertEqual(st["pending"]["M8"]["void_retries"], 1)

    def test_void_uses_signal_price_when_no_live_quote(self):
        rpc = FakeRpc()
        process({"pending": {"M9": pend(3 * 3600)}, "dedupe": {}}, NOW, Calls(), void_via_paper_log(rpc, signal_px=1.5e-7))
        self.assertEqual(rpc.calls[0]["price"], 1.5e-7)
        self.assertIsNone(rpc.calls[0].get("no_price_reason"))
        self.assertFalse(rpc.calls[0]["reason"].startswith("[no_price]"))

    def test_entries_never_log_priceless(self):
        rpc = FakeRpc()
        lid, st_ = paper_log_fn(rpc)(ROW, "meme_liq_accum", "edge5", "entry", {})
        self.assertEqual((lid, st_, rpc.calls), (None, "quote_err Timeout", []))

    def test_priceless_void_dry_run_logs_nothing(self):
        rpc = FakeRpc()
        lid, st_ = void_via_paper_log(rpc, no_log=True)("M10", {})
        self.assertEqual((lid, rpc.calls), (None, []))
        self.assertIn("px=None", st_)
        self.assertIn("no_price", st_)


if __name__ == "__main__":
    unittest.main()
