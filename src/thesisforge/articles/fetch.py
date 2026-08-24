#!/usr/bin/env python3
"""Fetch readable text for bookmarked article URLs and persist it."""
from __future__ import annotations

import argparse
import sys
import urllib.request
from urllib.parse import urlparse

from thesisforge import db as database
from thesisforge.clock import utc_now_iso
from thesisforge.research.documents import MAX_DOWNLOAD_BYTES, archive_bytes, clean_html, extract_text
from thesisforge.storage import StorageClient

SKIP_HOSTS = {"x.com", "twitter.com", "pic.x.com", "youtube.com", "www.youtube.com", "youtu.be"}


def fetch(
    url: str, timeout: int
) -> tuple[int | None, str | None, str | None, str | None, bytes | None, str]:
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
            body = resp.read(MAX_DOWNLOAD_BYTES + 1)
            if len(body) > MAX_DOWNLOAD_BYTES:
                raise ValueError(f"response exceeds {MAX_DOWNLOAD_BYTES} bytes")
            charset = resp.headers.get_content_charset() or "utf-8"
            base_mime = content_type.split(";", 1)[0].lower()
            if base_mime in {"text/html", "application/xhtml+xml"}:
                title, text = clean_html(body.decode(charset, errors="replace"))
                text = text[:50000]
            else:
                title = None
                extraction = extract_text(body, content_type, charset=charset)
                text = extraction.text[:50000] if extraction.text else None
            return status, content_type, title, text, body, resp.geturl()
    except Exception as exc:  # Store failures; article availability changes constantly.
        return None, None, None, f"ERROR: {type(exc).__name__}: {exc}", None, url


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=12)
    parser.add_argument(
        "--archive-html",
        action="store_true",
        help="Also preserve raw HTML snapshots; PDFs and other file-like originals archive automatically",
    )
    parser.add_argument(
        "--no-archive-originals",
        action="store_true",
        help="Disable automatic archiving of non-HTML originals",
    )
    args = parser.parse_args()

    conn = database.connect()

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

        status, content_type, title, text_or_error, body, final_url = fetch(url, args.timeout)
        error = text_or_error if text_or_error and text_or_error.startswith("ERROR:") else None
        text = None if error else text_or_error
        conn.execute(
            """
            INSERT INTO articles(bookmark_id, url, title, fetched_at, status_code, content_type, text, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              bookmark_id=excluded.bookmark_id, title=excluded.title,
              fetched_at=excluded.fetched_at, status_code=excluded.status_code,
              content_type=excluded.content_type, text=excluded.text, error=excluded.error
            """,
            (bookmark_id, url, title, utc_now_iso(), status, content_type, text, error),
        )
        article = conn.execute("SELECT id FROM articles WHERE url=?", (url,)).fetchone()
        base_mime = (content_type or "").split(";", 1)[0].lower()
        should_archive = bool(
            article
            and body
            and not error
            and (
                args.archive_html
                or not args.no_archive_originals
                and base_mime not in {"text/html", "application/xhtml+xml"}
            )
        )
        if should_archive:
            try:
                archive_bytes(
                    conn,
                    StorageClient(),
                    body,
                    source_url=final_url,
                    mime_type=content_type or "application/octet-stream",
                    title=title,
                    publisher=urlparse(final_url).netloc.lower().removeprefix("www.") or None,
                    article_id=int(article["id"]),
                )
            except Exception as exc:
                print(f"archive warning for {url}: {type(exc).__name__}: {exc}", file=sys.stderr)
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
