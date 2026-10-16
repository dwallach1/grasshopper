"""A void is not a decision: rows logged with blocked_by='paper_void_stale' are tagged unscoreable server-side, so the
ledger's horizon marks never pick them up or score them as skips. Text contract over the SQL (no database)."""
from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations" / "20261016210000_steward_log_decision_void_unscoreable.sql"
SCHEMA = ROOT / "supabase" / "schemas" / "74_steward_log_decision_void_unscoreable.sql"
SCAN = ROOT / "stewards" / "bandit" / "scan_https_once.py"


def _fn(sql: str, name: str) -> str:
    a = sql.index(f"create or replace function {name}(")
    return sql[a:sql.index("$$;", a)]


def is_scoreable(book_price, meta) -> bool:
    """Python mirror of public.decision_is_scoreable for a meme row (schemas/56)."""
    return (book_price is not None and book_price > 0 and str(meta.get("unscoreable", "")) != "true"
            and str(meta.get("superseded", "")) != "true")


def stored_meta(caller_meta: dict, blocked_by, priceless=False, no_price="x") -> dict:
    """Python mirror of the meta steward_log_decision stores after 20261016210000 (meme skip)."""
    void = (blocked_by or "").strip().lower() == "paper_void_stale"
    m = {k: v for k, v in caller_meta.items() if k not in ("unscoreable", "superseded", "legacy_probability_absent")}
    m.update(origin="steward_log_decision", horizon="4 hours", blocked_by=blocked_by,
             resolve_status="void" if void else "no_price" if priceless else "awaiting_mark")
    if void:
        m.update(unscoreable="true", unscoreable_reason="void: paper_void_stale, not a decision"
                 + (f"; no_price: {no_price}" if priceless else ""))
    elif priceless:
        m.update(unscoreable="true", unscoreable_reason=f"no_price: {no_price}")
    return m


class VoidNotADecision(unittest.TestCase):
    sql = MIG.read_text()
    fn = _fn(sql, "public.steward_log_decision")

    def test_schema_mirrors_migration(self):
        self.assertEqual(SCHEMA.read_text(), self.sql)

    def test_latest_steward_log_decision_is_this_one(self):
        defs = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("*.sql")
                      if "create or replace function public.steward_log_decision(" in p.read_text())
        self.assertEqual(defs[-1], MIG.name)

    def test_void_tag_is_server_side_from_blocked_by(self):
        self.assertIn("v_void boolean := lower(btrim(coalesce(p->>'blocked_by', ''))) = 'paper_void_stale';", self.fn)
        self.assertIn("v_status := case when v_void then 'void' when v_priceless then 'no_price' else 'awaiting_mark' end;", self.fn)
        self.assertRegex(self.fn, r"when v_void then jsonb_build_object\(\s*'unscoreable', 'true', 'unscoreable_reason', 'void: paper_void_stale, not a decision'")
        # the caller can't set unscoreable itself (still stripped), so the tag only ever comes from blocked_by / no price
        self.assertIn("(v_extra - 'unscoreable' - 'superseded' - 'legacy_probability_absent')", self.fn)

    def test_scan_void_tag_matches_sql(self):
        tree = ast.parse(SCAN.read_text())
        tag = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "E5_VOID_TAG" for t in n.targets))
        self.assertEqual(tag, "paper_void_stale")
        self.assertIn(f"'{tag}'", self.fn)

    def test_priced_and_priceless_checks_unchanged(self):
        self.assertIn("if v_price is null and v_decision = 'skip' and v_venue = 'meme' and v_no_price is not null then", self.fn)
        self.assertIn("elsif v_price is null or v_price <= 0 or (v_venue = 'prediction' and v_price > 1) then", self.fn)

    def test_marks_select_only_scoreable_rows(self):
        marks = (ROOT / "supabase" / "schemas" / "58_decision_marks.sql").read_text()
        pending = _fn(marks, "public.steward_pending_decision_marks")
        self.assertIn("public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)", pending)
        resolve = _fn(marks, "private.resolve_marked_decisions")
        self.assertGreaterEqual(resolve.count("public.decision_is_scoreable("), 2)
        scoreable = _fn((ROOT / "supabase" / "schemas" / "56_decision_skip_scoring.sql").read_text(), "public.decision_is_scoreable")
        self.assertIn("coalesce(p_meta->>'unscoreable', '') is distinct from 'true'", scoreable)
        for steward in ("bandit", "quantanamo"):      # the sweeps take their rows only from steward_pending_decision_marks
            self.assertIn('"steward_pending_decision_marks"', (ROOT / "stewards" / steward / "pass_marks.py").read_text())

    def test_priced_void_is_never_marked_but_paper_skip_is(self):
        void = stored_meta({"void": {"reason": "stale_2h"}}, "paper_void_stale")
        self.assertFalse(is_scoreable(1.5e-7, void))
        self.assertEqual((void["resolve_status"], void["void"]), ("void", {"reason": "stale_2h"}))   # caller detail kept
        self.assertTrue(is_scoreable(1.5e-7, stored_meta({}, "paper_only")))
        self.assertFalse(is_scoreable(1.5e-7, stored_meta({"unscoreable": "false"}, "paper_void_stale")))
        pl = stored_meta({}, "paper_void_stale", priceless=True, no_price="void, no live quote")
        self.assertFalse(is_scoreable(None, pl))
        self.assertTrue(pl["unscoreable_reason"].startswith("void: paper_void_stale, not a decision; no_price: "))

    def test_backfill_is_scoped_and_idempotent(self):
        up = self.sql[self.sql.index("update public.decision_candidates"):]
        self.assertIn("where meta->>'blocked_by' = 'paper_void_stale'", up)
        self.assertIn("and coalesce(meta->>'unscoreable', '') is distinct from 'true';", up)
        self.assertNotRegex(up, r"counterfactual_pnl|book_price|delete")
        self.assertEqual(len(re.findall(r"^update ", self.sql, re.M)), 1)


if __name__ == "__main__":
    unittest.main()
