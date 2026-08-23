#!/usr/bin/env python3
"""Export the local ThesisForge database into the webapp's portable snapshot."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "thesisforge.sqlite"
OUTPUT = ROOT / "web" / "data" / "ontology-snapshot.json"


def rows(conn: sqlite3.Connection, query: str, params=()) -> list[dict]:
    return [dict(row) for row in conn.execute(query, params)]


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    theses = rows(conn, """
        SELECT t.id, t.name, t.summary, t.status, t.confidence, t.time_horizon, t.stance,
               t.variant_perception, t.falsifier,
               COALESCE((SELECT json_group_array(symbol) FROM
                 (SELECT symbol FROM thesis_symbols ts WHERE ts.thesis_id=t.id ORDER BY weight_hint DESC LIMIT 8)), '[]') AS symbols_json
        FROM theses t ORDER BY t.confidence DESC, t.name
    """)
    for thesis in theses:
        thesis["symbols"] = json.loads(thesis.pop("symbols_json"))

    payload = {
        "generated_at": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "theses": theses,
        "predictions": rows(conn, "SELECT id, external_key, thesis_id, statement, target_date, probability, status, resolution_notes FROM predictions ORDER BY target_date, probability DESC"),
        "insights": rows(conn, """
            SELECT i.id, i.slug, i.title, i.summary, i.insight_type, i.novelty, i.confidence,
              COALESCE((SELECT json_group_array(node_id) FROM insight_links il WHERE il.insight_id=i.id), '[]') AS links_json
            FROM insights i WHERE i.status='active' ORDER BY i.novelty DESC, i.confidence DESC
        """),
        "relations": rows(conn, "SELECT src_thesis_id, dst_thesis_id, relation_type, strength, rationale FROM thesis_relations ORDER BY strength DESC"),
        "events": rows(conn, """
            SELECT e.id, e.event_type, e.label, e.event_date, e.status, e.source_url, e.summary,
                   COALESCE(d.decision, 'watch') AS decision, d.rationale, d.participation_trigger
            FROM research_events e LEFT JOIN event_decisions d ON d.event_id=e.id
            ORDER BY COALESCE(e.event_date, '9999-12-31'), e.id
        """),
        "cycles": rows(conn, """
            SELECT c.id, c.external_key, c.thesis_id, t.name AS thesis_name, c.hypothesis,
                   c.preregistered_outcome, c.preregistered_at, c.stage, c.status,
                   c.iteration, c.market_regime
            FROM research_cycles c JOIN theses t ON t.id=c.thesis_id
            ORDER BY CASE c.stage WHEN 'live' THEN 1 WHEN 'backtest' THEN 2 WHEN 'research' THEN 3
              WHEN 'postmortem' THEN 4 ELSE 5 END, c.updated_at DESC
        """),
        "tests": rows(conn, """
            SELECT s.id, s.external_key, s.cycle_id, c.external_key AS cycle_key, c.thesis_id,
                   s.variant_label, s.status, s.total_return, s.max_drawdown, s.deflated_sharpe,
                   s.cost_multiplier, s.stress_regime, s.failure_reason, s.autopsy, s.tested_at
            FROM strategy_tests s JOIN research_cycles c ON c.id=s.cycle_id
            ORDER BY s.tested_at DESC, s.id DESC
        """),
        "test_scenarios": rows(conn, """
            SELECT x.id, x.test_id, s.external_key AS test_key, x.scenario_key, x.market_regime,
                   x.cost_multiplier, x.outcome, x.metric_value, x.breach_type
            FROM test_scenarios x JOIN strategy_tests s ON s.id=x.test_id
            ORDER BY x.test_id, x.id
        """),
        "agent_runs": rows(conn, """
            SELECT a.id, a.cycle_id, c.external_key AS cycle_key, a.agent_role,
                   a.independence_group, a.price_blinded, a.status, a.summary, a.created_at
            FROM agent_runs a JOIN research_cycles c ON c.id=a.cycle_id
            ORDER BY a.id DESC
        """),
        "lessons": rows(conn, """
            SELECT l.id, l.cycle_id, l.test_id, l.thesis_id, l.lesson_type, l.summary,
                   l.market_regime, l.incorporated, l.created_at
            FROM research_lessons l ORDER BY l.incorporated ASC, l.id DESC
        """),
        "risk_controls": rows(conn, "SELECT id, control_key, scope, control_type, threshold_json, enforcement_level, status, updated_at FROM risk_controls ORDER BY scope, control_key"),
        "trade_proposals": rows(conn, "SELECT id, thesis_id, symbol, side, notional, order_type, status, rationale, created_at, reviewed_at, broker_alerts FROM trade_proposals ORDER BY created_at DESC, id DESC"),
        "graph": {
            "nodes": rows(conn, "SELECT id, node_type, label, properties_json FROM graph_nodes WHERE node_type IN ('thesis','concept','symbol','event') ORDER BY node_type, label"),
            "edges": rows(conn, "SELECT src_id, dst_id, edge_type, weight, evidence_count FROM graph_edges WHERE weight >= 1.5 ORDER BY weight DESC LIMIT 120"),
        },
        "financial_data": {
            "network_requests": conn.execute("SELECT COUNT(*) FROM financial_api_requests").fetchone()[0] if table_exists(conn, "financial_api_requests") else 0,
            "cache_hits": conn.execute("SELECT COUNT(*) FROM financial_access_log WHERE access_type='cache'").fetchone()[0] if table_exists(conn, "financial_access_log") else 0,
            "records": conn.execute("SELECT COUNT(*) FROM financial_records").fetchone()[0] if table_exists(conn, "financial_records") else 0,
            "tickers": conn.execute("SELECT COUNT(DISTINCT ticker) FROM financial_records WHERE ticker IS NOT NULL").fetchone()[0] if table_exists(conn, "financial_records") else 0,
            "datasets": conn.execute("SELECT COUNT(DISTINCT dataset) FROM financial_records").fetchone()[0] if table_exists(conn, "financial_records") else 0,
        },
        "counts": {
            "sources": conn.execute("SELECT COUNT(*) FROM graph_nodes WHERE node_type='source'").fetchone()[0],
            "symbols": conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0],
            "open_research": conn.execute("SELECT COUNT(*) FROM research_queue WHERE status='open'").fetchone()[0],
            "tests_killed": conn.execute("SELECT COUNT(*) FROM strategy_tests WHERE status='killed'").fetchone()[0],
            "tests_survived": conn.execute("SELECT COUNT(*) FROM strategy_tests WHERE status='survived'").fetchone()[0],
            "scenario_cells": conn.execute("SELECT COUNT(*) FROM test_scenarios").fetchone()[0],
        },
    }
    for insight in payload["insights"]:
        insight["links"] = json.loads(insight.pop("links_json"))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    conn.close()
    print(f"Exported {len(theses)} theses to {args.output}")


if __name__ == "__main__":
    main()
