#!/usr/bin/env python3
"""Capture structured ThesisForge research judgments from the command line."""
from __future__ import annotations

import argparse
import re

from thesisforge import db as database
from thesisforge.clock import utc_now_iso

def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    view = commands.add_parser("thesis-view", help="Set stance, variant perception, and falsifier")
    view.add_argument("thesis_id")
    view.add_argument("--stance", required=True, choices=["bullish", "bearish", "neutral"])
    view.add_argument("--variant", required=True)
    view.add_argument("--falsifier", required=True)

    prediction = commands.add_parser("prediction", help="Add or update a falsifiable prediction")
    prediction.add_argument("thesis_id")
    prediction.add_argument("statement")
    prediction.add_argument("--key")
    prediction.add_argument("--target-date")
    prediction.add_argument("--probability", type=int, default=50, choices=range(0, 101), metavar="0..100")

    insight = commands.add_parser("insight", help="Add or update a derived insight")
    insight.add_argument("title")
    insight.add_argument("summary")
    insight.add_argument("--slug")
    insight.add_argument("--type", default="derived", choices=["derived", "contrarian", "connection", "risk"])
    insight.add_argument("--novelty", type=int, default=50, choices=range(0, 101), metavar="0..100")
    insight.add_argument("--confidence", type=int, default=50, choices=range(0, 101), metavar="0..100")
    insight.add_argument("--node", action="append", default=[], help="Graph node id to connect; repeatable")

    relation = commands.add_parser("relation", help="Connect two theses")
    relation.add_argument("src_thesis_id")
    relation.add_argument("dst_thesis_id")
    relation.add_argument("relation_type")
    relation.add_argument("rationale")
    relation.add_argument("--strength", type=float, default=0.5)

    decision = commands.add_parser("event-decision", help="Record participate/watch/skip rationale")
    decision.add_argument("event_id", type=int)
    decision.add_argument("decision", choices=["participate", "watch", "skip"])
    decision.add_argument("rationale")
    decision.add_argument("--trigger")

    cycle = commands.add_parser("cycle", help="Preregister a closed-loop research cycle")
    cycle.add_argument("thesis_id")
    cycle.add_argument("hypothesis")
    cycle.add_argument("expected_outcome")
    cycle.add_argument("--key")
    cycle.add_argument("--regime")

    lesson = commands.add_parser("lesson", help="Persist a negative result or regime lesson")
    lesson.add_argument("cycle_key")
    lesson.add_argument("thesis_id")
    lesson.add_argument("summary")
    lesson.add_argument("--test-key")
    lesson.add_argument("--type", default="negative_result", choices=["negative_result", "regime_dependency", "factor_concentration", "behavioral_pattern"])
    lesson.add_argument("--regime")
    lesson.add_argument("--incorporated", action="store_true")

    args = parser.parse_args()
    ts = utc_now_iso()
    conn = database.connect()

    if args.command == "thesis-view":
        result = conn.execute(
            "UPDATE theses SET stance=?, variant_perception=?, falsifier=?, updated_at=? WHERE id=?",
            (args.stance, args.variant, args.falsifier, ts, args.thesis_id),
        )
        if not result.rowcount:
            parser.error(f"Unknown thesis id: {args.thesis_id}")
    elif args.command == "prediction":
        key = args.key or slugify(f"{args.thesis_id}-{args.statement}")[:90]
        conn.execute(
            """
            INSERT INTO predictions(external_key, thesis_id, statement, target_date, probability, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(external_key) DO UPDATE SET statement=excluded.statement, target_date=excluded.target_date,
              probability=excluded.probability, updated_at=excluded.updated_at
            """,
            (key, args.thesis_id, args.statement, args.target_date, args.probability, ts, ts),
        )
    elif args.command == "insight":
        slug = args.slug or slugify(args.title)
        conn.execute(
            """
            INSERT INTO insights(slug, title, summary, insight_type, novelty, confidence, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(slug) DO UPDATE SET title=excluded.title, summary=excluded.summary,
              insight_type=excluded.insight_type, novelty=excluded.novelty,
              confidence=excluded.confidence, updated_at=excluded.updated_at
            """,
            (slug, args.title, args.summary, args.type, args.novelty, args.confidence, ts, ts),
        )
        insight_id = conn.execute("SELECT id FROM insights WHERE slug=?", (slug,)).fetchone()[0]
        for node_id in args.node:
            conn.execute(
                """INSERT INTO insight_links(insight_id, node_id, relationship)
                   VALUES (?, ?, 'connects')
                   ON CONFLICT(insight_id, node_id, relationship) DO NOTHING""",
                (insight_id, node_id),
            )
    elif args.command == "relation":
        conn.execute(
            """
            INSERT INTO thesis_relations(src_thesis_id, dst_thesis_id, relation_type, strength, rationale, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(src_thesis_id, dst_thesis_id, relation_type) DO UPDATE SET
              strength=excluded.strength, rationale=excluded.rationale, updated_at=excluded.updated_at
            """,
            (args.src_thesis_id, args.dst_thesis_id, args.relation_type, args.strength, args.rationale, ts, ts),
        )
    elif args.command == "event-decision":
        conn.execute(
            """
            INSERT INTO event_decisions(event_id, decision, rationale, participation_trigger, decided_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET decision=excluded.decision, rationale=excluded.rationale,
              participation_trigger=excluded.participation_trigger, decided_at=excluded.decided_at,
              updated_at=excluded.updated_at
            """,
            (args.event_id, args.decision, args.rationale, args.trigger, ts, ts),
        )
    elif args.command == "cycle":
        key = args.key or slugify(f"cycle-{args.thesis_id}-{args.hypothesis}")[:90]
        conn.execute(
            """
            INSERT INTO research_cycles(external_key, thesis_id, hypothesis, preregistered_outcome,
              preregistered_at, stage, status, iteration, market_regime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'research', 'open', 1, ?, ?, ?)
            ON CONFLICT(external_key) DO UPDATE SET hypothesis=excluded.hypothesis,
              preregistered_outcome=excluded.preregistered_outcome, market_regime=excluded.market_regime,
              updated_at=excluded.updated_at
            """,
            (key, args.thesis_id, args.hypothesis, args.expected_outcome, ts, args.regime, ts, ts),
        )
    elif args.command == "lesson":
        cycle_row = conn.execute("SELECT id FROM research_cycles WHERE external_key=?", (args.cycle_key,)).fetchone()
        if not cycle_row:
            parser.error(f"Unknown cycle key: {args.cycle_key}")
        test_id = None
        if args.test_key:
            test_row = conn.execute("SELECT id FROM strategy_tests WHERE external_key=?", (args.test_key,)).fetchone()
            if not test_row:
                parser.error(f"Unknown test key: {args.test_key}")
            test_id = test_row[0]
        conn.execute(
            "INSERT INTO research_lessons(cycle_id, test_id, thesis_id, lesson_type, summary, market_regime, incorporated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (cycle_row[0], test_id, args.thesis_id, args.type, args.summary, args.regime, args.incorporated, ts),
        )

    conn.commit()
    conn.close()
    print(f"Captured {args.command} at {ts}")


if __name__ == "__main__":
    main()
