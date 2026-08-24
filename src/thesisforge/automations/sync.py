#!/usr/bin/env python3
"""Index Codex automation definitions and run history into canonical Postgres."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
from decimal import Decimal
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from thesisforge import db as database


UTC = dt.timezone.utc
SECTION_CATEGORY = {
    "finding": "findings",
    "result": "findings",
    "insight": "findings",
    "opportunit": "findings",
    "learn": "learnings",
    "lesson": "learnings",
    "risk": "learnings",
    "explor": "explored",
    "research": "explored",
    "investigat": "explored",
    "source": "explored",
    "action": "actions",
    "change": "actions",
    "update": "actions",
    "publish": "actions",
}


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()


def milliseconds_iso(value: int | None) -> str | None:
    if value is None:
        return None
    return dt.datetime.fromtimestamp(value / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _connect_readonly(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _state_database(root: Path) -> Path | None:
    candidates = sorted(root.glob("state_*.sqlite"), key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def thread_metadata(root: Path) -> dict[str, dict[str, Any]]:
    path = _state_database(root)
    if not path:
        return {}
    conn = _connect_readonly(path)
    try:
        records = conn.execute(
            "SELECT id, rollout_path, tokens_used, archived, preview FROM threads"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
    return {str(row["id"]): dict(row) for row in records}


def _message_text(payload: dict[str, Any]) -> str | None:
    message = payload.get("message")
    if isinstance(message, str):
        return message.strip() or None
    return None


def read_rollout(path: str | None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "final_output": None,
        "timeline": [],
        "task_complete": False,
        "task_failed": False,
        "task_cancelled": False,
        "error_text": None,
    }
    if not path:
        return result
    rollout = Path(path)
    if not rollout.is_file():
        return result

    messages: list[dict[str, str | None]] = []
    errors: list[str] = []
    with rollout.open(errors="replace") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = event.get("payload") or {}
            event_type = str(payload.get("type") or event.get("type") or "")
            if event.get("type") == "event_msg" and event_type == "agent_message":
                text = _message_text(payload)
                if text:
                    messages.append({"at": event.get("timestamp"), "text": text})
            lowered = event_type.lower()
            if lowered in {"task_complete", "turn_complete"}:
                result["task_complete"] = True
            elif lowered in {"task_failed", "turn_failed", "error"}:
                result["task_failed"] = True
                detail = payload.get("message") or payload.get("error")
                if detail:
                    errors.append(str(detail))
            elif lowered in {"task_cancelled", "turn_cancelled", "task_aborted", "turn_aborted"}:
                result["task_cancelled"] = True

    if messages:
        result["final_output"] = messages[-1]["text"]
        result["timeline"] = messages[:-1][-80:]
    result["error_text"] = "\n".join(errors) or None
    return result


def extract_sections(markdown: str | None) -> dict[str, list[str]]:
    output = {"findings": [], "learnings": [], "explored": [], "actions": []}
    if not markdown:
        return output
    category = "findings"
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line:
            continue
        heading = re.sub(r"^[#*\s]+|[:*\s]+$", "", line).lower()
        if line.startswith("#") or (line.startswith("**") and line.endswith("**")):
            for marker, candidate in SECTION_CATEGORY.items():
                if marker in heading:
                    category = candidate
                    break
            continue
        match = re.match(r"^(?:[-*+]\s+|\d+[.)]\s+)(.+)$", line)
        if not match:
            continue
        item = re.sub(r"\*\*([^*]+)\*\*", r"\1", match.group(1)).strip()
        if item and item not in output[category]:
            output[category].append(item)
    return output


def run_outcome(run: sqlite3.Row, rollout: dict[str, Any]) -> str:
    if rollout["task_failed"]:
        return "failed"
    if rollout["task_complete"]:
        return "passed"
    if rollout["task_cancelled"]:
        return "cancelled"
    status = str(run["status"] or "").upper()
    if status in {"FAILED", "ERROR"}:
        return "failed"
    if status in {"CANCELLED", "CANCELED", "DISMISSED"}:
        return "cancelled"
    return "running" if status in {"RUNNING", "PENDING", "NEW"} else "unknown"


def _json_default(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def publish_automation_snapshot(conn: Any) -> None:
    automations = [dict(row) for row in conn.execute("""
        SELECT a.id, a.name, a.prompt, a.kind, a.status, a.rrule, a.model,
               a.reasoning_effort, a.next_run_at, a.last_run_at, a.indexed_at,
               COUNT(r.thread_id) AS run_count,
               COUNT(r.thread_id) FILTER (WHERE r.outcome='passed') AS passed_count,
               COUNT(r.thread_id) FILTER (WHERE r.outcome='failed') AS failed_count
        FROM codex_automations a
        LEFT JOIN codex_automation_runs r ON r.automation_id=a.id
        GROUP BY a.id
        ORDER BY CASE a.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, a.next_run_at, a.name
    """)]
    runs = [dict(row) for row in conn.execute("""
        SELECT r.thread_id, r.automation_id, a.name AS automation_name,
               r.status, r.outcome, r.started_at, r.completed_at, r.duration_ms,
               r.title, r.summary, r.final_output, r.findings, r.learnings,
               r.explored, r.actions, r.timeline, r.error_text, r.tokens_used
        FROM codex_automation_runs r
        JOIN codex_automations a ON a.id=r.automation_id
        ORDER BY r.started_at DESC
        LIMIT 200
    """)]
    patch = json.loads(json.dumps(
        {"automations": automations, "automation_runs": runs},
        default=_json_default,
    ))
    cursor = conn.execute(
        """UPDATE dashboard_snapshots
           SET generated_at=now(), payload=payload || ?
           WHERE id='current'""",
        (Jsonb(patch),),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("Canonical dashboard snapshot 'current' does not exist")


def sync() -> tuple[int, int]:
    root = codex_home()
    registry_path = root / "sqlite" / "codex-dev.db"
    if not registry_path.is_file():
        raise RuntimeError(f"Codex automation registry not found at {registry_path}")

    source = _connect_readonly(registry_path)
    try:
        automations = source.execute("SELECT * FROM automations ORDER BY id").fetchall()
        runs = source.execute("SELECT * FROM automation_runs ORDER BY created_at").fetchall()
    finally:
        source.close()
    threads = thread_metadata(root)

    conn = database.connect()
    conn.execute("set local statement_timeout = '15s'")
    try:
        for row in automations:
            conn.execute(
                """INSERT INTO codex_automations(
                     id, name, prompt, kind, status, rrule, model, reasoning_effort,
                     execution_environment, project_id, working_directories,
                     next_run_at, last_run_at, source_created_at, source_updated_at, indexed_at
                   ) VALUES (?, ?, ?, 'cron', ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, now())
                   ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, prompt=excluded.prompt, status=excluded.status,
                     rrule=excluded.rrule, model=excluded.model,
                     reasoning_effort=excluded.reasoning_effort,
                     execution_environment=excluded.execution_environment,
                     project_id=excluded.project_id,
                     working_directories=excluded.working_directories,
                     next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at,
                     source_created_at=excluded.source_created_at,
                     source_updated_at=excluded.source_updated_at, indexed_at=now()""",
                (
                    row["id"], row["name"], row["prompt"], row["status"], row["rrule"],
                    row["model"], row["reasoning_effort"], row["project_id"],
                    Jsonb(json.loads(row["cwds"] or "[]")), milliseconds_iso(row["next_run_at"]),
                    milliseconds_iso(row["last_run_at"]), milliseconds_iso(row["created_at"]),
                    milliseconds_iso(row["updated_at"]),
                ),
            )

        for row in runs:
            thread = threads.get(str(row["thread_id"]), {})
            rollout = read_rollout(thread.get("rollout_path"))
            sections = extract_sections(rollout["final_output"] or row["inbox_summary"])
            outcome = run_outcome(row, rollout)
            started_at = milliseconds_iso(row["created_at"])
            completed_at = milliseconds_iso(row["updated_at"]) if outcome != "running" else None
            duration_ms = max(0, row["updated_at"] - row["created_at"]) if completed_at else None
            metadata = {
                "inbox_title": row["inbox_title"],
                "source_cwd": row["source_cwd"],
                "read_at": row["read_at"],
                "archived_reason": row["archived_reason"],
                "archived": bool(thread.get("archived", False)),
            }
            conn.execute(
                """INSERT INTO codex_automation_runs(
                     thread_id, automation_id, status, outcome, started_at, completed_at,
                     duration_ms, title, summary, final_output, findings, learnings,
                     explored, actions, timeline, error_text, tokens_used,
                     source_metadata, indexed_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
                   ON CONFLICT(thread_id) DO UPDATE SET
                     status=excluded.status, outcome=excluded.outcome,
                     completed_at=excluded.completed_at, duration_ms=excluded.duration_ms,
                     title=excluded.title, summary=excluded.summary,
                     final_output=excluded.final_output, findings=excluded.findings,
                     learnings=excluded.learnings, explored=excluded.explored,
                     actions=excluded.actions, timeline=excluded.timeline,
                     error_text=excluded.error_text, tokens_used=excluded.tokens_used,
                     source_metadata=excluded.source_metadata, indexed_at=now()""",
                (
                    row["thread_id"], row["automation_id"], row["status"], outcome,
                    started_at, completed_at, duration_ms, row["thread_title"],
                    row["inbox_summary"], rollout["final_output"],
                    Jsonb(sections["findings"]), Jsonb(sections["learnings"]),
                    Jsonb(sections["explored"]), Jsonb(sections["actions"]),
                    Jsonb(rollout["timeline"]), rollout["error_text"],
                    thread.get("tokens_used"), Jsonb(metadata),
                ),
            )
        publish_automation_snapshot(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return len(automations), len(runs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    automation_count, run_count = sync()
    print(f"Indexed {automation_count} Codex automations and {run_count} runs")


if __name__ == "__main__":
    main()
