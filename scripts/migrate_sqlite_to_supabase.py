#!/usr/bin/env python3
"""Copy and verify the local ThesisForge SQLite database in Supabase Postgres."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Any

try:
    from scripts import database
except ModuleNotFoundError:
    import database

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "thesisforge.sqlite"

TABLE_ORDER = [
    "runs", "bookmarks", "bookmark_urls", "symbols", "bookmark_symbols", "claims",
    "theses", "thesis_symbols", "thesis_evidence", "thesis_scores", "catalysts",
    "portfolio_exposure", "account_snapshots", "trade_proposals", "postmortems", "articles",
    "graph_nodes", "graph_edges", "research_events", "research_queue", "predictions", "insights",
    "insight_links", "thesis_relations", "event_decisions", "research_cycles", "strategy_tests",
    "test_scenarios", "agent_runs", "research_lessons", "risk_controls", "financial_api_requests",
    "financial_request_cache", "financial_access_log", "financial_records",
]

JSON_COLUMNS = {
    "bookmarks": {"raw_json"},
    "graph_nodes": {"properties_json"},
    "graph_edges": {"properties_json"},
    "risk_controls": {"threshold_json"},
    "trade_proposals": {"broker_alerts"},
    "financial_api_requests": {"params_json", "body_json", "response_headers_json"},
    "financial_records": {"payload_json"},
}
BOOLEAN_COLUMNS = {
    "bookmarks": {"is_market_related"},
    "agent_runs": {"price_blinded"},
    "research_lessons": {"incorporated"},
}
DATE_COLUMNS = {
    "catalysts": {"event_date"},
    "predictions": {"target_date"},
    "financial_records": {"report_period", "filing_date"},
}


def convert_value(table: str, column: str, value: Any) -> Any:
    if value is None:
        return None
    if column in BOOLEAN_COLUMNS.get(table, set()):
        return bool(value)
    if column in DATE_COLUMNS.get(table, set()):
        return dt.date.fromisoformat(str(value))
    if column in JSON_COLUMNS.get(table, set()):
        from psycopg.types.json import Jsonb
        return Jsonb(json.loads(value) if isinstance(value, str) else value)
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--replace", action="store_true", help="Clear target tables before importing")
    args = parser.parse_args()

    source = sqlite3.connect(args.source)
    source.row_factory = sqlite3.Row
    target = database.connect(require_remote=True)
    if not database.is_postgres(target):
        parser.error("The target must be Postgres")

    try:
        if args.replace:
            target.execute("TRUNCATE TABLE " + ", ".join(f"public.{name}" for name in reversed(TABLE_ORDER)) + " RESTART IDENTITY CASCADE")

        for table in TABLE_ORDER:
            source_columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
            rows = source.execute(f"SELECT * FROM {table}").fetchall()
            if rows:
                placeholders = ", ".join("%s" for _ in source_columns)
                statement = f"INSERT INTO public.{table} ({', '.join(source_columns)}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
                values = [
                    tuple(convert_value(table, column, row[column]) for column in source_columns)
                    for row in rows
                ]
                cursor = target.raw.cursor()
                cursor.executemany(statement, values)
            expected = len(rows)
            actual = target.execute(f"SELECT count(*) AS count FROM public.{table}").fetchone()[0]
            if actual != expected:
                raise RuntimeError(f"{table}: expected {expected} rows, found {actual}")
            print(f"{table}: {actual}")

        for table in TABLE_ORDER:
            sequence_row = target.execute(
                "SELECT pg_get_serial_sequence(?, 'id') AS sequence_name",
                (f"public.{table}",),
            ).fetchone()
            sequence_name = sequence_row[0] if sequence_row else None
            if sequence_name:
                target.execute(
                    "SELECT setval(?::regclass, COALESCE((SELECT max(id) FROM "
                    + f"public.{table}"
                    + "), 1), COALESCE((SELECT max(id) FROM "
                    + f"public.{table}"
                    + "), 0) > 0)",
                    (sequence_name,),
                )

        source_hashes = {
            row[0] for row in source.execute("SELECT response_sha256 FROM financial_api_requests")
        }
        target_hashes = {
            row[0] for row in target.execute("SELECT response_sha256 FROM financial_api_requests")
        }
        if source_hashes != target_hashes:
            raise RuntimeError("financial_api_requests: response hash verification failed")

        target.commit()
        print(f"Supabase import verified successfully ({len(source_hashes)} purchased-response hashes)")
    except Exception:
        target.rollback()
        raise
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    main()
