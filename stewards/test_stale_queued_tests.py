"""Pins for stalled queued strategy tests and the lesson that names one.

Schema 83 counts a queued test that is at least 7 days old or past its window,
and links a lesson whose summary names exactly one preregistered test. These
cases read that SQL. They do not score a test or touch production.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "supabase" / "schemas" / "83_stale_queued_lesson_tests.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20261020180000_stale_queued_lesson_tests.sql"


def _sql() -> str:
    schema = SCHEMA.read_text()
    migration = MIGRATION.read_text()
    if schema != migration:
        raise AssertionError("schema 83 and its migration differ")
    return schema


def _pattern(sql: str) -> re.Pattern[str]:
    start = sql.index("$pat$") + len("$pat$")
    body = sql[start:sql.index("$pat$", start)]
    return re.compile(body.replace(r"\m", r"\b"))


def named_ids(pattern: re.Pattern[str], summary: str) -> set[int]:
    found: set[int] = set()
    for match in pattern.finditer(summary or ""):
        raw = next(group for group in match.groups() if group)
        if re.fullmatch(r"[0-9]{1,18}", raw):
            found.add(int(raw))
    return found


def named_id(pattern: re.Pattern[str], summary: str) -> int | None:
    ids = named_ids(pattern, summary)
    if len(ids) != 1:
        return None
    return next(iter(ids))


class StaleQueuedLessonTests(unittest.TestCase):
    def test_schema_matches_migration_and_does_not_score_tests(self) -> None:
        sql = _sql()
        self.assertIn("as stale_queued_tests", sql)
        self.assertIn("as unlinked_named_lessons", sql)
        self.assertIn("interval '7 days'", sql)
        self.assertIn("America/New_York", sql)
        self.assertIn(
            "p_window_end < (p_at at time zone 'America/New_York')::date",
            sql,
        )
        self.assertIn("exception", sql)
        self.assertIn("when others then", sql)
        self.assertIn("and l.test_id is null", sql)
        self.assertIn("set test_id = named.named_id", sql)
        self.assertIsNone(re.search(r"update\s+public\.strategy_tests", sql, re.I))
        self.assertIn("Not applied to production", sql)
        for view in ("v_stale_queued_tests", "v_open_lesson_tests", "v_ledger_watchdog"):
            self.assertRegex(
                sql,
                rf"create or replace view public\.{view}\s+with \(security_invoker = true\)",
            )

    def test_security_definer_stays_in_private(self) -> None:
        sql = _sql()
        blocks = re.split(r"(?=create or replace function )", sql, flags=re.I)
        seen: list[tuple[str, str]] = []
        for block in blocks:
            if not block.lower().startswith("create or replace function"):
                continue
            header = block.split("$$", 1)[0]
            name = re.search(r"function\s+((?:public|private)\.\w+)", header, re.I)
            self.assertIsNotNone(name)
            assert name is not None
            if re.search(r"security\s+definer", header, re.I):
                mode = "definer"
            elif re.search(r"security\s+invoker", header, re.I):
                mode = "invoker"
            else:
                mode = "missing"
            seen.append((name.group(1), mode))
        self.assertGreaterEqual(len(seen), 8)
        for name, mode in seen:
            if name.startswith("private."):
                self.assertEqual(mode, "definer", name)
            else:
                self.assertEqual(mode, "invoker", name)

    def test_a_summary_names_one_preregistered_test(self) -> None:
        pattern = _pattern(_sql())
        self.assertIn(r"^[0-9]{1,18}$", _sql())
        self.assertEqual(named_id(pattern, "Test 42 preregistered to check it."), 42)
        self.assertEqual(named_id(pattern, "preregistered as strategy_test #41"), 41)
        self.assertEqual(named_id(pattern, "Queued test 36"), 36)
        self.assertEqual(named_id(pattern, "strategy_test #41"), 41)
        self.assertIsNone(named_id(pattern, "killed by test 30"))
        self.assertIsNone(named_id(pattern, "test 30 killed"))
        self.assertIsNone(named_id(pattern, "test 35 decides"))
        self.assertIsNone(named_id(pattern, "Test 42 preregistered and queued test 36"))
        self.assertEqual(
            named_ids(pattern, "Test 42 preregistered and queued test 36"),
            {42, 36},
        )
        self.assertIsNone(named_id(pattern, "Test " + "1" * 19 + " preregistered"))
        self.assertIsNone(named_id(pattern, ""))


if __name__ == "__main__":
    unittest.main()
