#!/usr/bin/env python3
"""Fetch readable text for bookmarked article URLs and store it in SQLite."""
from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "thesisforge.sqlite"

ARTICLE_SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  bookmark_id TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  fetched_at TEXT NOT NULL,
  status_code INTEGER,
  content_type TEXT,
  text TEXT,
  error TEXT,
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id)
);
"""

SKIP_HOSTS = {"x.com", "twitter.com", "pic.x.com", "youtube.com", "www.youtube.com", "youtu.be"}


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean_html(raw: str) -> tuple[str | None, str]:
    title = None
    title_match = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    if title_match:
        title = html.unescape(re.sub(r"\s+", " ", title_match.group(1))).strip()

    raw = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?is)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?is)</p>|</h[1-6]>|</li>|</blockquote>", "\n", raw)
    text = re.sub(r"(?is)<[^>]+>", " ", raw)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if len(line) > 1)
    return title, text[:50000]


def fetch(url: str, timeout: int) -> tuple[int | None, str | None, str | None, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ThesisForge/0.1 (+local research agent)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", None)
            content_type = resp.headers.get("content-type", "")
            body = resp.read(2_000_000)
            charset = resp.headers.get_content_charset() or "utf-8"
            raw = body.decode(charset, errors="replace")
            title, text = clean_html(raw)
            return status, content_type, title, text
    except Exception as exc:  # Store failures; article availability changes constantly.
        return None, None, None, f"ERROR: {type(exc).__name__}: {exc}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=12)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(ARTICLE_SCHEMA)

    rows = conn.execute(
        """
        SELECT bookmark_id, COALESCE(expanded_url, url) AS target
        FROM bookmark_urls
        WHERE COALESCE(expanded_url, url) IS NOT NULL
        ORDER BY bookmark_id DESC
        """
    ).fetchall()

    fetched = 0
    skipped = 0
    for bookmark_id, url in rows:
        if fetched >= args.limit:
            break
        parsed = urlparse(url)
        host = parsed.netloc.lower().replace("www.", "")
        if parsed.scheme not in {"http", "https"} or host in SKIP_HOSTS:
            skipped += 1
            continue
        if conn.execute("SELECT 1 FROM articles WHERE url = ?", (url,)).fetchone():
            skipped += 1
            continue

        status, content_type, title, text_or_error = fetch(url, args.timeout)
        error = text_or_error if text_or_error and text_or_error.startswith("ERROR:") else None
        text = None if error else text_or_error
        conn.execute(
            """
            INSERT OR REPLACE INTO articles(bookmark_id, url, title, fetched_at, status_code, content_type, text, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (bookmark_id, url, title, now_iso(), status, content_type, text, error),
        )
        fetched += 1
        print(f"fetched {url} -> {status or 'error'}", file=sys.stderr)

    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    print(f"articles_fetched_this_run={fetched}")
    print(f"articles_total={count}")
    print(f"skipped={skipped}")
    conn.close()


if __name__ == "__main__":
    main()
