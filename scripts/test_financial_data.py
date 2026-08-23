#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import unittest

from scripts import financial_data


class FinancialDataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        financial_data.initialize(self.conn)

    def tearDown(self) -> None:
        self.conn.close()

    def test_fingerprint_ignores_parameter_order(self) -> None:
        first = financial_data.RequestSpec("/prices", {"ticker": "GEV", "interval": "day"})
        second = financial_data.RequestSpec("prices", {"interval": "day", "ticker": "GEV"})
        self.assertEqual(financial_data.request_fingerprint(first), financial_data.request_fingerprint(second))

    def test_normalized_records_are_deduplicated_but_raw_source_is_retained(self) -> None:
        spec = financial_data.RequestSpec("/earnings", {"ticker": "GEV"})
        payload = {"earnings": [{"ticker": "GEV", "report_period": "2026-06-30", "eps": 1.2}]}
        request_id = self._raw_request(spec, payload)
        first = financial_data.normalize_records(self.conn, spec, payload, request_id, "2026-08-23T12:00:00Z")
        second = financial_data.normalize_records(self.conn, spec, payload, request_id, "2026-08-23T12:01:00Z")
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM financial_api_requests").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM financial_records").fetchone()[0], 1)

    def test_closed_historical_price_range_gets_long_ttl(self) -> None:
        spec = financial_data.RequestSpec("/prices", {"ticker": "GEV", "end_date": "2024-12-31"})
        duration, policy = financial_data.ttl_for(spec)
        self.assertGreaterEqual(duration, dt.timedelta(days=3650))
        self.assertEqual(policy, "historical_range_immutable")

    def test_mcp_import_populates_direct_api_cache_identity(self) -> None:
        spec = financial_data.RequestSpec("/company/facts", {"ticker": "GEV"})
        request_id, inserted = financial_data.import_mcp_response(
            self.conn, spec, {"ticker": "GEV", "name": "GE Vernova"}, tool_name="get_company_facts"
        )
        cached = financial_data.cached_request(self.conn, financial_data.request_fingerprint(spec))
        self.assertEqual(cached["id"], request_id)
        self.assertEqual(inserted, 1)

    def _raw_request(self, spec: financial_data.RequestSpec, payload: object) -> int:
        raw = json.dumps(payload).encode()
        cursor = self.conn.execute(
            """INSERT INTO financial_api_requests(provider, request_fingerprint, method, endpoint,
               params_json, requested_at, completed_at, status_code, response_headers_json,
               response_sha256, response_encoding, response_body)
               VALUES (?, ?, 'GET', ?, '{}', '2026-08-23T12:00:00Z', '2026-08-23T12:00:01Z',
               200, '{}', 'sha', 'identity', ?)""",
            (financial_data.PROVIDER, financial_data.request_fingerprint(spec), spec.endpoint, raw),
        )
        return int(cursor.lastrowid)


if __name__ == "__main__":
    unittest.main()
