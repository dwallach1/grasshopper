"""Database compatibility helpers for ThesisForge.

Production uses Supabase Postgres through THESISFORGE_DATABASE_URL. SQLite is
retained only as a local fallback and for isolated tests/migration input.
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE = ROOT / "data" / "thesisforge.sqlite"

CONFLICT_KEYS = {
    "articles": ("url",),
    "bookmark_urls": ("bookmark_id", "url"),
    "insight_links": ("insight_id", "node_id", "relationship"),
    "thesis_symbols": ("thesis_id", "symbol"),
}
AUTO_RETURNING_TABLES = {"financial_api_requests", "runs"}


class CompatRow(dict):
    """Mapping row that also supports SQLite-style numeric indexing."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)

    def __iter__(self):
        return iter(self.values())


def _compat_row_factory(cursor: Any):
    # INSERT/UPDATE statements have no result columns. Psycopg still invokes
    # the configured row factory, so treat that description as an empty row.
    columns = [] if cursor.description is None else [column.name for column in cursor.description]

    def make_row(values: Iterable[Any]) -> CompatRow:
        return CompatRow(zip(columns, values))

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


def database_url() -> str | None:
    load_local_env()
    return os.environ.get("THESISFORGE_DATABASE_URL") or os.environ.get("DATABASE_URL")


def connect(sqlite_path: Path | str = DEFAULT_SQLITE, *, require_remote: bool = False):
    url = database_url()
    if url:
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError("Install pinned database dependencies with: python3 -m pip install -r requirements.txt") from exc
        raw = psycopg.connect(url, row_factory=_compat_row_factory)
        return Connection(raw, "postgres")
    if require_remote:
        raise RuntimeError("THESISFORGE_DATABASE_URL is required for the Supabase database")
    raw = sqlite3.connect(sqlite_path)
    raw.row_factory = sqlite3.Row
    return Connection(raw, "sqlite")


def is_postgres(conn: Any) -> bool:
    return getattr(conn, "backend", "sqlite") == "postgres"


def _replace_qmarks(sql: str) -> str:
    return sql.replace("?", "%s")


def _adapt_insert_or_replace(sql: str) -> str:
    match = re.search(
        r"INSERT\s+OR\s+REPLACE\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise ValueError(f"Unsupported INSERT OR REPLACE statement: {sql}")
    table = match.group(1).lower()
    keys = CONFLICT_KEYS.get(table)
    if not keys:
        raise ValueError(f"No Postgres conflict target registered for {table}")
    columns = [column.strip() for column in match.group(2).split(",")]
    updates = [column for column in columns if column not in keys]
    replacement = (
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({match.group(3)}) "
        f"ON CONFLICT ({', '.join(keys)}) DO UPDATE SET "
        + ", ".join(f"{column}=excluded.{column}" for column in updates)
    )
    return sql[: match.start()] + replacement + sql[match.end() :]


def adapt_sql(sql: str) -> str | None:
    stripped = sql.strip()
    if stripped.upper().startswith("PRAGMA "):
        return None
    adapted = sql
    if re.search(r"INSERT\s+OR\s+REPLACE", adapted, re.IGNORECASE):
        adapted = _adapt_insert_or_replace(adapted)
    if re.search(r"INSERT\s+OR\s+IGNORE", adapted, re.IGNORECASE):
        adapted = re.sub(r"INSERT\s+OR\s+IGNORE", "INSERT", adapted, flags=re.IGNORECASE)
        adapted = adapted.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    adapted = adapted.replace("json_group_array(", "json_agg(")
    insert_match = re.match(r"\s*INSERT\s+INTO\s+([a-z_]+)", adapted, re.IGNORECASE)
    if insert_match and insert_match.group(1).lower() in AUTO_RETURNING_TABLES and "RETURNING" not in adapted.upper():
        adapted = adapted.rstrip().rstrip(";") + " RETURNING id"
    return _replace_qmarks(adapted)


class NullCursor:
    rowcount = 0
    lastrowid = None

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter(())


class Cursor:
    def __init__(self, raw: Any, backend: str):
        self.raw = raw
        self.backend = backend

    @property
    def rowcount(self) -> int:
        return self.raw.rowcount

    @property
    def lastrowid(self) -> int | None:
        if self.backend == "sqlite":
            return self.raw.lastrowid
        row = self.raw.fetchone()
        return int(row[0]) if row else None

    def fetchone(self):
        return self.raw.fetchone()

    def fetchall(self):
        return self.raw.fetchall()

    def __iter__(self):
        return iter(self.raw)


class Connection:
    def __init__(self, raw: Any, backend: str):
        self.raw = raw
        self.backend = backend

    def execute(self, sql: str, params: Iterable[Any] = ()):
        if self.backend == "postgres":
            adapted = adapt_sql(sql)
            if adapted is None:
                return NullCursor()
            return Cursor(self.raw.execute(adapted, tuple(params)), self.backend)
        return Cursor(self.raw.execute(sql, tuple(params)), self.backend)

    def executescript(self, sql: str):
        if self.backend == "postgres":
            # Production schema is managed declaratively in supabase/schemas.
            return NullCursor()
        return self.raw.executescript(sql)

    def executemany(self, sql: str, params: Iterable[Iterable[Any]]):
        if self.backend == "postgres":
            adapted = adapt_sql(sql)
            if adapted is None:
                return NullCursor()
            cursor = self.raw.cursor()
            cursor.executemany(adapted, params)
            return Cursor(cursor, self.backend)
        return Cursor(self.raw.executemany(sql, params), self.backend)

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()


def table_exists(conn: Connection, name: str) -> bool:
    if is_postgres(conn):
        return conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=?",
            (name,),
        ).fetchone() is not None
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def table_columns(conn: Connection, name: str) -> set[str]:
    if is_postgres(conn):
        return {
            row[0]
            for row in conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?",
                (name,),
            )
        }
    return {row[1] for row in conn.execute(f"PRAGMA table_info({name})")}
