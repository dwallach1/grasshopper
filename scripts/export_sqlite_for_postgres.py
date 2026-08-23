#!/usr/bin/env python3
"""Export the rollback SQLite database as a transactional Postgres data load."""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Any

try:
    from scripts.migrate_sqlite_to_supabase import BOOLEAN_COLUMNS, DATE_COLUMNS, JSON_COLUMNS, TABLE_ORDER
except ModuleNotFoundError:
    from migrate_sqlite_to_supabase import BOOLEAN_COLUMNS, DATE_COLUMNS, JSON_COLUMNS, TABLE_ORDER

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "thesisforge.sqlite"

IDENTITY_TABLES = [
    "runs", "claims", "thesis_evidence", "thesis_scores", "catalysts",
    "portfolio_exposure", "account_snapshots", "trade_proposals", "postmortems",
    "articles", "graph_edges", "research_events", "research_queue", "predictions",
    "insights", "research_cycles", "strategy_tests", "test_scenarios", "agent_runs",
    "research_lessons", "risk_controls", "financial_api_requests", "financial_access_log",
    "financial_records",
]


def quote_text(value: str) -> str:
    if "\x00" in value:
        raise ValueError("Postgres text values cannot contain NUL bytes")
    return "'" + value.replace("'", "''") + "'"


def literal(table: str, column: str, value: Any) -> str:
    if value is None:
        return "NULL"
    if column in BOOLEAN_COLUMNS.get(table, set()):
        return "TRUE" if bool(value) else "FALSE"
    if isinstance(value, bytes):
        return f"decode('{value.hex()}', 'hex')"
    if column in JSON_COLUMNS.get(table, set()):
        parsed = json.loads(value) if isinstance(value, str) else value
        return quote_text(json.dumps(parsed, sort_keys=True, separators=(",", ":"))) + "::jsonb"
    if column in DATE_COLUMNS.get(table, set()):
        return quote_text(str(value)) + "::date"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"Non-finite value in {table}.{column}")
        return repr(value)
    return quote_text(str(value))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    source = sqlite3.connect(args.source)
    source.row_factory = sqlite3.Row
    statements = ["begin;", "set local statement_timeout = '5min';"]
    try:
        for table in TABLE_ORDER:
            columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
            rows = source.execute(f"SELECT * FROM {table}").fetchall()
            if not rows:
                continue
            values = [
                "(" + ", ".join(literal(table, column, row[column]) for column in columns) + ")"
                for row in rows
            ]
            statements.append(
                f"insert into public.{table} ({', '.join(columns)}) values\n"
                + ",\n".join(values)
                + "\non conflict do nothing;"
            )

        for table in IDENTITY_TABLES:
            statements.append(
                "select setval(pg_get_serial_sequence('public."
                + table
                + "', 'id'), coalesce(max(id), 1), max(id) is not null) from public."
                + table
                + ";"
            )
        statements.append("commit;")
        args.output.write_text("\n\n".join(statements) + "\n")
        print(f"Wrote transactional import to {args.output}")
    finally:
        source.close()


if __name__ == "__main__":
    main()
