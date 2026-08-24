"""Supabase Postgres connection helpers for ThesisForge."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[3]
AUTO_RETURNING_TABLES = {
    "financial_api_requests",
    "research_document_annotations",
    "research_document_sources",
    "research_documents",
    "research_events",
    "runs",
    "trade_proposals",
}


class Row(dict):
    """Mapping row that also supports compact positional access."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)

    def __iter__(self):
        return iter(self.values())


def _row_factory(cursor: Any):
    columns = [] if cursor.description is None else [column.name for column in cursor.description]

    def make_row(values: Iterable[Any]) -> Row:
        return Row(zip(columns, values))

    return make_row


def load_local_env() -> None:
    """Load missing values from .env.local without overriding the shell."""
    path = ROOT / ".env.local"
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def database_url() -> str:
    load_local_env()
    url = os.environ.get("THESISFORGE_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("THESISFORGE_DATABASE_URL is required for Supabase Postgres")
    return url


def connect():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "Install the ThesisForge package and pinned dependencies with: "
            "bun run setup:python"
        ) from exc
    return Connection(psycopg.connect(database_url(), row_factory=_row_factory))


def _adapt_parameters(sql: str) -> str:
    adapted = sql.replace("?", "%s")
    insert_match = re.match(r"\s*INSERT\s+INTO\s+([a-z_]+)", adapted, re.IGNORECASE)
    if insert_match and insert_match.group(1).lower() in AUTO_RETURNING_TABLES and "RETURNING" not in adapted.upper():
        adapted = adapted.rstrip().rstrip(";") + " RETURNING id"
    return adapted


class Cursor:
    def __init__(self, raw: Any):
        self.raw = raw

    @property
    def rowcount(self) -> int:
        return self.raw.rowcount

    @property
    def lastrowid(self) -> int | None:
        row = self.raw.fetchone()
        return int(row[0]) if row else None

    def fetchone(self):
        return self.raw.fetchone()

    def fetchall(self):
        return self.raw.fetchall()

    def __iter__(self):
        return iter(self.raw)


class Connection:
    def __init__(self, raw: Any):
        self.raw = raw

    def execute(self, sql: str, params: Iterable[Any] = ()) -> Cursor:
        return Cursor(self.raw.execute(_adapt_parameters(sql), tuple(params)))

    def executemany(self, sql: str, params: Iterable[Iterable[Any]]) -> Cursor:
        cursor = self.raw.cursor()
        cursor.executemany(_adapt_parameters(sql), params)
        return Cursor(cursor)

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()
