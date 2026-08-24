"""Print the ThesisForge ontology report."""

from __future__ import annotations

from thesisforge import db as database


def main() -> None:
    conn = database.connect()
    try:
        print("# ThesisForge Ontology\n")
        print("## Adaptive Catalog")
        for row in conn.execute(
            """SELECT t.id, t.kind, t.name, t.status, COUNT(DISTINCT ot.id) AS terms,
                      COUNT(DISTINCT m.symbol) AS symbols
               FROM ontology_themes t
               LEFT JOIN ontology_terms ot ON ot.theme_id=t.id AND ot.status='active'
               LEFT JOIN symbol_theme_memberships m ON m.theme_id=t.id AND m.status='active'
               GROUP BY t.id, t.kind, t.name, t.status
               ORDER BY t.status, t.kind, t.name"""
        ):
            print(f"- {row['name']} [{row['kind']}/{row['status']}]: {row['terms']} terms, {row['symbols']} symbols")
        print("\n## Learning Candidates")
        for row in conn.execute(
            """SELECT id, candidate_type, proposed_label, proposed_theme_id, score, source_count
               FROM ontology_candidates c
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
                 )
               ORDER BY source_count DESC, score DESC LIMIT 20"""
        ):
            target = f" -> {row['proposed_theme_id']}" if row["proposed_theme_id"] else ""
            print(f"- #{row['id']} {row['candidate_type']} {row['proposed_label']}{target} [{row['score']}, {row['source_count']} sources]")
        print()
        print("## Conviction Map")
        for row in conn.execute("SELECT name, stance, status, confidence, variant_perception FROM theses ORDER BY confidence DESC, name"):
            print(f"- {row['name']} [{row['stance']}/{row['status']}, {row['confidence']}]: {row['variant_perception'] or 'No variant view captured'}")
        print("\n## Predictions")
        for row in conn.execute("""
            SELECT p.target_date, p.probability, p.status, p.statement, t.name AS thesis
            FROM predictions p JOIN theses t ON t.id=p.thesis_id
            ORDER BY COALESCE(p.target_date, '9999-12-31'), p.probability DESC
        """):
            print(f"- {row['target_date'] or 'TBD'} {row['probability']}% [{row['status']}] {row['thesis']}: {row['statement']}")
        print("\n## New Insights")
        for row in conn.execute("SELECT insight_type, title, novelty, confidence, summary FROM insights WHERE status='active' ORDER BY novelty DESC"):
            print(f"- {row['title']} [{row['insight_type']}, novelty {row['novelty']}, confidence {row['confidence']}]: {row['summary']}")
        print("\n## Thesis Connections")
        for row in conn.execute("""
            SELECT s.name AS src, r.relation_type, d.name AS dst, r.strength, r.rationale
            FROM thesis_relations r JOIN theses s ON s.id=r.src_thesis_id JOIN theses d ON d.id=r.dst_thesis_id
            ORDER BY r.strength DESC
        """):
            print(f"- {row['src']} --{row['relation_type']}({row['strength']:.2f})--> {row['dst']}: {row['rationale']}")
        print("\n## Closed-Loop Research")
        for row in conn.execute("""
            SELECT c.external_key, c.stage, c.status, c.iteration, t.name, c.hypothesis, c.preregistered_outcome
            FROM research_cycles c JOIN theses t ON t.id=c.thesis_id ORDER BY c.id
        """):
            print(f"- {row['external_key']} [{row['stage']}/{row['status']} rev {row['iteration']}] {row['name']}: {row['hypothesis']} Expected: {row['preregistered_outcome']}")
        print("\n## Persistent Lessons")
        for row in conn.execute("SELECT lesson_type, thesis_id, market_regime, incorporated, summary FROM research_lessons ORDER BY incorporated, id"):
            state = "incorporated" if row["incorporated"] else "open_loop"
            print(f"- {row['thesis_id']} [{row['lesson_type']}/{row['market_regime'] or 'any'}/{state}]: {row['summary']}")
        print("\n## Thickest Links")
        for row in conn.execute("""
            SELECT s.label AS src, e.edge_type, d.label AS dst, e.weight, e.evidence_count
            FROM graph_edges e
            JOIN graph_nodes s ON s.id = e.src_id
            JOIN graph_nodes d ON d.id = e.dst_id
            ORDER BY e.weight DESC, e.evidence_count DESC
            LIMIT 20
        """):
            print(f"- {row['src']} --{row['edge_type']}({row['weight']:.1f}/{row['evidence_count']})--> {row['dst']}")
        print("\n## Open Research Queue")
        for row in conn.execute("SELECT priority, topic, reason FROM research_queue WHERE status='open' ORDER BY priority DESC, id DESC LIMIT 10"):
            print(f"- P{row['priority']} {row['topic']}: {row['reason']}")
        print("\n## Events")
        for row in conn.execute("""
            SELECT e.event_type, e.label, e.event_date, e.status, e.summary,
                   COALESCE(d.decision, 'watch') AS decision, d.rationale
            FROM research_events e LEFT JOIN event_decisions d ON d.event_id=e.id
            ORDER BY e.id DESC LIMIT 10
        """):
            print(f"- {row['event_date'] or 'TBD'} {row['label']} [{row['event_type']}/{row['status']}; decision={row['decision']}]: {row['summary']} Why: {row['rationale'] or 'not captured'}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
