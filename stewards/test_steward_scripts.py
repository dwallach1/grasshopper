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
SCRIPTS = {
    "bandit": HERE / "bandit" / "live_trade_clip.py",
    "oddsborne": HERE / "oddsborne" / "pm_enter.py",
}
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
        bandit = SCRIPTS["bandit"].read_text()
        self.assertIn("steward_sizing_guidance('bandit', %s, %s, %s, %s, %s)", bandit)
        self.assertIn("None if pretrade_price is None else str(pretrade_price)", bandit)
        self.assertIn("PLANNED_INVALIDATION", bandit)
        self.assertIn('raise RuntimeError("invalidation price must be > 0")', bandit)
        odds = SCRIPTS["oddsborne"].read_text()
        self.assertIn("public.steward_sizing_guidance(%s, %s, %s, %s, %s, %s)", odds)
        self.assertIn("sizing_guidance(cur, thesis_id, slug, requested_usd, invalidation, price)", odds)
        self.assertIn("missing_invalidation", odds)

    def test_refuses_when_entry_not_allowed(self) -> None:
        self.assertIn('if not g.get("entry_allowed"):', SCRIPTS["bandit"].read_text())
        self.assertIn("entry_allowed", SCRIPTS["oddsborne"].read_text())

    def test_orders_carry_thesis_and_cap_at_entry(self) -> None:
        for name, path in SCRIPTS.items():
            text = path.read_text()
            self.assertIn("max_stake_at_entry, max_stake_reason_at_entry", text, name)
            self.assertIn("thesis_id", text, name)

    def test_lots_carry_invalidation(self) -> None:
        self.assertIn("invalidation_price", SCRIPTS["bandit"].read_text())
        self.assertIn("invalidation_price", SCRIPTS["oddsborne"].read_text())

    def test_shadow_exit_contract(self) -> None:
        # public.v_shadow_exits reads meta.paper_<name> objects with these keys (supabase/schemas/32, 33).
        text = (HERE / "bandit" / "paper_bank20.py").read_text()
        self.assertIn("'paper_bank20'", text)
        for key in ("rule", "triggered", "trigger_minute", "paper_exit_pct", "real_exit_pct", "delta_pct_pts", "source"):
            self.assertIn(f'"{key}"', text, key)

    def test_no_hardcoded_box_paths(self) -> None:
        for name, path in list(SCRIPTS.items()) + [("paper_bank20", HERE / "bandit" / "paper_bank20.py")]:
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
        self.assertLess(clip.index('_require_runtime("bandit", ("base58", "requests", "solders.keypair", "solders.transaction", "psycopg"))'),
                        clip.index("import base58  # noqa: E402"))
        self.assertLess(clip.index("_require_runtime("), clip.index("from db_connect import connect"))
        bank = (HERE / "bandit" / "paper_bank20.py").read_text()
        self.assertLess(bank.index('_require_runtime("bandit", ("psycopg",))'), bank.index("from db_connect import connect"))
        odds = SCRIPTS["oddsborne"].read_text()
        self.assertIn('def main(argv=None) -> int:\n    _require_runtime(STEWARD, ("polymarket_us", "psycopg"))', odds)
        for text in (clip, bank, odds):
            self.assertIn("raise SystemExit(3)", text)
            self.assertIn("'stewards', 'sync_box.sh'", text)

    def test_guard_exits_3_with_the_fix_when_imports_are_missing(self) -> None:
        # The CI interpreter has none of the steward packages: every script must stop before touching anything.
        env = {**os.environ, "PYTHONNOUSERSITE": "1", "GRASSHOPPER_REPO": "/repo"}
        for script in (SCRIPTS["bandit"], HERE / "bandit" / "paper_bank20.py", SCRIPTS["oddsborne"]):
            probe = subprocess.run(["python3", "-S", "-c",
                                    "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('psycopg') else 1)"])
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
        self.assertIn('"bandit|base58 requests solders.keypair solders.transaction psycopg db_connect load_secrets|', doctor)
        self.assertIn('"oddsborne|polymarket_us psycopg db_connect load_secrets|', doctor)
        sync = (HERE / "sync_box.sh").read_text()
        for needle in ('--find-links "$wheelhouse"', 'wheelhouse="$box/.steward-wheelhouse"', 'exec bash "$here/doctor.sh"',
                       '"$here/bandit/requirements.txt:$box/bandit/requirements.txt"', '"$here/oddsborne/requirements.txt:$box/oddsborne/requirements.txt"'):
            self.assertIn(needle, sync)


if __name__ == "__main__":
    unittest.main()
