#!/usr/bin/env python3
"""Publish the current ThesisForge dashboard snapshot to Supabase."""
from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal

from thesisforge import db as database
from thesisforge.clock import utc_now_iso

def rows(conn, query: str, params=()) -> list[dict]:
    return [dict(row) for row in conn.execute(query, params)]


def json_default(value):
    """Normalize native Postgres values for the dashboard JSON payload."""
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def run_reports(conn) -> list[dict]:
    reports = rows(conn, "SELECT id, run_type, started_at, completed_at, notes FROM runs ORDER BY started_at DESC, id DESC LIMIT 24")
    for report in reports:
        notes = report.pop("notes") or ""
        try:
            detail = json.loads(notes)
        except (TypeError, json.JSONDecodeError):
            detail = {"headline": report["run_type"].replace("_", " ").title(), "summary": notes}
        report.update({
            "status": detail.get("status", "complete" if report["completed_at"] else "running"),
            "headline": detail.get("headline", report["run_type"].replace("_", " ").title()),
            "summary": detail.get("summary", notes),
            "insights": detail.get("insights", []),
            "learnings": detail.get("learnings", []),
            "actions": detail.get("actions", []),
            "metrics": detail.get("metrics", {}),
        })
    return reports


def main() -> None:
    conn = database.connect()
    theses = rows(conn, """
        SELECT t.id, t.name, t.summary, t.status, t.confidence, t.time_horizon, t.stance,
               t.variant_perception, t.falsifier,
               COALESCE((SELECT json_agg(symbol) FROM
                 (SELECT symbol FROM thesis_symbols ts WHERE ts.thesis_id=t.id ORDER BY weight_hint DESC, symbol LIMIT 8)), '[]') AS symbols_json
        FROM theses t ORDER BY t.confidence DESC, t.name
    """)
    for thesis in theses:
        symbols = thesis.pop("symbols_json")
        thesis["symbols"] = json.loads(symbols) if isinstance(symbols, str) else symbols

    payload = {
        "generated_at": utc_now_iso(),
        "run_reports": run_reports(conn),
        "automations": rows(conn, """
            SELECT a.id, a.name, a.prompt, a.kind, a.status, a.rrule, a.model,
                   a.reasoning_effort, a.next_run_at, a.last_run_at, a.indexed_at,
                   COUNT(r.thread_id) AS run_count,
                   COUNT(r.thread_id) FILTER (WHERE r.outcome='passed') AS passed_count,
                   COUNT(r.thread_id) FILTER (WHERE r.outcome='failed') AS failed_count
            FROM codex_automations a
            LEFT JOIN codex_automation_runs r ON r.automation_id=a.id
            GROUP BY a.id
            ORDER BY CASE a.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, a.next_run_at, a.name
        """),
        "automation_runs": rows(conn, """
            SELECT r.thread_id, r.automation_id, a.name AS automation_name,
                   r.status, r.outcome, r.started_at, r.completed_at, r.duration_ms,
                   r.title, r.summary, r.final_output, r.findings, r.learnings,
                   r.explored, r.actions, r.timeline, r.error_text, r.tokens_used
            FROM codex_automation_runs r
            JOIN codex_automations a ON a.id=r.automation_id
            ORDER BY r.started_at DESC
            LIMIT 200
        """),
        "theses": theses,
        "predictions": rows(conn, "SELECT id, external_key, thesis_id, statement, target_date, probability, status, resolution_notes FROM predictions ORDER BY target_date, probability DESC"),
        "insights": rows(conn, """
            SELECT i.id, i.slug, i.title, i.summary, i.insight_type, i.novelty, i.confidence,
              COALESCE((SELECT json_agg(node_id) FROM
                (SELECT node_id FROM insight_links il WHERE il.insight_id=i.id ORDER BY node_id)), '[]') AS links_json
            FROM insights i WHERE i.status='active' ORDER BY i.novelty DESC, i.confidence DESC
        """),
        "relations": rows(conn, "SELECT src_thesis_id, dst_thesis_id, relation_type, strength, rationale FROM thesis_relations ORDER BY strength DESC"),
        "ontology_themes": rows(conn, """
            SELECT t.id, t.thesis_id, t.kind, t.name, t.description, t.status,
                   t.match_threshold, t.auto_promote_sources,
                   (SELECT COUNT(*) FROM ontology_terms x WHERE x.theme_id=t.id AND x.status='active') AS term_count,
                   (SELECT COUNT(*) FROM symbol_theme_memberships m WHERE m.theme_id=t.id AND m.status='active') AS symbol_count
            FROM ontology_themes t ORDER BY t.status, t.kind, t.name
        """),
        "ontology_candidates": rows(conn, """
            SELECT id, candidate_type, candidate_key, proposed_theme_id, proposed_label,
                   proposed_description, score, evidence_count, source_count, status,
                   first_seen_at, last_seen_at, review_note
            FROM ontology_candidates c
            WHERE source_count >= 2
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
            ORDER BY status, source_count DESC, score DESC LIMIT 100
        """),
        "ontology_symbols": rows(conn, """
            SELECT symbol, status, mention_count, source_count, first_seen_at, last_seen_at
            FROM symbols
            ORDER BY CASE status WHEN 'blacklisted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
                     source_count DESC, mention_count DESC, symbol
            LIMIT 300
        """),
        "ontology_actions": rows(conn, """
            SELECT id, actor_id, entity_type, entity_key, action, created_at
            FROM ontology_management_actions
            ORDER BY created_at DESC, id DESC
            LIMIT 100
        """),
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
        "risk_controls": rows(conn, "SELECT id, control_key, scope, control_type, threshold_json, enforcement_level, status, updated_at FROM risk_controls WHERE status='active' ORDER BY scope, control_key"),
        "account_state": (rows(conn, "SELECT observed_at, account_label, total_value, equity_value, cash, buying_power, source FROM account_snapshots ORDER BY observed_at DESC, id DESC LIMIT 1") or [None])[0],
        "trade_proposals": rows(conn, "SELECT id, thesis_id, symbol, side, notional, order_type, status, rationale, created_at, reviewed_at, broker_alerts FROM trade_proposals ORDER BY created_at DESC, id DESC"),
        "graph": {
            "nodes": rows(conn, "SELECT id, node_type, label, properties_json FROM graph_nodes WHERE node_type IN ('thesis','concept','symbol','event') ORDER BY node_type, label"),
            "edges": rows(conn, "SELECT src_id, dst_id, edge_type, weight, evidence_count FROM graph_edges WHERE weight >= 1.5 ORDER BY weight DESC LIMIT 120"),
        },
        "financial_data": {
            "network_requests": conn.execute("SELECT COUNT(*) FROM financial_api_requests").fetchone()[0],
            "cache_hits": conn.execute("SELECT COUNT(*) FROM financial_access_log WHERE access_type='cache'").fetchone()[0],
            "records": conn.execute("SELECT COUNT(*) FROM financial_records").fetchone()[0],
            "tickers": conn.execute("SELECT COUNT(DISTINCT ticker) FROM financial_records WHERE ticker IS NOT NULL").fetchone()[0],
            "datasets": conn.execute("SELECT COUNT(DISTINCT dataset) FROM financial_records").fetchone()[0],
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
        links = insight.pop("links_json")
        insight["links"] = json.loads(links) if isinstance(links, str) else links

    # Keep the dashboard wire format stable across Python and TypeScript.
    for run in payload["agent_runs"]:
        run["price_blinded"] = int(run["price_blinded"])
    for lesson in payload["lessons"]:
        lesson["incorporated"] = int(lesson["incorporated"])
    for control in payload["risk_controls"]:
        if not isinstance(control["threshold_json"], str):
            control["threshold_json"] = json.dumps(control["threshold_json"], separators=(",", ":"))
    for proposal in payload["trade_proposals"]:
        if proposal["broker_alerts"] is not None and not isinstance(proposal["broker_alerts"], str):
            proposal["broker_alerts"] = json.dumps(proposal["broker_alerts"], separators=(",", ":"))
    for node in payload["graph"]["nodes"]:
        if not isinstance(node["properties_json"], str):
            node["properties_json"] = json.dumps(node["properties_json"], separators=(",", ":"))

    # Normalize native dates and exact numerics before storing the JSONB record.
    payload = json.loads(json.dumps(payload, default=json_default))

    from psycopg.types.json import Jsonb
    conn.execute(
        """INSERT INTO dashboard_snapshots(id, generated_at, payload)
           VALUES ('current', ?, ?)
           ON CONFLICT(id) DO UPDATE SET generated_at=excluded.generated_at, payload=excluded.payload""",
        (payload["generated_at"], Jsonb(payload)),
    )
    conn.commit()
    conn.close()
    print(f"Published {len(theses)} theses to Supabase dashboard_snapshots")


if __name__ == "__main__":
    main()
