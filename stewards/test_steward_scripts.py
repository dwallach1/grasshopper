"""Dependency-free checks for the steward entry scripts (run in CI)."""
from __future__ import annotations

import os
import py_compile
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY_SQL = HERE.parent / "supabase" / "schemas" / "50_steward_entry_rpc.sql"
EXIT_SQL = HERE.parent / "supabase" / "schemas" / "51_steward_exit_rpc.sql"
MARKS_SQL = HERE.parent / "supabase" / "schemas" / "58_decision_marks.sql"
SIDES_SQL = HERE.parent / "supabase" / "schemas" / "59_decision_sides_markets.sql"
FIXES_SQL = HERE.parent / "supabase" / "schemas" / "60_steward_fixes_lessons.sql"
QLESSON_SQL = HERE.parent / "supabase" / "schemas" / "65_quantanamo_close_lesson.sql"
CLV_SQL = HERE.parent / "supabase" / "schemas" / "66_clv_provisional_close_marks.sql"
NOTES_SQL = HERE.parent / "supabase" / "schemas" / "72_oddsborne_insert_note.sql"
EDGE_FN = HERE.parent / "supabase" / "functions" / "steward-rpc" / "index.ts"
SCRIPTS = {
    "bandit": HERE / "bandit" / "live_trade_clip.py",
    "oddsborne": HERE / "oddsborne" / "pm_enter.py",
}
# Exit, mark and P&L scripts (ledger over steward-rpc; functions in 51_steward_exit_rpc.sql).
EXIT_SCRIPTS = {
    "bandit": [HERE / "bandit" / f for f in ("clip_common.py", "mark_clip.py", "exit_clip.py", "pnl_snapshot.py", "pass_marks.py", "close_lesson.py")],
    "oddsborne": [HERE / "oddsborne" / f for f in ("pm_exit.py", "pm_watch.py", "pm_fills_sync.py", "pm_pnl_snapshot.py", "pm_session_notes.py", "pm_decision_markets.py", "close_lesson.py")],
    "quantanamo": [HERE / "quantanamo" / "pass_marks.py", HERE / "quantanamo" / "earnings_implied.py"],
}
RPC_CALL = re.compile(r'(?:rpc\(|ledger\(|call\([A-Za-z_.]+, )"([a-z_]+)"')
SECRET_PATTERNS = [
    re.compile(r"""(?i)(api[_-]?key|secret|password|private[_-]?key)\s*=\s*["'][A-Za-z0-9+/=_-]{16,}["']"""),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"),  # JWT
    re.compile(r"sb_(secret|publishable)_[A-Za-z0-9_-]{10,}"),
    re.compile(r"postgres(ql)?://[^\s:]+:[^\s@]+@"),  # DSN with password
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


class StewardScripts(unittest.TestCase):
    def test_compiles(self) -> None:
        for path in HERE.rglob("*.py"):
            py_compile.compile(str(path), doraise=True)

    def test_no_credentials_in_repo(self) -> None:
        for path in list(HERE.rglob("*.py")) + list(HERE.rglob("*.md")) + list(HERE.rglob("*.sh")):
            text = path.read_text()
            for pattern in SECRET_PATTERNS:
                self.assertIsNone(pattern.search(text), f"{path.name}: credential-looking literal ({pattern.pattern[:30]})")

    def test_guidance_gets_invalidation_and_entry_price(self) -> None:
        # 5th arg: invalidation (required); 6th: entry price for the 10%-of-book exposure fit (migration 41).
        # The scripts call public.steward_entry_guidance, a jsonb wrapper that passes all six through.
        sql = ENTRY_SQL.read_text()
        self.assertIn("from public.steward_sizing_guidance(\n    v_steward,\n    p->>'thesis_id',\n    p->>'instrument',\n"
                      "    (p->>'requested')::numeric,\n    (p->>'invalidation_price')::numeric,\n    (p->>'entry_price')::numeric\n", sql)
        bandit = SCRIPTS["bandit"].read_text()
        self.assertIn('row = ledger("steward_entry_guidance", {', bandit)
        self.assertIn('"invalidation_price": str(PLANNED_INVALIDATION),', bandit)
        self.assertIn('"entry_price": None if pretrade_price is None else str(pretrade_price),', bandit)
        self.assertIn('raise RuntimeError("invalidation price must be > 0")', bandit)
        odds = SCRIPTS["oddsborne"].read_text()
        self.assertIn('row = rpc("steward_entry_guidance",', odds)
        self.assertIn('"invalidation_price": Decimal(str(invalidation)),', odds)
        self.assertIn("sizing_guidance(rpc, thesis_id, slug, requested_usd, invalidation, price)", odds)
        self.assertIn("missing_invalidation", odds)

    def test_refuses_when_entry_not_allowed(self) -> None:
        self.assertIn('if not g.get("entry_allowed"):', SCRIPTS["bandit"].read_text())
        self.assertIn("entry_allowed", SCRIPTS["oddsborne"].read_text())

    def test_orders_carry_thesis_and_cap_at_entry(self) -> None:
        for name, path in SCRIPTS.items():
            text = path.read_text()
            self.assertIn('"max_stake_at_entry": ', text, name)
            self.assertIn('"max_stake_reason_at_entry": ', text, name)
            self.assertIn('"thesis_id": ', text, name)
        sql = ENTRY_SQL.read_text()
        for table in ("pm_orders", "meme_orders"):
            block = sql[sql.index(f"insert into public.{table} ("):]
            self.assertIn("max_stake_at_entry, max_stake_reason_at_entry)", block[:600], table)
            self.assertIn("thesis_id", block[:200], table)

    def test_lots_carry_invalidation(self) -> None:
        self.assertIn('"invalidation_price": ', SCRIPTS["bandit"].read_text())
        self.assertIn('"invalidation_price": ', SCRIPTS["oddsborne"].read_text())
        sql = ENTRY_SQL.read_text()
        for table in ("pm_positions", "meme_positions"):
            block = sql[sql.index(f"insert into public.{table} ("):]
            self.assertIn("invalidation_price", block[:400], table)

    def test_ledger_goes_over_https_rpc(self) -> None:
        # The box can't reach the Postgres pooler: no entry script opens a psycopg connection itself.
        exits = [(p.name, p) for ps in EXIT_SCRIPTS.values() for p in ps]
        for name, path in list(SCRIPTS.items()) + [("paper_bank20", HERE / "bandit" / "paper_bank20.py")] + exits:
            text = path.read_text()
            self.assertNotIn("connect()", text, name)
            self.assertNotIn("cur.execute", text, name)
            self.assertTrue("steward_rpc" in text or "clip_common" in text or "make_rpc" in text, name)
        self.assertEqual((HERE / "bandit" / "close_lesson.py").read_text(), (HERE / "oddsborne" / "close_lesson.py").read_text(),
                         "keep close_lesson.py identical in both steward dirs")
        rpc = (HERE / "bandit" / "steward_rpc.py").read_text()
        self.assertEqual(rpc, (HERE / "oddsborne" / "steward_rpc.py").read_text(),
                         "keep steward_rpc.py identical in both steward dirs")
        self.assertEqual(rpc, (HERE / "quantanamo" / "steward_rpc.py").read_text(),
                         "keep steward_rpc.py identical in the quantanamo dir")
        # Every function a script calls is in the edge allowlist for that steward, defined in the schema,
        # SECURITY INVOKER, and granted to that worker only (plus service_role), never to anon/authenticated.
        sql = (ENTRY_SQL.read_text() + EXIT_SQL.read_text() + MARKS_SQL.read_text() + SIDES_SQL.read_text()
               + FIXES_SQL.read_text() + NOTES_SQL.read_text()
               + (HERE.parent / "supabase" / "schemas" / "80_equity_implied_move_risk.sql").read_text()
               + (HERE.parent / "supabase" / "schemas" / "81_equity_implied_move_gaps.sql").read_text())
        edge = EDGE_FN.read_text()
        targets = [("bandit", SCRIPTS["bandit"]), ("bandit", HERE / "bandit" / "paper_bank20.py"), ("oddsborne", SCRIPTS["oddsborne"])]
        targets += [(steward, p) for steward, ps in EXIT_SCRIPTS.items() for p in ps]
        called = set()
        for steward, path in targets:
            allow = edge[edge.index(f"{steward}_worker: new Set(["):]
            allow = allow[:allow.index("])")]
            fns = sorted(set(RPC_CALL.findall(path.read_text())))
            called |= {(steward, fn) for fn in fns}
            for fn in fns:
                self.assertIn(f"'{fn}'", allow, f"{steward}: {fn} not in steward-rpc allowlist")
                block = sql[sql.index(f"create or replace function public.{fn}(p jsonb"):]
                block = block[:block.index("$$;")]
                self.assertIn("security invoker", block, fn)
                grant = re.search(rf"grant execute on function public\.{fn}\(jsonb\) to ([^;]+);", sql)
                self.assertIsNotNone(grant, fn)
                self.assertIn(f"{steward}_worker", grant.group(1), fn)
                self.assertNotRegex(grant.group(1), r"\b(anon|authenticated|public)\b", fn)
                self.assertIn(f"revoke all on function public.{fn}(jsonb) from public, anon, authenticated;", sql)
        for steward, fn in (("bandit", "bandit_exit_record_fill"), ("bandit", "bandit_mark_position"), ("bandit", "steward_close_lesson"),
                            ("oddsborne", "oddsborne_exit_record"), ("oddsborne", "oddsborne_mark_position"),
                            ("oddsborne", "oddsborne_pnl_snapshot"), ("oddsborne", "steward_close_lesson")):
            self.assertIn((steward, fn), called, "the call-site regex no longer sees the exit scripts' calls")
        # The schema file and its migration are the same SQL (the migration is what went to the live DB).
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_steward_exit_rpc.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), EXIT_SQL.read_text())
        self.assertNotIn("security definer", EXIT_SQL.read_text().lower())
        self.assertIn("verify_jwt = false", (HERE.parent / "supabase" / "config.toml").read_text().split("[functions.steward-rpc]")[1][:40])

    def test_log_decision_is_on_the_https_path(self) -> None:
        sql = (HERE.parent / "supabase" / "schemas" / "56_decision_skip_scoring.sql").read_text()
        edge = EDGE_FN.read_text()
        for role in ("quantanamo_worker", "oddsborne_worker", "bandit_worker"):
            allow = edge[edge.index(f"{role}: new Set(["):]
            allow = allow[:allow.index("])")]
            self.assertIn("'steward_log_decision'", allow, role)
        block = sql[sql.index("create or replace function public.steward_log_decision(p jsonb"):]
        block = block[:block.index("$$;")]
        self.assertIn("security invoker", block)
        self.assertIn("refusal:unscoreable:", block)
        self.assertNotIn("security definer", block)
        self.assertIn("grant execute on function public.steward_log_decision(jsonb)", sql)
        self.assertIn("revoke all on function public.steward_log_decision(jsonb) from public, anon, authenticated;", sql)
        self.assertIn("def log_decision(", (HERE / "bandit" / "steward_rpc.py").read_text())

    def test_pass_marks_contract(self) -> None:
        # Passes are priced by the scheduled scripts, from real sources only, through the 58 RPCs.
        sql, edge = MARKS_SQL.read_text(), EDGE_FN.read_text()
        text = (HERE / "bandit" / "pass_marks.py").read_text()
        for needle in ('"steward_pending_decision_marks"', '"steward_record_decision_mark"', "jupiter_price_v3",
                       "geckoterminal_ohlcv_1m", "no_price_reason", "NO_PRICE_GRACE"):
            self.assertIn(needle, text, needle)
        self.assertNotIn("interpolat", text.split('"""', 2)[2].lower(), "pass_marks must not interpolate prices")
        for script in ("mark_clip.py", "pnl_snapshot.py"):
            self.assertIn("pass_marks.sweep_quietly()", (HERE / "bandit" / script).read_text(), script)
        for role, fns in (("bandit_worker", ("steward_pending_decision_marks", "steward_record_decision_mark")),
                          ("quantanamo_worker", ("steward_pending_decision_marks", "steward_record_decision_mark")),
                          ("oddsborne_worker", ("steward_record_decision_mark",))):
            allow = edge[edge.index(f"{role}: new Set(["):]
            allow = allow[:allow.index("])")]
            for fn in fns:
                self.assertIn(f"'{fn}'", allow, f"{role}: {fn}")
        self.assertIn("observed_at >= horizon_at", sql)
        self.assertIn("observed_at < event_start_at", sql)
        self.assertIn("constraint decision_marks_one_per_kind unique (decision_id, mark_kind)", sql)
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_decision_marks.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)
        self.assertIn("def record_decision_mark(", (HERE / "oddsborne" / "steward_rpc.py").read_text())
        qnt = (HERE / "quantanamo" / "pass_marks.py").read_text()
        for needle in ('"steward_pending_decision_marks"', '"steward_record_decision_mark"',
                       "financialdatasets_prices_day", "financialdatasets_prices_snapshot",
                       "no_price_reason", "NO_PRICE_GRACE", "QUANTANAMO_PASS_MARKS", "def sweep_quietly"):
            self.assertIn(needle, qnt, needle)
        self.assertNotIn("interpolat", qnt.split('"""', 2)[2].lower(), "pass_marks must not interpolate prices")
        self.assertIn('call(STEWARD, "steward_pending_decision_marks", {"steward": STEWARD', qnt)
        sync = (HERE / "sync_box.sh").read_text()
        doctor = (HERE / "doctor.sh").read_text()
        for needle in ('"$here/quantanamo/pass_marks.py:$box/quantanamo/pass_marks.py"',
                       '"$here/quantanamo/steward_rpc.py:$box/quantanamo/steward_rpc.py"',
                       '"$here/quantanamo/requirements.txt:$box/quantanamo/requirements.txt"',
                       "stewards=(bandit oddsborne quantanamo)",
                       '"$box/quantanamo/"*) mkdir -p "$(dirname "$dst")"'):
            self.assertIn(needle, sync, needle)
        row = next(ln for ln in doctor.splitlines() if ln.strip().startswith('"quantanamo|'))
        for name in ("pass_marks.py", "steward_rpc.py", "requirements.txt", "requests"):
            self.assertIn(name, row, name)
        allow = edge[edge.index("quantanamo_worker: new Set(["):]
        allow = allow[:allow.index("])")]
        self.assertIn("'steward_pending_decision_marks'", allow)
        self.assertIn("'steward_record_decision_mark'", allow)

    def test_quantanamo_pass_marks_uses_real_closes_only(self) -> None:
        # The daily close is the session close, never the open, a zero-volume bar, or a pre-horizon print.
        import importlib.util
        from datetime import datetime, timedelta, timezone
        from decimal import Decimal
        from unittest import mock
        path = HERE / "quantanamo" / "pass_marks.py"
        spec = importlib.util.spec_from_file_location("qnt_pass_marks", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        sql_days = re.findall(r"\('(\d{4}-\d{2}-\d{2})', '(holiday|early_close)'",
                              (HERE.parent / "supabase" / "schemas" / "29_us_market_calendar.sql").read_text())
        self.assertEqual(dict(sql_days), mod.NYSE_CALENDAR)
        horizon = datetime(2026, 10, 12, 20, 0, tzinfo=timezone.utc)
        later = horizon + timedelta(hours=2)
        mark = mod.select_daily_mark([
            {"ticker": "AAA", "time": "2026-10-09", "open": 1, "close": 9, "volume": 100},
            {"ticker": "AAA", "time": "2026-10-12", "open": 10, "close": 12.5, "volume": 100},
            {"ticker": "OTHER", "time": "2026-10-12", "open": 1, "close": 99, "volume": 100},
        ], horizon, later, "AAA")
        self.assertEqual(mark["price"], Decimal("12.5"))
        self.assertEqual(mark["source"], "financialdatasets_prices_day")
        self.assertEqual(mod.iso_z(mark["observed_at"]), "2026-10-12T20:00:00Z")
        self.assertEqual(mark["meta"]["field"], "close")
        early = mod.session_close_at(__import__("datetime").date(2026, 11, 27))
        self.assertEqual(mod.iso_z(early), "2026-11-27T18:00:00Z")
        self.assertIsNone(mod.session_close_at(__import__("datetime").date(2026, 11, 26)))
        self.assertIsNone(mod.session_close_at(__import__("datetime").date(2026, 10, 10)))
        skipped = mod.select_daily_mark([
            {"ticker": "AAA", "time": "2026-10-12", "open": 10, "close": 12.5, "volume": 0},
            {"ticker": "AAA", "time": "2026-10-13", "open": 12, "close": 13, "volume": 5},
        ], horizon, horizon + timedelta(days=2), "AAA")
        self.assertEqual(skipped["price"], Decimal("13"))
        self.assertEqual(mod.iso_z(skipped["observed_at"]), "2026-10-13T20:00:00Z")
        self.assertNotIn("price", mod.select_daily_mark([
            {"ticker": "AAA", "time": "2026-10-09", "close": 9, "volume": 100},
        ], horizon, later, "AAA"))
        def stamp(iso: str) -> dict:
            at = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return {"time": iso, "time_milliseconds": int(at.timestamp() * 1000)}
        stale = {"price": 4, **stamp("2026-10-12T19:00:00Z")}
        self.assertTrue(mod.snapshot_mark(stale, horizon, later).get("retry"))
        live = {"price": 12.25, **stamp("2026-10-13T15:00:00Z")}
        snap = mod.snapshot_mark(live, horizon, horizon + timedelta(days=1))
        self.assertEqual(snap["source"], "financialdatasets_prices_snapshot")
        self.assertGreaterEqual(snap["observed_at"], horizon)
        row = {"decision_id": "d1", "instrument": "AAA", "horizon_at": "2026-10-12T20:00:00Z"}
        with mock.patch.object(mod, "load_daily", return_value={"none": "no bar yet"}), \
             mock.patch.object(mod, "load_snapshot", side_effect=AssertionError("snapshot during grace")):
            early_pass = mod.price_pass(row, "k", horizon + timedelta(hours=1))
        self.assertEqual(early_pass["action"], "retry")
        with mock.patch.object(mod, "load_daily", side_effect=mod.SourceError("timeout")), \
             mock.patch.object(mod, "load_snapshot", side_effect=AssertionError("snapshot after a transport error")):
            erred = mod.price_pass(row, "k", horizon + timedelta(days=2))
        self.assertEqual(erred["action"], "retry")
        with mock.patch.object(mod, "load_daily", return_value={"none": "no bar"}), \
             mock.patch.object(mod, "load_snapshot", return_value={"none": "no quote"}):
            empty = mod.price_pass(row, "k", horizon + mod.NO_PRICE_GRACE + timedelta(minutes=1))
        self.assertEqual(empty["action"], "no_price")
        args = mod.record_args("d1", empty)
        self.assertNotIn("price", args)
        self.assertIn("no_price_reason", args)
        with mock.patch.object(mod, "load_daily", return_value={"none": "no bar"}), \
             mock.patch.object(mod, "load_snapshot", return_value=snap):
            late = mod.price_pass(row, "k", horizon + mod.NO_PRICE_GRACE + timedelta(minutes=1))
        self.assertEqual(late["action"], "mark")
        self.assertEqual(late["source"], "financialdatasets_prices_snapshot")
        marked = mod.record_args("d1", late)
        self.assertEqual(marked["kind"], "horizon")
        self.assertEqual(marked["steward"], "quantanamo")
        self.assertNotIn("no_price_reason", marked)
        with mock.patch.dict(os.environ, {"QUANTANAMO_PASS_MARKS": "0"}):
            self.assertEqual(mod.sweep_quietly(), {"skipped": "QUANTANAMO_PASS_MARKS=0"})
        with mock.patch.dict(os.environ, {"QUANTANAMO_PASS_MARKS": "1"}), \
             mock.patch.object(mod, "sweep", side_effect=RuntimeError("boom")):
            self.assertIn("boom", mod.sweep_quietly()["error"])

    def test_decision_sides_and_markets_contract(self) -> None:
        # 59: prediction rows carry price_terms and are scored in YES terms; a logged pass gets a market row,
        # and pm_decision_markets.py records only a venue settlement of exactly 1 or 0.
        sql = SIDES_SQL.read_text()
        self.assertIn("public.decision_in_yes_terms(c.side, c.book_price, c.meta)", sql)
        self.assertIn("public.decision_in_yes_terms(c.side, c.my_probability, c.meta)", sql)
        self.assertIn("private.ensure_pm_market(v_instrument, p->>'question', v_close, 'steward_log_decision')", sql)
        self.assertIn("when v_settlement = 1 then 'yes' when v_settlement = 0 then 'no'", sql)
        self.assertIn("v_venue_status = 'MARKET_STATUS_RESOLVED'", sql)
        text = (HERE / "oddsborne" / "pm_decision_markets.py").read_text()
        for needle in ('"oddsborne_decision_markets"', '"oddsborne_sync_decision_market"', "c.markets.settlement",
                       "c.markets.retrieve_by_slug", '"found": False'):
            self.assertIn(needle, text, needle)
        self.assertNotIn("place_order", text)
        self.assertIn("pm_decision_markets.sweep_quietly()", (HERE / "oddsborne" / "pm_pnl_snapshot.py").read_text())
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_decision_sides_markets.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)

    def test_lesson_moves_from_the_ledger(self) -> None:
        sql = FIXES_SQL.read_text()
        self.assertIn("v_prior := private.thesis_ledger_confidence(v_thesis);", sql)
        self.assertIn("v_pnl < 0 and v_new > v_prior", sql)
        self.assertNotIn('"prior_confidence"', (HERE / "bandit" / "close_lesson.py").read_text())
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_steward_fixes_lessons.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)

    def test_quantanamo_close_lesson_path(self) -> None:
        # 65: QUANTANAMO's equity lots go through the same function, delta and loss clamp as BANDIT/ODDSBORNE,
        # callable as quantanamo_worker in SQL and over steward-rpc.
        sql = QLESSON_SQL.read_text()
        fn = sql[sql.index("create or replace function public.steward_close_lesson(p jsonb)"):]
        fn = fn[:fn.index("$$;")]
        prev = FIXES_SQL.read_text()
        prev = prev[prev.index("create or replace function public.steward_close_lesson(p jsonb)"):]
        prev = prev[:prev.index("$$;")]
        for line in ("v_prior := private.thesis_ledger_confidence(v_thesis);", "v_new := case when v_prior is null then null else v_prior + v_delta end;",
                     "v_pnl < 0 and v_new > v_prior", "v_pnl := private.lot_realized_pnl(v_table, v_lot);", "security invoker"):
            self.assertIn(line, fn)
            self.assertIn(line, prev)
        self.assertIn("elsif v_steward = 'quantanamo' then\n    -- 65", fn)
        self.assertIn("v_table := 'position_episodes';", fn)
        self.assertIn("from public.position_episodes where id = v_lot;", fn)
        # trade_outcomes keys QUANTANAMO's realized P&L by the same table name the lesson looks up.
        self.assertIn("'position_episodes', p_episode_id::text,", (HERE.parent / "supabase" / "schemas" / "10_trade_outcomes.sql").read_text())
        # dry_run returns before the only write; nothing else in the function writes.
        self.assertLess(fn.index("if v_dry then"), fn.index("insert into public.belief_updates"))
        self.assertEqual(fn.count("insert into"), 1)
        self.assertNotRegex(fn.lower(), r"\b(update|delete)\s+(from\s+)?public\.")
        # Every steward's branch is still there, unchanged.
        for branch in ("if v_steward = 'bandit' then", "v_table := 'meme_positions';", "elsif v_steward = 'oddsborne' then", "v_table := 'pm_positions';"):
            self.assertIn(branch, fn)
        grant = re.search(r"grant execute on function public\.steward_close_lesson\(jsonb\) to ([^;]+);", sql)
        self.assertIsNotNone(grant)
        for role in ("quantanamo_worker", "oddsborne_worker", "bandit_worker", "service_role"):
            self.assertIn(role, grant.group(1))
        self.assertNotRegex(grant.group(1), r"\b(anon|authenticated|public)\b")
        self.assertIn("revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;", sql)
        edge = EDGE_FN.read_text()
        for role in ("quantanamo_worker", "oddsborne_worker", "bandit_worker"):
            allow = edge[edge.index(f"{role}: new Set(["):]
            self.assertIn("'steward_close_lesson'", allow[:allow.index("])")], role)
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_quantanamo_close_lesson.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)
        self.assertIn('"quantanamo"', (HERE / "bandit" / "close_lesson.py").read_text())

    def test_clv_leaves_out_provisional_close_marks(self) -> None:
        # 66: v_decision_clv and its summary read only closing marks; provisional ones are counted, not dropped.
        sql = CLV_SQL.read_text()
        self.assertIn("when lower(coalesce(p_meta->>'provisional', '')) = 'true' then 'flagged'", sql)
        self.assertIn("p_event_start_at - p_observed_at > interval '60 minutes' then 'early'", sql)
        self.assertIn("join public.decision_marks m on m.decision_id = c.id and m.mark_kind = 'close'", sql)
        self.assertNotIn("'horizon'", sql.split("create or replace function", 1)[1])
        clv = sql[sql.index("create or replace view public.v_decision_clv\n"):]
        self.assertIn("from public.v_decision_clv_all a\nwhere not a.provisional;", clv[:clv.index(";") + 1])
        summary = sql[sql.index("create or replace view public.v_decision_clv_summary"):]
        summary = summary[:summary.index(";")]
        self.assertIn("count(*) filter (where a.provisional)::int as provisional_excluded", summary)
        for agg in ("as n,", "as mean_clv,", "as beat_entry,", "as worse_than_entry,", "as mean_fair_minus_close,",
                    "as fair_closer_than_entry,", "as last_close_observed_at,"):
            line = next(ln for ln in summary.splitlines() if ln.rstrip().endswith(agg))
            self.assertIn("not a.provisional", line, agg)
        # The close-mark upsert replaces meta, so a pre-game mark clears provisional = true (58, unchanged here).
        marks = MARKS_SQL.read_text()
        upsert = marks[marks.index("on conflict (decision_id, mark_kind) do update set"):]
        upsert = upsert[:upsert.index("returning id into v_id;")]
        self.assertIn("meta = excluded.meta,", upsert)
        self.assertNotIn("||", upsert)
        self.assertNotIn("steward_record_decision_mark", sql.replace("-- (steward_record_decision_mark:", ""))
        mig = sorted((HERE.parent / "supabase" / "migrations").glob("*_clv_provisional_close_marks.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)

    def test_shadow_exit_contract(self) -> None:
        # public.v_shadow_exits reads meta.paper_<name> objects with these keys (supabase/schemas/32, 33).
        text = (HERE / "bandit" / "paper_bank20.py").read_text()
        self.assertIn("'paper_bank20'", text)
        for key in ("rule", "triggered", "trigger_minute", "paper_exit_pct", "real_exit_pct", "delta_pct_pts", "source"):
            self.assertIn(f'"{key}"', text, key)

    def test_no_hardcoded_box_paths(self) -> None:
        exits = [(p.name, p) for ps in EXIT_SCRIPTS.values() for p in ps]
        for name, path in list(SCRIPTS.items()) + [("paper_bank20", HERE / "bandit" / "paper_bank20.py")] + exits:
            text = path.read_text()
            self.assertNotRegex(text, r"""["']/workspace/""", name)


    def test_requirements_are_pinned(self) -> None:
        direct = {"bandit": ("requests", "base58", "solders", "psycopg", "psycopg-binary"),
                  "oddsborne": ("polymarket-us", "psycopg", "psycopg-binary"),
                  "quantanamo": ("requests",)}
        for steward, needs in direct.items():
            lines = [ln.strip() for ln in (HERE / steward / "requirements.txt").read_text().splitlines()]
            pins = [ln for ln in lines if ln and not ln.startswith("#")]
            for ln in pins:
                self.assertRegex(ln, r"^[A-Za-z0-9_.\-]+(\[[a-z,]+\])?==[0-9][^\s]*$", f"{steward}: unpinned {ln!r}")
            names = {re.split(r"[\[=]", ln)[0].lower().replace("_", "-") for ln in pins}
            for need in needs:
                self.assertIn(need, names, f"{steward} requirements miss {need}")
        odds = (HERE / "oddsborne" / "requirements.txt").read_text()
        self.assertIn("polymarket-us==1.0.2", odds)
        self.assertIn("psycopg==3.3.6", odds)
        self.assertIn("psycopg-binary==3.3.6", odds)

    def test_scripts_fail_fast_before_third_party_imports(self) -> None:
        clip = SCRIPTS["bandit"].read_text()
        self.assertLess(clip.index('_require_runtime("bandit", ("base58", "requests", "solders.keypair", "solders.transaction"))'),
                        clip.index("import base58  # noqa: E402"))
        self.assertLess(clip.index("_require_runtime("), clip.index("from steward_rpc import call as _rpc_call"))
        odds = SCRIPTS["oddsborne"].read_text()
        self.assertIn('def main(argv=None) -> int:\n    _require_runtime(STEWARD, ("polymarket_us",))', odds)
        for text in (clip, odds):
            self.assertIn("raise SystemExit(3)", text)
            self.assertIn("'stewards', 'sync_box.sh'", text)
        # paper_bank20 is stdlib-only now (HTTPS ledger), so it has no third-party guard.
        self.assertNotIn("psycopg", (HERE / "bandit" / "paper_bank20.py").read_text())

    def test_guard_exits_3_with_the_fix_when_imports_are_missing(self) -> None:
        # The CI interpreter has none of the steward packages: every script must stop before touching anything.
        env = {**os.environ, "PYTHONNOUSERSITE": "1", "GRASSHOPPER_REPO": "/repo"}
        guarded = [HERE / "bandit" / f for f in ("mark_clip.py", "exit_clip.py", "pnl_snapshot.py")]
        guarded += [HERE / "oddsborne" / f for f in ("pm_exit.py", "pm_watch.py", "pm_fills_sync.py", "pm_pnl_snapshot.py")]
        for script in [SCRIPTS["bandit"], SCRIPTS["oddsborne"]] + guarded:
            probe = subprocess.run(["python3", "-S", "-c",
                                    "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('base58') or importlib.util.find_spec('polymarket_us') else 1)"])
            if probe.returncode == 0:
                self.skipTest("psycopg importable here; guard path not reachable")
            run = subprocess.run(["python3", "-S", str(script), "--help"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(run.returncode, 3, f"{script.name}: {run.stderr}")
            self.assertIn("Python env not ready", run.stderr)
            self.assertIn("bash /repo/stewards/sync_box.sh", run.stderr)

    def test_doctor_reports_a_missing_venv_and_exits_nonzero(self) -> None:
        for sh in ("doctor.sh", "sync_box.sh"):
            self.assertEqual(subprocess.run(["bash", "-n", str(HERE / sh)]).returncode, 0, sh)
        with tempfile.TemporaryDirectory() as root:
            os.mkdir(os.path.join(root, "oddsborne"))
            run = subprocess.run(["bash", str(HERE / "doctor.sh")], capture_output=True, text=True,
                                 env={**os.environ, "STEWARD_BOX_ROOT": root}, timeout=60)
            self.assertEqual(run.returncode, 1, run.stdout)
            self.assertIn("oddsborne: BROKEN: missing pm_enter.py", run.stdout)
            self.assertIn("no working venv", run.stdout)
            self.assertIn("bandit: skip", run.stdout)
            self.assertIn("sync_box.sh", run.stdout)

    def test_doctor_checks_what_the_scripts_import(self) -> None:
        doctor = (HERE / "doctor.sh").read_text()
        self.assertIn('"bandit|base58 requests solders.keypair solders.transaction psycopg db_connect load_secrets steward_rpc|', doctor)
        self.assertIn('"oddsborne|polymarket_us psycopg db_connect load_secrets steward_rpc|', doctor)
        sync = (HERE / "sync_box.sh").read_text()
        for needle in ('"$here/bandit/steward_rpc.py:$box/bandit/steward_rpc.py"', '"$here/oddsborne/steward_rpc.py:$box/oddsborne/steward_rpc.py"',
                       '--find-links "$wheelhouse"', 'fill_wheelhouse "$py" "$req" "$steward"', 'wheelhouse="$box/.steward-wheelhouse"', 'exec bash "$here/doctor.sh"',
                       '"$here/bandit/requirements.txt:$box/bandit/requirements.txt"', '"$here/oddsborne/requirements.txt:$box/oddsborne/requirements.txt"'):
            self.assertIn(needle, sync)
        for steward, paths in EXIT_SCRIPTS.items():
            row = next(ln for ln in doctor.splitlines() if ln.strip().startswith(f'"{steward}|'))
            for p in paths:
                self.assertIn(f'"$here/{steward}/{p.name}:$box/{steward}/{p.name}"', sync)
                self.assertIn(p.name, row.split("|")[2], f"doctor.sh doesn't check {steward}/{p.name}")


if __name__ == "__main__":
    unittest.main()
