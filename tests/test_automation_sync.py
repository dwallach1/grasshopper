from __future__ import annotations

import unittest

from thesisforge.automations.sync import _json_default, extract_sections, milliseconds_iso


class AutomationSyncTests(unittest.TestCase):
    def test_extracts_report_sections(self) -> None:
        report = """# Findings
- Ranked two candidates

## What we learned
- Liquidity is the limiting gate

## Explored
- Earnings calendar and filings

## Actions
- Published the dashboard
"""
        sections = extract_sections(report)
        self.assertEqual(sections["findings"], ["Ranked two candidates"])
        self.assertEqual(sections["learnings"], ["Liquidity is the limiting gate"])
        self.assertEqual(sections["explored"], ["Earnings calendar and filings"])
        self.assertEqual(sections["actions"], ["Published the dashboard"])

    def test_converts_codex_epoch_milliseconds(self) -> None:
        self.assertEqual(milliseconds_iso(0), "1970-01-01T00:00:00Z")

    def test_serializes_database_timestamps(self) -> None:
        import datetime as dt

        value = dt.datetime(2026, 8, 24, tzinfo=dt.timezone.utc)
        self.assertEqual(_json_default(value), "2026-08-24T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
