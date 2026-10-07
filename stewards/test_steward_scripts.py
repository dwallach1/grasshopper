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
EDGE_FN = HERE.parent / "supabase" / "functions" / "steward-rpc" / "index.ts"
SCRIPTS = {
    "bandit": HERE / "bandit" / "live_trade_clip.py",
    "oddsborne": HERE / "oddsborne" / "pm_enter.py",
}
# Exit, mark and P&L scripts (ledger over steward-rpc; functions in 51_steward_exit_rpc.sql).
EXIT_SCRIPTS = {
    "bandit": [HERE / "bandit" / f for f in ("clip_common.py", "mark_clip.py", "exit_clip.py", "pnl_snapshot.py", "pass_marks.py", "close_lesson.py")],
    "oddsborne": [HERE / "oddsborne" / f for f in ("pm_exit.py", "pm_watch.py", "pm_fills_sync.py", "pm_pnl_snapshot.py", "pm_decision_markets.py", "close_lesson.py")],
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
        self.assertEqual((HERE / "bandit" / "steward_rpc.py").read_text(), (HERE / "oddsborne" / "steward_rpc.py").read_text(),
                         "keep steward_rpc.py identical in both steward dirs")
        # Every function a script calls is in the edge allowlist for that steward, defined in the schema,
        # SECURITY INVOKER, and granted to that worker only (plus service_role), never to anon/authenticated.
        sql = ENTRY_SQL.read_text() + EXIT_SQL.read_text() + MARKS_SQL.read_text() + SIDES_SQL.read_text()
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
                  "oddsborne": ("polymarket-us", "psycopg", "psycopg-binary")}
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
