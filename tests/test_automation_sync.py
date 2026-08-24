from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from thesisforge.automations.defer_sync import current_thread_id, reconciler_command
from thesisforge.automations.reconcile import sync_with_retries, wait_for_terminal_rollout
from thesisforge.automations.sync import (
    _json_default,
    extract_sections,
    milliseconds_iso,
    read_rollout,
    run_outcome,
)


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

    def test_terminal_rollout_turns_pending_review_into_passed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rollout_path = Path(directory) / "rollout.jsonl"
            events = [
                {
                    "timestamp": "2026-08-24T14:23:05.193Z",
                    "type": "event_msg",
                    "payload": {"type": "agent_message", "message": "Final report"},
                },
                {
                    "timestamp": "2026-08-24T14:23:05.228Z",
                    "type": "event_msg",
                    "payload": {"type": "task_complete"},
                },
            ]
            rollout_path.write_text("\n".join(json.dumps(event) for event in events))

            rollout = read_rollout(str(rollout_path))

        self.assertTrue(rollout["task_complete"])
        self.assertEqual(rollout["final_output"], "Final report")
        self.assertEqual(run_outcome({"status": "PENDING_REVIEW"}, rollout), "passed")

    def test_waits_for_the_requested_thread_terminal_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollout_path = root / "rollout.jsonl"
            rollout_path.write_text(json.dumps({
                "type": "event_msg",
                "payload": {"type": "task_complete"},
            }))
            state_path = root / "state_test.sqlite"
            conn = sqlite3.connect(state_path)
            conn.execute(
                "CREATE TABLE threads (id TEXT, rollout_path TEXT, tokens_used INTEGER, "
                "archived INTEGER, preview TEXT)"
            )
            conn.execute(
                "INSERT INTO threads VALUES (?, ?, 0, 0, '')",
                ("thread-123", str(rollout_path)),
            )
            conn.commit()
            conn.close()

            result = wait_for_terminal_rollout(
                "thread-123",
                root=root,
                timeout_seconds=0,
                poll_seconds=0,
            )

        self.assertTrue(result["task_complete"])

    def test_deferred_sync_targets_current_codex_thread(self) -> None:
        with mock.patch.dict(os.environ, {"CODEX_THREAD_ID": "thread-123"}):
            self.assertEqual(current_thread_id(), "thread-123")
        command = reconciler_command("thread-123", 90)
        self.assertEqual(command[-4:], ["--thread-id", "thread-123", "--timeout-seconds", "90"])

    @mock.patch("thesisforge.automations.reconcile.time.sleep")
    @mock.patch("thesisforge.automations.reconcile.sync")
    def test_reconciler_retries_transient_sync_failure(self, sync_mock, sleep_mock) -> None:
        sync_mock.side_effect = [RuntimeError("temporary network failure"), None]

        sync_with_retries(attempts=2, retry_seconds=3)

        self.assertEqual(sync_mock.call_count, 2)
        sleep_mock.assert_called_once_with(3)


if __name__ == "__main__":
    unittest.main()
