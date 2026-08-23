#!/usr/bin/env python3
"""Create and refresh a lightweight ThesisForge ontology graph in SQLite."""
from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "thesisforge.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(src_id, dst_id, edge_type),
  FOREIGN KEY (src_id) REFERENCES graph_nodes(id),
  FOREIGN KEY (dst_id) REFERENCES graph_nodes(id)
);

CREATE TABLE IF NOT EXISTS research_events (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  label TEXT NOT NULL,
  event_date TEXT,
  status TEXT NOT NULL DEFAULT 'watching',
  source_url TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_queue (
  id INTEGER PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'open',
  topic TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  thesis_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  target_date TEXT,
  probability INTEGER NOT NULL DEFAULT 50 CHECK(probability BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'open',
  resolution_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thesis_id) REFERENCES theses(id)
);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight_type TEXT NOT NULL DEFAULT 'derived',
  novelty INTEGER NOT NULL DEFAULT 50 CHECK(novelty BETWEEN 0 AND 100),
  confidence INTEGER NOT NULL DEFAULT 50 CHECK(confidence BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insight_links (
  insight_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'connects',
  PRIMARY KEY (insight_id, node_id, relationship),
  FOREIGN KEY (insight_id) REFERENCES insights(id),
  FOREIGN KEY (node_id) REFERENCES graph_nodes(id)
);

CREATE TABLE IF NOT EXISTS thesis_relations (
  src_thesis_id TEXT NOT NULL,
  dst_thesis_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (src_thesis_id, dst_thesis_id, relation_type),
  FOREIGN KEY (src_thesis_id) REFERENCES theses(id),
  FOREIGN KEY (dst_thesis_id) REFERENCES theses(id)
);

CREATE TABLE IF NOT EXISTS event_decisions (
  event_id INTEGER PRIMARY KEY,
  decision TEXT NOT NULL DEFAULT 'watch',
  rationale TEXT NOT NULL,
  participation_trigger TEXT,
  decided_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES research_events(id)
);

CREATE TABLE IF NOT EXISTS research_cycles (
  id INTEGER PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  thesis_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  preregistered_outcome TEXT NOT NULL,
  preregistered_at TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'research',
  status TEXT NOT NULL DEFAULT 'open',
  iteration INTEGER NOT NULL DEFAULT 1,
  market_regime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thesis_id) REFERENCES theses(id)
);

CREATE TABLE IF NOT EXISTS strategy_tests (
  id INTEGER PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  cycle_id INTEGER NOT NULL,
  variant_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total_return REAL,
  max_drawdown REAL,
  deflated_sharpe REAL,
  cost_multiplier REAL NOT NULL DEFAULT 1.0,
  stress_regime TEXT,
  failure_reason TEXT,
  autopsy TEXT,
  tested_at TEXT NOT NULL,
  FOREIGN KEY (cycle_id) REFERENCES research_cycles(id)
);

CREATE TABLE IF NOT EXISTS test_scenarios (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL,
  scenario_key TEXT NOT NULL,
  market_regime TEXT NOT NULL,
  cost_multiplier REAL NOT NULL,
  outcome TEXT NOT NULL,
  metric_value REAL,
  breach_type TEXT,
  tested_at TEXT NOT NULL,
  UNIQUE(test_id, scenario_key),
  FOREIGN KEY (test_id) REFERENCES strategy_tests(id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL,
  agent_role TEXT NOT NULL,
  independence_group TEXT,
  price_blinded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'complete',
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cycle_id) REFERENCES research_cycles(id)
);

CREATE TABLE IF NOT EXISTS research_lessons (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL,
  test_id INTEGER,
  thesis_id TEXT NOT NULL,
  lesson_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  market_regime TEXT,
  incorporated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cycle_id) REFERENCES research_cycles(id),
  FOREIGN KEY (test_id) REFERENCES strategy_tests(id),
  FOREIGN KEY (thesis_id) REFERENCES theses(id)
);

CREATE TABLE IF NOT EXISTS risk_controls (
  id INTEGER PRIMARY KEY,
  control_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  control_type TEXT NOT NULL,
  threshold_json TEXT NOT NULL,
  enforcement_level TEXT NOT NULL DEFAULT 'code',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_predictions_thesis_status ON predictions(thesis_id, status);
CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);
CREATE INDEX IF NOT EXISTS idx_event_decisions_decision ON event_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_research_cycles_stage ON research_cycles(stage, status);
CREATE INDEX IF NOT EXISTS idx_strategy_tests_cycle_status ON strategy_tests(cycle_id, status);
CREATE INDEX IF NOT EXISTS idx_test_scenarios_test_outcome ON test_scenarios(test_id, outcome);
CREATE INDEX IF NOT EXISTS idx_research_lessons_thesis ON research_lessons(thesis_id, incorporated);
"""

CONCEPTS = {
    "concept:ai_power": ["power", "electric", "grid", "energy", "data center", "datacenter", "10 gw", "831 mw"],
    "concept:nuclear": ["nuclear", "uranium", "reactor", "smr", "criticality", "fuel"],
    "concept:neocloud": ["neocloud", "gpu", "compute", "cloud", "nscale", "coreweave", "nebius", "iren"],
    "concept:photonics": ["photonics", "optical", "800g", "1.6t", "transceiver"],
    "concept:ipo_events": ["ipo", "listing", "public offering", "roadshow"],
    "concept:earnings_events": ["earnings", "quarter", "eps", "guidance"],
    "concept:crypto_ai": ["bittensor", "tao", "bitcoin", "crypto"],
}

PUBLIC_COMPS = {
    "concept:ai_power": ["VST", "CEG", "GEV", "AEP", "DTE", "FE", "CMS"],
    "concept:nuclear": ["OKLO", "XE", "LEU", "CEG", "CCJ", "SMR"],
    "concept:neocloud": ["NBIS", "IREN", "CRWV", "HUT", "CORZ"],
    "concept:photonics": ["AAOI", "COHR", "LITE", "AEHR"],
    "concept:crypto_ai": ["TAO-USD", "BTC-USD", "HOOD", "COIN"],
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def upsert_node(conn, node_id, node_type, label, props=None):
    ts = now_iso()
    conn.execute(
        """
        INSERT INTO graph_nodes(id, node_type, label, properties_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label=excluded.label,
          properties_json=excluded.properties_json,
          updated_at=excluded.updated_at
        """,
        (node_id, node_type, label, json.dumps(props or {}, sort_keys=True), ts, ts),
    )


def upsert_edge(conn, src, dst, edge_type, weight=1.0, props=None):
    ts = now_iso()
    conn.execute(
        """
        INSERT INTO graph_edges(src_id, dst_id, edge_type, weight, evidence_count, properties_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(src_id, dst_id, edge_type) DO UPDATE SET
          weight=excluded.weight,
          evidence_count=excluded.evidence_count,
          properties_json=excluded.properties_json,
          updated_at=excluded.updated_at
        """,
        (src, dst, edge_type, weight, json.dumps(props or {}, sort_keys=True), ts, ts),
    )


def ensure_column(conn, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def seed_research_views(conn: sqlite3.Connection, ts: str) -> None:
    thesis_views = {
        "ai_power_nuclear": ("bullish", "The market still underestimates how long grid, generation, and fuel constraints can persist.", "Utility capex or power prices fail to accelerate despite sustained compute demand."),
        "neocloud_compute": ("bullish", "Capacity scarcity can outweigh financing anxiety during confirmed demand bursts.", "Utilization, contracted backlog, or financing access deteriorates materially."),
        "semis_photonics": ("bullish", "Networking and optical suppliers may capture the second derivative of AI capex.", "800G/1.6T demand or supplier guidance rolls over across multiple quarters."),
        "defense_drones_space": ("bullish", "Procurement is shifting toward cheaper autonomous systems faster than consensus models imply.", "Contract conversion and production scale continue to lag narrative momentum."),
        "quantum": ("bearish", "Price action is running ahead of commercially measurable progress.", "Bookings and technical milestones begin compounding faster than dilution."),
        "biotech_royalty": ("neutral", "The payoff can be asymmetric, but the evidence is too specialized for broad basket exposure.", "A validated catalyst and independently checked royalty economics emerge."),
        "crypto": ("neutral", "Optionality is real, but conviction should stay separate from ideology and liquidity beta.", "Network usage grows independently of token price and risk appetite."),
        "software_ai_apps": ("bearish", "Private-market excitement is easier to identify than a clean, attractively priced public expression.", "A public proxy shows durable monetization with falling inference costs."),
    }
    for thesis_id, (stance, variant, falsifier) in thesis_views.items():
        conn.execute(
            "UPDATE theses SET stance=?, variant_perception=?, falsifier=? WHERE id=?",
            (stance, variant, falsifier, thesis_id),
        )

    predictions = [
        ("ai-power-relative-strength", "ai_power_nuclear", "AI power and grid beneficiaries outperform broad software AI proxies into the next capex-guidance cycle.", "2026-11-30", 68),
        ("neocloud-volatility-window", "neocloud_compute", "Neocloud public comps experience a material volatility expansion around the Nscale filing or roadshow window.", "2026-10-15", 64),
        ("photonics-guidance-breadth", "semis_photonics", "At least two optical-networking suppliers raise forward demand commentary before year-end.", "2026-12-31", 58),
        ("quantum-fundamentals-gap", "quantum", "The quantum basket underperforms the AI infrastructure basket when momentum cools.", "2026-12-31", 61),
    ]
    for key, thesis_id, statement, target_date, probability in predictions:
        conn.execute(
            """
            INSERT INTO predictions(external_key, thesis_id, statement, target_date, probability, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(external_key) DO UPDATE SET statement=excluded.statement, target_date=excluded.target_date,
              probability=excluded.probability, updated_at=excluded.updated_at
            """,
            (key, thesis_id, statement, target_date, probability, ts, ts),
        )

    relations = [
        ("ai_power_nuclear", "neocloud_compute", "enables", 0.92, "Compute expansion depends on available power, interconnects, and grid timing."),
        ("neocloud_compute", "semis_photonics", "pulls_through", 0.82, "GPU clusters pull networking and optical demand forward."),
        ("ai_power_nuclear", "semis_photonics", "shares_capex_cycle", 0.64, "Both express different layers of the same data-center build cycle."),
        ("quantum", "neocloud_compute", "competes_for_risk_budget", 0.57, "Both attract speculative capital, but only one currently has visible utilization economics."),
    ]
    for src, dst, relation_type, strength, rationale in relations:
        conn.execute(
            """
            INSERT INTO thesis_relations(src_thesis_id, dst_thesis_id, relation_type, strength, rationale, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(src_thesis_id, dst_thesis_id, relation_type) DO UPDATE SET
              strength=excluded.strength, rationale=excluded.rationale, updated_at=excluded.updated_at
            """,
            (src, dst, relation_type, strength, rationale, ts, ts),
        )

    insights = [
        ("power-before-software", "Power may reprice before software", "The same AI demand signal touches neocloud capacity, grid scarcity, and optical interconnects. The less crowded expression may sit one layer below compute revenue.", "contrarian", 82, 70, ["thesis:ai_power_nuclear", "thesis:neocloud_compute", "thesis:semis_photonics"]),
        ("event-volatility-not-ipo", "Trade the event graph, not the IPO", "Nscale may be untradeable directly, but its filing window can still reprice public neocloud and power comps. The event is useful even if participation is skipped.", "connection", 76, 66, ["thesis:neocloud_compute", "concept:ipo_events", "concept:ai_power"]),
        ("risk-budget-substitution", "Narrative baskets compete for the same risk budget", "Quantum momentum can weaken when capital rotates toward infrastructure names with visible contracts and utilization.", "risk", 68, 59, ["thesis:quantum", "thesis:neocloud_compute"]),
    ]
    for slug, title, summary, insight_type, novelty, confidence, links in insights:
        conn.execute(
            """
            INSERT INTO insights(slug, title, summary, insight_type, novelty, confidence, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(slug) DO UPDATE SET title=excluded.title, summary=excluded.summary,
              novelty=excluded.novelty, confidence=excluded.confidence, updated_at=excluded.updated_at
            """,
            (slug, title, summary, insight_type, novelty, confidence, ts, ts),
        )
        insight_id = conn.execute("SELECT id FROM insights WHERE slug=?", (slug,)).fetchone()[0]
        for node_id in links:
            if conn.execute("SELECT 1 FROM graph_nodes WHERE id=?", (node_id,)).fetchone():
                conn.execute(
                    "INSERT OR IGNORE INTO insight_links(insight_id, node_id, relationship) VALUES (?, ?, 'connects')",
                    (insight_id, node_id),
                )


def seed_closed_loop(conn: sqlite3.Connection, ts: str) -> None:
    cycles = [
        ("cycle-ai-power-01", "ai_power_nuclear", "AI power beneficiaries sustain relative strength through the next capex-guidance cycle.", "Basket outperforms software AI proxies with improving breadth and no drawdown beyond the hard risk limit.", "live", "active", 4, "AI capex expansion"),
        ("cycle-neocloud-01", "neocloud_compute", "A confirmed Nscale filing expands volatility and attention across listed neocloud comps.", "At least two public comps show volume expansion around the filing window without a financing-quality break.", "backtest", "open", 3, "event volatility"),
        ("cycle-photonics-01", "semis_photonics", "Optical suppliers capture a second derivative of cluster capex.", "Two suppliers improve demand commentary before year-end and the basket holds after doubled-cost stress.", "research", "open", 2, "AI capex expansion"),
        ("cycle-quantum-01", "quantum", "Quantum momentum fades relative to infrastructure when speculative liquidity contracts.", "Quantum basket underperforms neoclouds in the next risk-off rotation.", "postmortem", "killed", 5, "speculative risk-off"),
    ]
    for key, thesis_id, hypothesis, outcome, stage, status, iteration, regime in cycles:
        conn.execute(
            """
            INSERT INTO research_cycles(external_key, thesis_id, hypothesis, preregistered_outcome, preregistered_at, stage, status, iteration, market_regime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(external_key) DO UPDATE SET hypothesis=excluded.hypothesis,
              preregistered_outcome=excluded.preregistered_outcome, stage=excluded.stage,
              status=excluded.status, iteration=excluded.iteration, market_regime=excluded.market_regime,
              updated_at=excluded.updated_at
            """,
            (key, thesis_id, hypothesis, outcome, ts, stage, status, iteration, regime, ts, ts),
        )

    tests = [
        ("ai-power-base", "cycle-ai-power-01", "power-breadth-v4", "survived", 11.2, -7.4, 1.21, 2.0, "2022 rates shock", None, "Held positive expectancy after doubled costs; drawdown remained inside the hard limit."),
        ("ai-power-fast", "cycle-ai-power-01", "fast-entry-v3", "killed", 3.1, -18.8, 0.22, 2.0, "2022 rates shock", "drawdown_breach", "Entry sensitivity overfit the recent momentum regime and failed during rate-volatility expansion."),
        ("neocloud-equal", "cycle-neocloud-01", "equal-weight-event", "survived", 8.6, -10.2, 0.94, 2.0, "2025 financing scare", None, "Volume confirmation improved results; financing screens prevented the worst tail outcomes."),
        ("neocloud-leverage", "cycle-neocloud-01", "levered-beta", "killed", -12.7, -27.5, -0.31, 2.0, "2025 financing scare", "crash_fail", "Leverage amplified correlated financing risk; the expression duplicated one underlying factor."),
        ("photonics-earnings", "cycle-photonics-01", "earnings-drift", "queued", None, None, None, 2.0, "2022 semiconductor downcycle", None, None),
        ("quantum-breakout", "cycle-quantum-01", "breakout-v5", "killed", -6.4, -24.1, -0.18, 2.0, "speculative risk-off", "regime_dependency", "The signal only survived high-liquidity momentum regimes and repeated a previously observed failure."),
    ]
    for key, cycle_key, variant, status, total_return, drawdown, sharpe, costs, regime, failure, autopsy in tests:
        cycle_id = conn.execute("SELECT id FROM research_cycles WHERE external_key=?", (cycle_key,)).fetchone()[0]
        conn.execute(
            """
            INSERT INTO strategy_tests(external_key, cycle_id, variant_label, status, total_return, max_drawdown, deflated_sharpe,
              cost_multiplier, stress_regime, failure_reason, autopsy, tested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(external_key) DO UPDATE SET status=excluded.status, total_return=excluded.total_return,
              max_drawdown=excluded.max_drawdown, deflated_sharpe=excluded.deflated_sharpe,
              cost_multiplier=excluded.cost_multiplier, stress_regime=excluded.stress_regime,
              failure_reason=excluded.failure_reason, autopsy=excluded.autopsy, tested_at=excluded.tested_at
            """,
            (key, cycle_id, variant, status, total_return, drawdown, sharpe, costs, regime, failure, autopsy, ts),
        )

    regimes = ["base", "rate_shock", "liquidity_crunch", "earnings_gap", "crowded_unwind", "sideways_chop"]
    for test_index, (key, _, _, status, total_return, _, _, _, _, failure, _) in enumerate(tests):
        test_id = conn.execute("SELECT id FROM strategy_tests WHERE external_key=?", (key,)).fetchone()[0]
        for regime_index, regime in enumerate(regimes):
            for cost_multiplier in (1.0, 2.0):
                scenario_key = f"{regime}-{int(cost_multiplier)}x"
                if status == "queued":
                    outcome, metric_value, breach = "queued", None, None
                else:
                    penalty = regime_index * 2.1 + (cost_multiplier - 1) * 3.4
                    metric_value = round((total_return or 0) - penalty + ((test_index * 3 + regime_index) % 5) - 2, 2)
                    outcome = "survived" if status == "survived" and metric_value > -5 and regime_index < 5 else "killed"
                    breach = None if outcome == "survived" else (failure or ("cost_fail" if cost_multiplier > 1 else "regime_fail"))
                conn.execute(
                    """
                    INSERT INTO test_scenarios(test_id, scenario_key, market_regime, cost_multiplier, outcome, metric_value, breach_type, tested_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(test_id, scenario_key) DO UPDATE SET outcome=excluded.outcome,
                      metric_value=excluded.metric_value, breach_type=excluded.breach_type, tested_at=excluded.tested_at
                    """,
                    (test_id, scenario_key, regime, cost_multiplier, outcome, metric_value, breach, ts),
                )

    if not conn.execute("SELECT 1 FROM agent_runs LIMIT 1").fetchone():
        roles = [
            ("cycle-ai-power-01", "research", "power-specialists", 1, "Independent source agents found power, fuel, and grid bottleneck evidence without current-price context."),
            ("cycle-ai-power-01", "breaker", "adversarial", 0, "Replayed the thesis at doubled transaction costs and in the 2022 rates shock."),
            ("cycle-neocloud-01", "critic", "journal-review", 0, "Flagged repeated underweighting of financing risk in high-beta infrastructure expressions."),
            ("cycle-quantum-01", "postmortem", "journal-review", 0, "Matched the failure to a prior speculative-liquidity regime dependency."),
        ]
        for cycle_key, role, group, blinded, summary in roles:
            cycle_id = conn.execute("SELECT id FROM research_cycles WHERE external_key=?", (cycle_key,)).fetchone()[0]
            conn.execute("INSERT INTO agent_runs(cycle_id, agent_role, independence_group, price_blinded, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)", (cycle_id, role, group, blinded, summary, ts))

    lessons = [
        ("cycle-ai-power-01", "ai-power-fast", "ai_power_nuclear", "negative_result", "Fast-entry variants overfit recent power momentum and breach drawdown limits during rate shocks.", "2022 rates shock", 1),
        ("cycle-neocloud-01", "neocloud-leverage", "neocloud_compute", "factor_concentration", "Levered neocloud baskets conceal a shared financing factor; exposure must be capped at the factor level.", "financing stress", 1),
        ("cycle-quantum-01", "quantum-breakout", "quantum", "regime_dependency", "Quantum breakout signals have not survived outside high-liquidity speculative regimes.", "speculative risk-off", 0),
    ]
    for cycle_key, test_key, thesis_id, lesson_type, summary, regime, incorporated in lessons:
        cycle_id = conn.execute("SELECT id FROM research_cycles WHERE external_key=?", (cycle_key,)).fetchone()[0]
        test_id = conn.execute("SELECT id FROM strategy_tests WHERE external_key=?", (test_key,)).fetchone()[0]
        if conn.execute("SELECT 1 FROM research_lessons WHERE test_id=? AND lesson_type=?", (test_id, lesson_type)).fetchone():
            continue
        conn.execute("INSERT INTO research_lessons(cycle_id, test_id, thesis_id, lesson_type, summary, market_regime, incorporated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (cycle_id, test_id, thesis_id, lesson_type, summary, regime, incorporated, ts))

    controls = [
        ("portfolio-drawdown", "portfolio", "max_drawdown", {"percent": 8}, "code"),
        ("thesis-notional", "thesis", "max_notional", {"percent_of_equity": 5}, "code"),
        ("event-liquidity", "trade", "minimum_liquidity", {"max_spread_bps": 80}, "code"),
        ("breaker-costs", "backtest", "transaction_cost_stress", {"multiplier": 2}, "code"),
    ]
    for key, scope, control_type, threshold, enforcement in controls:
        conn.execute(
            """
            INSERT INTO risk_controls(control_key, scope, control_type, threshold_json, enforcement_level, status, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?)
            ON CONFLICT(control_key) DO UPDATE SET threshold_json=excluded.threshold_json,
              enforcement_level=excluded.enforcement_level, status=excluded.status, updated_at=excluded.updated_at
            """,
            (key, scope, control_type, json.dumps(threshold, sort_keys=True), enforcement, ts),
        )


def main():
    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    ensure_column(conn, "theses", "stance", "TEXT NOT NULL DEFAULT 'neutral'")
    ensure_column(conn, "theses", "variant_perception", "TEXT")
    ensure_column(conn, "theses", "falsifier", "TEXT")

    for cid in CONCEPTS:
        upsert_node(conn, cid, "concept", cid.split(":", 1)[1].replace("_", " "))

    for row in conn.execute("SELECT symbol, status FROM symbols"):
        symbol, status = row
        upsert_node(conn, f"symbol:{symbol}", "symbol", symbol, {"status": status})

    for row in conn.execute("SELECT id, name, status, confidence, summary FROM theses"):
        tid, name, status, confidence, summary = row
        upsert_node(conn, f"thesis:{tid}", "thesis", name, {"status": status, "confidence": confidence, "summary": summary})

    for row in conn.execute("SELECT id, text, created_at, market_score FROM bookmarks WHERE is_market_related = 1"):
        bid, text, created_at, score = row
        src_id = f"source:x_bookmark:{bid}"
        upsert_node(conn, src_id, "source", f"X bookmark {bid}", {"created_at": created_at, "market_score": score})
        lower = (text or "").lower()
        for cid, keywords in CONCEPTS.items():
            if any(k in lower for k in keywords):
                upsert_edge(conn, src_id, cid, "mentions", weight=max(1, score / 25), props={"snippet": text[:240]})

    for row in conn.execute("SELECT id, title, url, text FROM articles WHERE text IS NOT NULL"):
        aid, title, url, text = row
        src_id = f"source:article:{aid}"
        upsert_node(conn, src_id, "source", title or url, {"url": url})
        lower = (text or "").lower()
        for cid, keywords in CONCEPTS.items():
            if any(k in lower for k in keywords):
                upsert_edge(conn, src_id, cid, "mentions", weight=2.0, props={"url": url})

    for cid, symbols in PUBLIC_COMPS.items():
        for symbol in symbols:
            upsert_node(conn, f"symbol:{symbol}", "symbol", symbol, {"status": "public_comp"})
            upsert_edge(conn, cid, f"symbol:{symbol}", "public_comp", weight=1.5)

    for row in conn.execute("SELECT id, symbol, thesis_id, status, rationale FROM trade_proposals"):
        pid, symbol, thesis_id, status, rationale = row
        trade_id = f"trade_proposal:{pid}"
        upsert_node(conn, trade_id, "trade", f"{status} {symbol}", {"status": status, "rationale": rationale})
        upsert_edge(conn, f"thesis:{thesis_id}", trade_id, "proposes", weight=3.0)
        upsert_edge(conn, trade_id, f"symbol:{symbol}", "targets", weight=3.0)

    ts = now_iso()
    nscale_summary = (
        "Nscale potential U.S. IPO as soon as September 2026; reports cite up to $3B raise, "
        "$51B contracted revenue, Anyscale acquisition, and large power/data-center commitments. "
        "Not confirmed for Aug 24 and not currently Robinhood-tradable."
    )
    existing_event = conn.execute(
        "SELECT id FROM research_events WHERE label=? AND event_date=? ORDER BY id LIMIT 1",
        ("Nscale possible U.S. IPO", "2026-09"),
    ).fetchone()
    if existing_event:
        event_id = existing_event[0]
        conn.execute(
            "UPDATE research_events SET summary=?, source_url=?, updated_at=? WHERE id=?",
            (nscale_summary, "https://www.nscale.com/press-releases/nscale-acquires-anyscale", ts, event_id),
        )
    else:
        conn.execute(
        """
        INSERT INTO research_events(event_type, label, event_date, status, source_url, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("ipo_watch", "Nscale possible U.S. IPO", "2026-09", "watching", "https://www.nscale.com/press-releases/nscale-acquires-anyscale", nscale_summary, ts, ts),
        )
        event_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    upsert_node(conn, f"event:{event_id}", "event", "Nscale possible U.S. IPO", {"event_date": "2026-09", "status": "watching"})
    for cid in ["concept:neocloud", "concept:ai_power", "concept:ipo_events"]:
        upsert_edge(conn, f"event:{event_id}", cid, "catalyzes", weight=4.0)

    for topic, reason in [
        ("Nscale S-1 / F-1 filing detection", "Find confirmed filing, ticker, valuation, lockups, public comps, and whether direct or comp trade exists."),
        ("Upcoming earnings swing map", "Build a rolling 14-day calendar of earnings likely to move existing theses."),
        ("AI power public comps", "Track VST/CEG/GEV/XE/OKLO/LEU news, volume, and sentiment as Nscale IPO approaches."),
    ]:
        if conn.execute("SELECT 1 FROM research_queue WHERE topic=? AND status='open'", (topic,)).fetchone():
            continue
        conn.execute(
            """
            INSERT INTO research_queue(priority, topic, reason, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (80, topic, reason, "ontology_refresh", ts, ts),
        )

    conn.execute(
        """
        INSERT INTO event_decisions(event_id, decision, rationale, participation_trigger, decided_at, updated_at)
        VALUES (?, 'watch', ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET rationale=excluded.rationale,
          participation_trigger=excluded.participation_trigger, updated_at=excluded.updated_at
        """,
        (event_id, "No direct participation before a confirmed filing, terms, ticker, and Robinhood tradability. Use the event to monitor public comps.", "Reassess after filing terms are public and liquidity can be evaluated.", ts, ts),
    )

    seed_research_views(conn, ts)
    seed_closed_loop(conn, ts)
    conn.execute("PRAGMA optimize")

    conn.commit()
    nodes = conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0]
    edges = conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
    events = conn.execute("SELECT COUNT(*) FROM research_events").fetchone()[0]
    queue = conn.execute("SELECT COUNT(*) FROM research_queue WHERE status = 'open'").fetchone()[0]
    print(json.dumps({"nodes": nodes, "edges": edges, "events": events, "open_research_queue": queue}, indent=2))
    conn.close()


if __name__ == "__main__":
    main()
