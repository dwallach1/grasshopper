from __future__ import annotations

import datetime as dt
import json
import unittest

from thesisforge.ontology.graph import upsert_edge, upsert_node


class RecordingConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []

    def execute(self, query: str, params: tuple):
        self.calls.append((query, params))


class OntologyGraphTests(unittest.TestCase):
    def test_graph_properties_serialize_postgres_temporal_values(self) -> None:
        conn = RecordingConnection()
        observed = dt.datetime(2026, 8, 23, 12, 30, tzinfo=dt.UTC)

        upsert_node(conn, "source:test", "source", "Test", {"observed_at": observed})
        upsert_edge(conn, "source:test", "theme:test", "classified_as", props={"event_date": observed.date()})

        self.assertEqual(json.loads(conn.calls[0][1][3])["observed_at"], "2026-08-23 12:30:00+00:00")
        self.assertEqual(json.loads(conn.calls[1][1][4])["event_date"], "2026-08-23")


if __name__ == "__main__":
    unittest.main()
