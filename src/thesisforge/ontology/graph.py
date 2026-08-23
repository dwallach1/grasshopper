"""Shared persistence operations for ontology graph nodes and edges."""

from __future__ import annotations

import json
from typing import Any

from thesisforge.clock import utc_now_iso
from thesisforge.db import Connection


def upsert_node(
    conn: Connection,
    node_id: str,
    node_type: str,
    label: str,
    props: dict[str, Any] | None = None,
) -> None:
    timestamp = utc_now_iso()
    conn.execute(
        """
        INSERT INTO graph_nodes(id, node_type, label, properties_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label=excluded.label,
          properties_json=excluded.properties_json,
          updated_at=excluded.updated_at
        """,
        (node_id, node_type, label, json.dumps(props or {}, sort_keys=True), timestamp, timestamp),
    )


def upsert_edge(
    conn: Connection,
    src: str,
    dst: str,
    edge_type: str,
    weight: float = 1.0,
    props: dict[str, Any] | None = None,
) -> None:
    timestamp = utc_now_iso()
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
        (src, dst, edge_type, weight, json.dumps(props or {}, sort_keys=True), timestamp, timestamp),
    )
