"""Refresh the ontology graph from database-backed adaptive knowledge."""

from __future__ import annotations

import json

from thesisforge import db as database
from thesisforge.ontology.graph import upsert_edge, upsert_node
from thesisforge.ontology.learning import OntologyLearner, Theme, ThemeMatch


def theme_node_id(theme: Theme) -> str:
    return f"concept:{theme.id}" if theme.kind == "concept" else f"theme:{theme.id}"


def link_matches(conn, source_id: str, matches: list[ThemeMatch], *, context: dict) -> None:
    for match in matches:
        upsert_edge(
            conn,
            source_id,
            theme_node_id(match.theme),
            "classified_as",
            weight=max(1.0, match.score / 20),
            props={
                **context,
                "score": match.score,
                "matched_terms": match.matched_terms,
                "matched_symbols": match.matched_symbols,
            },
        )


def main() -> None:
    conn = database.connect()
    try:
        learner = OntologyLearner(conn)
        learner.sync_theme_theses()
        promoted = learner.promote_ready_candidates()

        # Reconcile ontology-owned graph edges without requiring DELETE access.
        # Active edges below overwrite these tombstones during the same run.
        conn.execute(
            """UPDATE graph_edges SET weight=0, evidence_count=0,
                     properties_json='{"stale":true}'::jsonb, updated_at=now()
               WHERE edge_type='classified_as'
                  OR edge_type='expressed_as'
                  OR properties_json->>'annotation_provenance'='research_document'
                  OR (
                    edge_type IN ('member','beneficiary','supplier','customer','competitor','proxy')
                    AND (starts_with(src_id, 'theme:') OR starts_with(src_id, 'concept:'))
                    AND starts_with(dst_id, 'symbol:')
                  )"""
        )

        for theme in learner.catalog.themes.values():
            node_id = theme_node_id(theme)
            upsert_node(
                conn,
                node_id,
                "concept" if theme.kind == "concept" else "theme",
                theme.name,
                {
                    "description": theme.description,
                    "thesis_id": theme.thesis_id,
                    "match_threshold": theme.match_threshold,
                },
            )
            if theme.thesis_id:
                thesis = conn.execute(
                    "SELECT name, status, confidence, summary FROM theses WHERE id=?",
                    (theme.thesis_id,),
                ).fetchone()
                if thesis:
                    thesis_node = f"thesis:{theme.thesis_id}"
                    upsert_node(
                        conn,
                        thesis_node,
                        "thesis",
                        thesis["name"],
                        {
                            "status": thesis["status"],
                            "confidence": thesis["confidence"],
                            "summary": thesis["summary"],
                        },
                    )
                    upsert_edge(conn, node_id, thesis_node, "expressed_as", weight=2.0)

        for row in conn.execute("SELECT symbol, status FROM symbols"):
            upsert_node(conn, f"symbol:{row['symbol']}", "symbol", row["symbol"], {"status": row["status"]})

        for row in conn.execute(
            """SELECT m.symbol, m.theme_id, m.relationship, m.confidence, m.evidence_count,
                      m.source_count, t.kind, t.name, t.description, t.thesis_id,
                      t.match_threshold, t.auto_promote_sources
               FROM symbol_theme_memberships m
               JOIN ontology_themes t ON t.id=m.theme_id
               JOIN symbols s ON s.symbol=m.symbol
               WHERE m.status='active' AND t.status='active' AND s.status<>'blacklisted'"""
        ):
            theme = Theme(
                id=row["theme_id"],
                thesis_id=row["thesis_id"],
                kind=row["kind"],
                name=row["name"],
                description=row["description"],
                match_threshold=row["match_threshold"],
                auto_promote_sources=row["auto_promote_sources"],
            )
            upsert_edge(
                conn,
                theme_node_id(theme),
                f"symbol:{row['symbol']}",
                row["relationship"],
                weight=max(1.0, row["confidence"] / 25),
                props={"confidence": row["confidence"], "source_count": row["source_count"]},
            )

        for row in conn.execute(
            "SELECT id, text, created_at, market_score FROM bookmarks WHERE is_market_related=TRUE"
        ):
            source_id = f"source:x_bookmark:{row['id']}"
            upsert_node(
                conn,
                source_id,
                "source",
                f"X bookmark {row['id']}",
                {"created_at": row["created_at"], "market_score": row["market_score"]},
            )
            symbols = learner.catalog.extract_symbols(row["text"] or "")
            matches = learner.catalog.classify(row["text"] or "", symbols)
            learner.record_source(
                source_type="bookmark",
                source_key=row["id"],
                text=row["text"] or "",
                symbols=symbols,
                matches=matches,
                observed_at=str(row["created_at"]),
            )
            link_matches(conn, source_id, matches, context={"snippet": (row["text"] or "")[:240]})

        for row in conn.execute(
            """SELECT a.id, a.title, a.url, a.text, a.fetched_at,
                      d.id AS document_id, d.storage_bucket, d.storage_path, d.sha256
               FROM articles a
               LEFT JOIN research_document_sources ds ON ds.article_id=a.id
               LEFT JOIN research_documents d ON d.id=ds.document_id
               WHERE a.text IS NOT NULL"""
        ):
            source_id = f"source:article:{row['id']}"
            upsert_node(
                conn,
                source_id,
                "source",
                row["title"] or row["url"],
                {
                    "url": row["url"],
                    "document_id": row["document_id"],
                    "storage_bucket": row["storage_bucket"],
                    "storage_path": row["storage_path"],
                    "sha256": row["sha256"],
                },
            )
            symbols = learner.catalog.extract_symbols(row["text"] or "")
            matches = learner.catalog.classify(row["text"] or "", symbols)
            learner.record_source(
                source_type="article",
                source_key=str(row["id"]),
                text=row["text"] or "",
                symbols=symbols,
                matches=matches,
                observed_at=str(row["fetched_at"]),
            )
            link_matches(conn, source_id, matches, context={"url": row["url"]})

        # Standalone PDFs, filings, transcripts, and other archived research are
        # first-class ontology sources. Article-linked documents stay under the
        # existing article source key so one original cannot inflate evidence.
        for row in conn.execute(
            """SELECT d.id, d.extracted_text, d.captured_at, d.storage_bucket,
                      d.storage_path, d.sha256,
                      coalesce(
                        (SELECT s.title FROM research_document_sources s
                         WHERE s.document_id=d.id ORDER BY s.id LIMIT 1),
                        d.storage_path
                      ) AS title,
                      (SELECT s.source_url FROM research_document_sources s
                       WHERE s.document_id=d.id ORDER BY s.id LIMIT 1) AS source_url
               FROM research_documents d
               WHERE NOT EXISTS (
                   SELECT 1 FROM research_document_sources s
                   WHERE s.document_id=d.id AND s.article_id IS NOT NULL
                 )"""
        ):
            source_id = f"source:document:{row['id']}"
            upsert_node(
                conn,
                source_id,
                "source",
                row["title"],
                {
                    "url": row["source_url"],
                    "storage_bucket": row["storage_bucket"],
                    "storage_path": row["storage_path"],
                    "sha256": row["sha256"],
                },
            )
            if row["extracted_text"]:
                symbols = learner.catalog.extract_symbols(row["extracted_text"])
                matches = learner.catalog.classify(row["extracted_text"], symbols)
                learner.record_source(
                    source_type="document",
                    source_key=str(row["id"]),
                    text=row["extracted_text"],
                    symbols=symbols,
                    matches=matches,
                    observed_at=str(row["captured_at"]),
                )
                link_matches(
                    conn,
                    source_id,
                    matches,
                    context={"url": row["source_url"], "sha256": row["sha256"]},
                )

        for row in conn.execute(
            """SELECT a.document_id, a.entity_type, a.entity_key, a.relevance,
                      a.sentiment, a.sentiment_score, a.confidence,
                      a.evidence_role, a.rationale
               FROM research_document_annotations a"""
        ):
            source_id = f"source:document:{row['document_id']}"
            if not conn.execute("SELECT 1 FROM graph_nodes WHERE id=?", (source_id,)).fetchone():
                # An article-linked original uses the article node instead.
                article = conn.execute(
                    "SELECT article_id FROM research_document_sources WHERE document_id=? AND article_id IS NOT NULL LIMIT 1",
                    (row["document_id"],),
                ).fetchone()
                if not article:
                    continue
                source_id = f"source:article:{article['article_id']}"

            entity_type = row["entity_type"]
            entity_key = row["entity_key"]
            if entity_type == "symbol":
                target_id = f"symbol:{entity_key.upper()}"
                upsert_node(conn, target_id, "symbol", entity_key.upper(), {"annotation_only": True})
            elif entity_type == "theme":
                theme = learner.catalog.themes.get(entity_key)
                target_id = theme_node_id(theme) if theme else f"theme:{entity_key}"
                if not conn.execute("SELECT 1 FROM graph_nodes WHERE id=?", (target_id,)).fetchone():
                    upsert_node(conn, target_id, "theme", entity_key, {"annotation_only": True})
            elif entity_type == "thesis":
                target_id = f"thesis:{entity_key}"
                if not conn.execute("SELECT 1 FROM graph_nodes WHERE id=?", (target_id,)).fetchone():
                    upsert_node(conn, target_id, "thesis", entity_key, {"annotation_only": True})
            else:
                target_id = "concept:market"
                upsert_node(conn, target_id, "concept", "Market", {})
            relation = {
                "supports": "supports",
                "contradicts": "contradicts",
                "context": "context_for",
                "unknown": "annotates",
            }[row["evidence_role"]]
            upsert_edge(
                conn,
                source_id,
                target_id,
                relation,
                weight=max(1.0, row["confidence"] / 25),
                props={
                    "relevance": row["relevance"],
                    "sentiment": row["sentiment"],
                    "sentiment_score": row["sentiment_score"],
                    "confidence": row["confidence"],
                    "rationale": row["rationale"],
                    "annotation_provenance": "research_document",
                },
            )

        for row in conn.execute(
            "SELECT id, label, event_date, status, summary, updated_at FROM research_events"
        ):
            event_id = f"event:{row['id']}"
            upsert_node(
                conn,
                event_id,
                "event",
                row["label"],
                {"event_date": row["event_date"], "status": row["status"]},
            )
            symbols = learner.catalog.extract_symbols(row["summary"] or "")
            matches = learner.catalog.classify(f"{row['label']} {row['summary']}", symbols)
            learner.record_source(
                source_type="research_event",
                source_key=str(row["id"]),
                text=f"{row['label']} {row['summary']}",
                symbols=symbols,
                matches=matches,
                observed_at=str(row["updated_at"]),
            )
            link_matches(conn, event_id, matches, context={"event_date": row["event_date"]})

        for row in conn.execute("SELECT id, symbol, thesis_id, status, rationale FROM trade_proposals"):
            trade_id = f"trade_proposal:{row['id']}"
            upsert_node(
                conn,
                trade_id,
                "trade",
                f"{row['status']} {row['symbol']}",
                {"status": row["status"], "rationale": row["rationale"]},
            )
            if row["thesis_id"]:
                upsert_edge(conn, f"thesis:{row['thesis_id']}", trade_id, "proposes", weight=3.0)
            upsert_edge(conn, trade_id, f"symbol:{row['symbol']}", "targets", weight=3.0)

        learner.recalculate_candidate_stats()
        discovered = learner.discover_emerging_themes()
        promoted += learner.promote_ready_candidates()
        conn.commit()
        result = conn.execute(
            """SELECT
                 (SELECT COUNT(*) FROM graph_nodes) AS nodes,
                 (SELECT COUNT(*) FROM graph_edges) AS edges,
                 (SELECT COUNT(*) FROM ontology_themes WHERE status='active') AS active_themes,
                 (SELECT COUNT(*) FROM ontology_candidates c
                  WHERE status='pending' AND source_count >= 2
                    AND (
                      (candidate_type='membership' AND EXISTS (
                        SELECT 1 FROM symbols s WHERE s.symbol=c.proposed_label
                          AND s.status IN ('known', 'verified', 'active', 'public_comp')
                      ))
                      OR (candidate_type='term' AND lower(proposed_label)
                          !~ '(^| )(http|https|www|t[.]co)( |$)')
                      OR (candidate_type='theme' AND (
                        position(' ' in proposed_label) > 0
                        OR sample_context->>'feature_type'='hashtag'
                      ))
                    )) AS pending_candidates"""
        ).fetchone()
        print(json.dumps({**dict(result), "auto_promoted": promoted, "emerging_candidates": discovered}, indent=2))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
