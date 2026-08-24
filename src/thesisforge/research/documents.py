#!/usr/bin/env python3
"""Archive immutable research originals and persist queryable metadata."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from thesisforge import db as database
from thesisforge.clock import utc_now_iso
from thesisforge.storage import RESEARCH_BUCKET, StorageClient

MAX_EXTRACTED_CHARS = 500_000
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
SENTIMENTS = {"bullish", "bearish", "neutral", "mixed", "unknown"}


@dataclass(frozen=True)
class Extraction:
    text: str | None
    status: str
    error: str | None = None


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
    return title, "\n".join(line for line in lines if len(line) > 1)


def extract_text(data: bytes, mime_type: str, *, charset: str = "utf-8") -> Extraction:
    base_mime = mime_type.split(";", 1)[0].strip().lower()
    try:
        if base_mime in {"text/html", "application/xhtml+xml"}:
            _, text = clean_html(data.decode(charset, errors="replace"))
            return Extraction(text[:MAX_EXTRACTED_CHARS], "complete")
        if base_mime.startswith("text/") or base_mime in {
            "application/json",
            "application/xml",
            "application/x-ndjson",
        }:
            return Extraction(data.decode(charset, errors="replace")[:MAX_EXTRACTED_CHARS], "complete")
        if base_mime == "application/pdf":
            pdftotext = shutil.which("pdftotext")
            if not pdftotext:
                return Extraction(None, "pending", "pdftotext is not installed")
            result = subprocess.run(
                [pdftotext, "-", "-"],
                input=data,
                capture_output=True,
                check=False,
                timeout=60,
            )
            if result.returncode != 0:
                error = result.stderr.decode("utf-8", errors="replace")[:1000]
                return Extraction(None, "failed", error or f"pdftotext exited {result.returncode}")
            return Extraction(
                result.stdout.decode("utf-8", errors="replace")[:MAX_EXTRACTED_CHARS],
                "complete",
            )
    except Exception as exc:
        return Extraction(None, "failed", f"{type(exc).__name__}: {exc}")
    return Extraction(None, "unsupported", f"No text extractor for {base_mime or 'unknown MIME type'}")


def document_type_for(mime_type: str, name: str, requested: str | None = None) -> str:
    if requested:
        return requested
    base_mime = mime_type.split(";", 1)[0].lower()
    suffix = Path(urlparse(name).path).suffix.lower()
    if base_mime == "application/pdf" or suffix == ".pdf":
        return "filing" if "filing" in name.lower() else "pdf"
    if base_mime in {"text/html", "application/xhtml+xml"}:
        return "article"
    if "presentation" in base_mime or suffix in {".ppt", ".pptx"}:
        return "presentation"
    if "spreadsheet" in base_mime or suffix in {".csv", ".tsv", ".xls", ".xlsx"}:
        return "spreadsheet"
    if base_mime.startswith("image/"):
        return "image"
    if base_mime.startswith("text/"):
        return "transcript"
    return "other"


def extension_for(mime_type: str, name: str) -> str:
    suffix = Path(urlparse(name).path).suffix.lower()
    if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        return suffix
    return mimetypes.guess_extension(mime_type.split(";", 1)[0].lower()) or ".bin"


def object_path_for(
    checksum: str,
    document_type: str,
    captured_at: str,
    mime_type: str,
    source_name: str,
) -> str:
    year_month = captured_at[:7].replace("-", "/")
    return f"{document_type}/{year_month}/{checksum}{extension_for(mime_type, source_name)}"


def archive_bytes(
    conn,
    storage: StorageClient,
    data: bytes,
    *,
    source_url: str,
    mime_type: str,
    title: str | None = None,
    publisher: str | None = None,
    requested_type: str | None = None,
    usefulness: str = "inbox",
    usefulness_reason: str | None = None,
    article_id: int | None = None,
    captured_at: str | None = None,
) -> int:
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"Research original exceeds {MAX_DOWNLOAD_BYTES} bytes")
    captured_at = captured_at or utc_now_iso()
    checksum = hashlib.sha256(data).hexdigest()
    doc_type = document_type_for(mime_type, source_url, requested_type)
    bucket = os.environ.get("THESISFORGE_RESEARCH_BUCKET", RESEARCH_BUCKET)
    path = object_path_for(checksum, doc_type, captured_at, mime_type, source_url)
    extraction = extract_text(data, mime_type)

    existing = conn.execute(
        "SELECT id, extracted_text, extraction_status FROM research_documents WHERE sha256=?",
        (checksum,),
    ).fetchone()
    if existing:
        document_id = int(existing["id"])
        if existing["extracted_text"] is None and extraction.text is not None:
            conn.execute(
                """UPDATE research_documents
                   SET extracted_text=?, extraction_status='complete', extraction_error=NULL
                   WHERE id=?""",
                (extraction.text, document_id),
            )
    else:
        storage.ensure_private_bucket(bucket)
        storage.upload_immutable(bucket, path, data, mime_type.split(";", 1)[0])
        cursor = conn.execute(
            """INSERT INTO research_documents(
                 sha256, storage_bucket, storage_path, mime_type, document_type,
                 byte_size, extracted_text, extraction_status, extraction_error, captured_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                checksum,
                bucket,
                path,
                mime_type,
                doc_type,
                len(data),
                extraction.text,
                extraction.status,
                extraction.error,
                captured_at,
            ),
        )
        document_id = int(cursor.lastrowid)

    if article_id is not None:
        source = conn.execute(
            "SELECT id FROM research_document_sources WHERE article_id=?",
            (article_id,),
        ).fetchone()
    else:
        source = conn.execute(
            "SELECT id FROM research_document_sources WHERE document_id=? AND source_url=?",
            (document_id, source_url),
        ).fetchone()
    values = (
        document_id,
        article_id,
        source_url,
        title,
        publisher,
        usefulness,
        usefulness_reason,
        captured_at,
    )
    if source:
        conn.execute(
            """UPDATE research_document_sources
               SET document_id=?, article_id=?, source_url=?, title=?, publisher=?,
                   usefulness=?, usefulness_reason=?, captured_at=?
               WHERE id=?""",
            (*values, source["id"]),
        )
    else:
        conn.execute(
            """INSERT INTO research_document_sources(
                 document_id, article_id, source_url, title, publisher,
                 usefulness, usefulness_reason, captured_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            values,
        ).lastrowid
    return document_id


def upsert_annotation(
    conn,
    document_id: int,
    entity_type: str,
    entity_key: str,
    *,
    sentiment: str = "unknown",
    sentiment_score: int | None = None,
    relevance: str = "primary",
    confidence: int = 80,
    evidence_role: str = "context",
    rationale: str | None = None,
) -> None:
    conn.execute(
        """INSERT INTO research_document_annotations(
             document_id, entity_type, entity_key, relevance, sentiment,
             sentiment_score, confidence, evidence_role, rationale, provenance
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
           ON CONFLICT(document_id, entity_type, entity_key, provenance, model_version)
           DO UPDATE SET relevance=excluded.relevance, sentiment=excluded.sentiment,
             sentiment_score=excluded.sentiment_score, confidence=excluded.confidence,
             evidence_role=excluded.evidence_role, rationale=excluded.rationale,
             updated_at=now()""",
        (
            document_id,
            entity_type,
            entity_key,
            relevance,
            sentiment,
            sentiment_score,
            confidence,
            evidence_role,
            rationale,
        ),
    )


def parse_entity(value: str) -> tuple[str, str, int | None]:
    parts = value.split(":")
    key = parts[0].strip()
    sentiment = parts[1].strip().lower() if len(parts) > 1 else "unknown"
    score = int(parts[2]) if len(parts) > 2 else None
    if not key or sentiment not in SENTIMENTS or score is not None and not -100 <= score <= 100:
        raise argparse.ArgumentTypeError("use KEY[:bullish|bearish|neutral|mixed|unknown[:score]]")
    return key, sentiment, score


def read_source(source: str, mime_override: str | None) -> tuple[bytes, str, str | None]:
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        request = urllib.request.Request(
            source,
            headers={"User-Agent": "ThesisForge/0.1 research-archive", "Accept": "*/*"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            mime_type = mime_override or response.headers.get("content-type", "application/octet-stream")
            final_url = response.geturl()
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ValueError(f"Download exceeds {MAX_DOWNLOAD_BYTES} bytes")
        return data, mime_type, final_url
    path = Path(source).expanduser().resolve()
    data = path.read_bytes()
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"File exceeds {MAX_DOWNLOAD_BYTES} bytes")
    mime_type = mime_override or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return data, mime_type, path.as_uri()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup", help="Create or reconcile the private research bucket")
    archive = commands.add_parser("archive", help="Archive a URL or local file")
    archive.add_argument("source")
    archive.add_argument("--title")
    archive.add_argument("--publisher")
    archive.add_argument("--mime-type")
    archive.add_argument(
        "--type",
        choices=["article", "filing", "pdf", "transcript", "presentation", "spreadsheet", "image", "other"],
    )
    archive.add_argument("--usefulness", choices=["inbox", "useful", "noise", "archived"], default="inbox")
    archive.add_argument("--reason")
    archive.add_argument("--symbol", action="append", default=[], type=parse_entity)
    archive.add_argument("--theme", action="append", default=[], type=parse_entity)
    archive.add_argument("--thesis", action="append", default=[], type=parse_entity)
    archive.add_argument("--evidence-role", choices=["supports", "contradicts", "context", "unknown"], default="context")
    archive.add_argument("--confidence", type=int, default=80, choices=range(0, 101), metavar="0..100")
    archive.add_argument("--rationale")
    commands.add_parser("status", help="Show archive metadata and bucket status")
    verify = commands.add_parser("verify", help="Download and checksum one archived original")
    verify.add_argument("document_id", type=int)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "setup":
        storage = StorageClient()
        bucket = os.environ.get("THESISFORGE_RESEARCH_BUCKET", RESEARCH_BUCKET)
        details = storage.ensure_private_bucket(bucket)
        print(json.dumps({"bucket": details["id"], "private": not details["public"], "ready": True}))
        return

    conn = database.connect()
    try:
        if args.command == "archive":
            storage = StorageClient()
            data, mime_type, source_url = read_source(args.source, args.mime_type)
            parsed = urlparse(source_url)
            publisher = args.publisher or (parsed.netloc.lower().removeprefix("www.") or None)
            document_id = archive_bytes(
                conn,
                storage,
                data,
                source_url=source_url,
                mime_type=mime_type,
                title=args.title or Path(parsed.path).name or source_url,
                publisher=publisher,
                requested_type=args.type,
                usefulness=args.usefulness,
                usefulness_reason=args.reason,
            )
            for entity_type in ("symbol", "theme", "thesis"):
                for key, sentiment, score in getattr(args, entity_type):
                    upsert_annotation(
                        conn,
                        document_id,
                        entity_type,
                        key.upper() if entity_type == "symbol" else key,
                        sentiment=sentiment,
                        sentiment_score=score,
                        confidence=args.confidence,
                        evidence_role=args.evidence_role,
                        rationale=args.rationale,
                    )
            conn.commit()
            print(json.dumps({"document_id": document_id, "mime_type": mime_type, "bytes": len(data)}))
        elif args.command == "status":
            row = conn.execute(
                """SELECT count(*) AS documents, coalesce(sum(byte_size), 0) AS bytes,
                          count(*) FILTER (WHERE extraction_status='complete') AS searchable,
                          count(*) FILTER (WHERE extraction_status IN ('pending','failed')) AS needs_extraction
                   FROM research_documents"""
            ).fetchone()
            bucket = os.environ.get("THESISFORGE_RESEARCH_BUCKET", RESEARCH_BUCKET)
            try:
                details = StorageClient().get_bucket(bucket)
                bucket_ready = details is not None and details.get("public") is False
                storage_configured = True
            except RuntimeError:
                bucket_ready = False
                storage_configured = False
            print(
                json.dumps(
                    {
                        "documents": int(row["documents"]),
                        "bytes": int(row["bytes"]),
                        "searchable": int(row["searchable"]),
                        "needs_extraction": int(row["needs_extraction"]),
                        "bucket": bucket,
                        "bucket_ready": bucket_ready,
                        "storage_credentials_configured": storage_configured,
                    }
                )
            )
        elif args.command == "verify":
            storage = StorageClient()
            row = conn.execute(
                "SELECT sha256, storage_bucket, storage_path, byte_size FROM research_documents WHERE id=?",
                (args.document_id,),
            ).fetchone()
            if not row:
                raise SystemExit(f"Unknown research document {args.document_id}")
            data = storage.download(row["storage_bucket"], row["storage_path"])
            checksum = hashlib.sha256(data).hexdigest()
            verified = checksum == row["sha256"] and len(data) == row["byte_size"]
            print(json.dumps({"document_id": args.document_id, "verified": verified, "bytes": len(data)}))
            if not verified:
                raise SystemExit("Archived object checksum verification failed")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
