"""theses.paper_only (20261017131644): a paper-only thesis never sizes or logs a real-money entry; skips are unchanged.
Text contract over the SQL (no database)."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations" / "20261017131644_theses_paper_only.sql"
SCHEMA = ROOT / "supabase" / "schemas" / "76_theses_paper_only.sql"
VOID = ROOT / "supabase" / "migrations" / "20261016210000_steward_log_decision_void_unscoreable.sql"
SIZING = ROOT / "supabase" / "schemas" / "48_quantanamo_gate_small_sample.sql"
LOCK_MIG = ROOT / "supabase" / "migrations" / "20261017131924_theses_paper_only_lockdown.sql"
LOCK = ROOT / "supabase" / "schemas" / "77_theses_paper_only_lockdown.sql"
MAXSTAKE = ROOT / "supabase" / "schemas" / "28_max_stake_operator_gate.sql"


def _fn(sql: str, name: str) -> str:
    a = sql.index(f"create or replace function {name}(")
    return sql[a:sql.index("$$;", a) + 3]


class PaperOnly(unittest.TestCase):
    sql = MIG.read_text()
    sg = _fn(sql, "public.steward_sizing_guidance")
    ld = _fn(sql, "public.steward_log_decision")

    def test_schema_mirrors_migration(self):
        self.assertEqual(SCHEMA.read_text(), self.sql)

    def test_column_default_false(self):
        self.assertIn("alter table public.theses add column if not exists paper_only boolean not null default false;", self.sql)

    def test_sizing_blocks_paper_only(self):
        self.assertIn("v_paper := coalesce(th.paper_only, false);", self.sg)
        self.assertIn("v_blocked := v_rejected or v_killed or v_unknown or v_paper;", self.sg)
        self.assertEqual(self.sg.count("      when v_paper then 'paper_only'\n"), 2)   # reason: quantanamo and non-gate branches
        self.assertIn("case when v_unknown or v_rejected or v_killed or v_paper then 0::numeric else ms.max_stake end,", self.sg)
        self.assertIn("case when v_paper then 'paper_only' when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,", self.sg)

    def test_sizing_is_48_plus_paper_lines_only(self):
        old = _fn(SIZING.read_text(), "public.steward_sizing_guidance").splitlines()
        new = self.sg.splitlines()
        removed = [l for l in old if l not in new]
        self.assertEqual(removed, ["  v_blocked := v_rejected or v_killed or v_unknown;",
                                   "    case when v_unknown or v_rejected or v_killed then 0::numeric else ms.max_stake end,",
                                   "    case when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,"])
        self.assertIn("security definer\nset search_path = ''", self.sg)

    def test_log_decision_refuses_enter_only(self):
        self.assertIn("if v_decision <> 'skip' and v_thesis is not null then", self.ld)
        self.assertRegex(self.ld, r"raise exception 'refusal:paper_only: [^']*', v_thesis\s+using errcode = 'P0001';")
        self.assertIn("security invoker\nset search_path = public, private, pg_temp", self.ld)

    def test_log_decision_is_void_version_plus_paper_lines_only(self):
        old = _fn(VOID.read_text(), "public.steward_log_decision").splitlines()
        new = self.ld.splitlines()
        removed = [l for l in old if l not in new]
        self.assertEqual(removed, ["    nullif(btrim(coalesce(p->>'thesis_id', '')), ''), v_side,"])
        self.assertIn("    v_thesis, v_side,", new)

    def test_meme_orders_trigger_blocks_buys_only(self):
        fn = _fn(self.sql, "private.refuse_paper_only_meme_buy")
        self.assertIn("if new.side = 'buy' and new.thesis_id is not null", fn)
        self.assertIn("before insert on public.meme_orders", self.sql)
        self.assertIn("revoke all on function private.refuse_paper_only_meme_buy() from public, anon, authenticated;", self.sql)

    def test_grants_restated(self):
        for sig in ("public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric)", "public.steward_log_decision(jsonb)"):
            self.assertRegex(self.sql, re.escape(f"grant execute on function {sig}") +
                             r"\s+to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;")


class Lockdown(unittest.TestCase):
    sql = LOCK_MIG.read_text()
    ms = _fn(sql, "public.thesis_max_stakes")
    guard = _fn(sql, "private.theses_paper_only_guard")

    def test_schema_mirrors_migration(self):
        self.assertEqual(LOCK.read_text(), self.sql)

    def test_court_markers(self):
        for f in (MIG, SCHEMA, LOCK_MIG, LOCK):
            self.assertIn("-- court-ruling: docs/rules/paper-only-theses.md\n", f.read_text())
        self.assertTrue((ROOT / "docs" / "rules" / "paper-only-theses.md").exists())
        self.assertIn("  ('paper-only-theses', ", self.sql)

    def test_max_stake_zero_for_paper_only_rest_as_28(self):
        self.assertIn("case when t.paper_only then 0::numeric else m.max_stake end,", self.ms)
        self.assertIn("case when t.paper_only then 'paper_only' else m.reason end", self.ms)
        old = _fn(MAXSTAKE.read_text(), "public.thesis_max_stakes").splitlines()
        removed = [l for l in old if l not in self.ms.splitlines()]
        self.assertEqual(removed, ["         m.max_stake, case s.steward when 'bandit' then 'SOL' else 'USD' end,",
                                   "         m.trades, m.lcb, m.reason"])
        self.assertIn("security definer\nset search_path = ''", self.ms)

    def test_guard_allowlist_and_invoker(self):
        self.assertIn("security invoker\nset search_path = ''", self.guard)
        self.assertIn("if current_user::text not in ('postgres', 'service_role', 'supabase_admin') then", self.guard)
        self.assertIn("(tg_op = 'INSERT' and new.paper_only)", self.guard)
        self.assertIn("(tg_op = 'UPDATE' and new.paper_only is distinct from old.paper_only)", self.guard)
        self.assertIn("before insert or update of paper_only on public.theses", self.sql)
        for role in ("quantanamo_worker", "oddsborne_worker", "bandit_worker", "authenticated"):
            self.assertNotIn(f"'{role}'", self.guard)   # not allowlisted
        self.assertNotRegex(self.sql, r"revoke (update|all) on (table )?public\.theses")   # quantanamo_worker keeps its other updates


if __name__ == "__main__":
    unittest.main()
