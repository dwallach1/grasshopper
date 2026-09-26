"""Dependency-free checks for the steward entry scripts (run in CI)."""
from __future__ import annotations

import py_compile
import re
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

    def test_guidance_gets_five_args_including_invalidation(self) -> None:
        bandit = SCRIPTS["bandit"].read_text()
        self.assertIn("steward_sizing_guidance('bandit', %s, %s, %s, %s)", bandit)
        self.assertIn("PLANNED_INVALIDATION", bandit)
        self.assertIn('raise RuntimeError("invalidation price must be > 0")', bandit)
        odds = SCRIPTS["oddsborne"].read_text()
        self.assertIn("public.steward_sizing_guidance(%s, %s, %s, %s, %s)", odds)
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


if __name__ == "__main__":
    unittest.main()
