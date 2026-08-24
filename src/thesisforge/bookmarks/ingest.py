"""Ingest X bookmarks into the adaptive ThesisForge ontology."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from thesisforge import db as database
from thesisforge.clock import utc_now_iso
from thesisforge.ontology.learning import OntologyLearner


def extract_urls(bookmark: dict) -> list[tuple[str, str | None, str | None]]:
    urls = []
    for url in bookmark.get("entities", {}).get("urls", []) or []:
        urls.append((url.get("url"), url.get("expanded_url"), url.get("display_url")))
    return [(url, expanded, display) for url, expanded, display in urls if url]


def claim_type(text: str) -> str:
    lower = text.lower()
    if "price target" in lower or "%" in lower or "+" in lower:
        return "price_target_or_momentum"
    if "earnings" in lower or "quarter" in lower:
        return "earnings_catalyst"
    if "13f" in lower or "portfolio" in lower:
        return "investor_positioning"
    if "deal" in lower or "contract" in lower or "announced" in lower:
        return "company_event"
    if "cheap" in lower or "valuation" in lower or "multiple" in lower:
        return "valuation"
    return "opinion_or_theme"


def upsert_symbol(conn, symbol: str, seen_at: str, bookmark_id: str) -> None:
    row = conn.execute("SELECT mention_count, source_count FROM symbols WHERE symbol = ?", (symbol,)).fetchone()
    if row:
        existing_source = conn.execute(
            "SELECT 1 FROM bookmark_symbols WHERE bookmark_id = ? AND symbol = ?", (bookmark_id, symbol)
        ).fetchone()
        conn.execute(
            "UPDATE symbols SET last_seen_at = ?, mention_count = mention_count + ?, source_count = source_count + ? WHERE symbol = ?",
            (seen_at, 0 if existing_source else 1, 0 if existing_source else 1, symbol),
        )
    else:
        conn.execute(
            """INSERT INTO symbols(symbol, first_seen_at, last_seen_at, mention_count, source_count, status)
               VALUES (?, ?, ?, 1, 1, 'candidate')""",
            (symbol, seen_at, seen_at),
        )


def ingest(payload: dict) -> dict:
    fetched_at = payload.get("fetched_at") or utc_now_iso()
    bookmarks = payload.get("bookmarks", [])
    conn = database.connect()
    started_at = utc_now_iso()

    try:
        learner = OntologyLearner(conn)
        learner.sync_theme_theses()
        cursor = conn.execute(
            "INSERT INTO runs(run_type, started_at, notes) VALUES (?, ?, ?)",
            ("bookmark_ingest", started_at, None),
        )
        run_id = cursor.lastrowid

        symbol_to_themes: dict[str, Counter] = defaultdict(Counter)
        theme_to_bookmarks: dict[str, list[tuple[str, int]]] = defaultdict(list)
        market_count = 0

        for bookmark in bookmarks:
            text = bookmark.get("text") or ""
            symbols = learner.catalog.extract_symbols(text)
            score = learner.catalog.market_score(text, symbols, bookmark.get("context_annotations") or [])
            is_market = score >= 35
            market_count += int(is_market)
            created_at = bookmark.get("created_at") or fetched_at
            bookmark_id = bookmark["id"]

            conn.execute(
                """
                INSERT INTO bookmarks(id, author_id, created_at, fetched_at, text, raw_json, market_score, is_market_related)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  fetched_at=excluded.fetched_at, text=excluded.text, raw_json=excluded.raw_json,
                  market_score=excluded.market_score, is_market_related=excluded.is_market_related
                """,
                (
                    bookmark_id,
                    bookmark.get("author_id"),
                    created_at,
                    fetched_at,
                    text,
                    json.dumps(bookmark, sort_keys=True),
                    score,
                    is_market,
                ),
            )

            for url, expanded, display in extract_urls(bookmark):
                conn.execute(
                    """INSERT INTO bookmark_urls(bookmark_id, url, expanded_url, display_url)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(bookmark_id, url) DO UPDATE SET
                         expanded_url=excluded.expanded_url, display_url=excluded.display_url""",
                    (bookmark_id, url, expanded, display),
                )

            for symbol in sorted(symbols):
                upsert_symbol(conn, symbol, created_at, bookmark_id)
                conn.execute(
                    """INSERT INTO bookmark_symbols(bookmark_id, symbol, source)
                       VALUES (?, ?, 'cashtag_or_uppercase')
                       ON CONFLICT(bookmark_id, symbol) DO NOTHING""",
                    (bookmark_id, symbol),
                )

            matches = learner.catalog.classify(text, symbols)
            learner.record_source(
                source_type="bookmark",
                source_key=bookmark_id,
                text=text,
                symbols=symbols,
                matches=matches,
                observed_at=created_at,
            )

            if is_market and not conn.execute(
                "SELECT 1 FROM claims WHERE bookmark_id=? AND claim_type=?",
                (bookmark_id, claim_type(text)),
            ).fetchone():
                conn.execute(
                    """INSERT INTO claims(bookmark_id, claim_text, claim_type, created_at, confidence)
                       VALUES (?, ?, ?, ?, ?)""",
                    (bookmark_id, text[:500], claim_type(text), started_at, min(70, max(30, score))),
                )

            for match in matches:
                if match.theme.kind != "theme":
                    continue
                theme_to_bookmarks[match.theme.id].append((bookmark_id, match.score))
                for symbol in symbols:
                    symbol_to_themes[symbol][match.theme.id] += 1

        for theme_id, evidence in theme_to_bookmarks.items():
            theme = learner.catalog.themes[theme_id]
            thesis_id = theme.thesis_id or theme.id
            unique_bookmarks = {bookmark_id for bookmark_id, _ in evidence}
            average_match = round(sum(score for _, score in evidence) / len(evidence))
            confidence = min(85, max(40, round(average_match * 0.65) + len(unique_bookmarks) * 3))
            status = "forming" if confidence < 60 else "hardening"
            conn.execute(
                """UPDATE theses SET status=?, confidence=?, updated_at=? WHERE id=?""",
                (status, confidence, started_at, thesis_id),
            )

            thesis_symbols = [
                (symbol, counts[theme_id])
                for symbol, counts in symbol_to_themes.items()
                if counts[theme_id] > 0
            ]
            total = sum(count for _, count in thesis_symbols) or 1
            for symbol, count in sorted(thesis_symbols, key=lambda item: (-item[1], item[0])):
                active = theme_id in learner.catalog.memberships_by_symbol.get(symbol, {})
                conn.execute(
                    """INSERT INTO thesis_symbols(thesis_id, symbol, role, weight_hint)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(thesis_id, symbol) DO UPDATE SET
                         role=excluded.role, weight_hint=excluded.weight_hint""",
                    (thesis_id, symbol, "member" if active else "candidate", round(count / total, 4)),
                )

            for bookmark_id in sorted(unique_bookmarks):
                if conn.execute(
                    """SELECT 1 FROM thesis_evidence
                       WHERE thesis_id=? AND bookmark_id=? AND evidence_type='x_bookmark'""",
                    (thesis_id, bookmark_id),
                ).fetchone():
                    continue
                bookmark_text = conn.execute("SELECT text FROM bookmarks WHERE id=?", (bookmark_id,)).fetchone()[0]
                conn.execute(
                    """INSERT INTO thesis_evidence(
                         thesis_id, bookmark_id, evidence_type, direction, summary, confidence, created_at
                       ) VALUES (?, ?, 'x_bookmark', 'supporting', ?, ?, ?)""",
                    (thesis_id, bookmark_id, bookmark_text[:350], average_match, started_at),
                )

            conn.execute(
                """INSERT INTO thesis_scores(
                     thesis_id, scored_at, confidence, momentum, evidence_quality,
                     catalyst_strength, portfolio_fit, risk, notes
                   ) VALUES (?, ?, ?, ?, ?, 25, 50, 65, ?)""",
                (
                    thesis_id,
                    started_at,
                    confidence,
                    min(85, 30 + len(unique_bookmarks) * 6),
                    min(80, average_match),
                    "Adaptive score from database-backed term, membership, and source evidence.",
                ),
            )

        learner.recalculate_candidate_stats()
        discovered = learner.discover_emerging_themes()
        promoted = learner.promote_ready_candidates()
        pending = conn.execute(
            "SELECT COUNT(*) FROM ontology_candidates WHERE status='pending'"
        ).fetchone()[0]
        conn.execute(
            "UPDATE runs SET completed_at=?, notes=? WHERE id=?",
            (
                utc_now_iso(),
                json.dumps(
                    {
                        "bookmarks": len(bookmarks),
                        "emerging_candidates": discovered,
                        "auto_promoted": promoted,
                        "pending_candidates": pending,
                    },
                    separators=(",", ":"),
                ),
                run_id,
            ),
        )
        conn.commit()

        top_symbols = conn.execute(
            "SELECT symbol, source_count, status FROM symbols ORDER BY source_count DESC, symbol LIMIT 20"
        ).fetchall()
        theses = conn.execute(
            "SELECT id, name, status, confidence FROM theses ORDER BY confidence DESC, id"
        ).fetchall()
        return {
            "bookmarks": len(bookmarks),
            "market_related": market_count,
            "database": "supabase",
            "emerging_candidates": discovered,
            "auto_promoted": promoted,
            "pending_candidates": pending,
            "top_symbols": top_symbols,
            "theses": theses,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--bookmarks",
        required=True,
        help="Bookmark JSON input path, or '-' to read the X response from stdin without a local file.",
    )
    args = parser.parse_args()
    payload = json.load(sys.stdin) if args.bookmarks == "-" else json.loads(Path(args.bookmarks).read_text())
    print(json.dumps(ingest(payload), indent=2))


if __name__ == "__main__":
    main()
