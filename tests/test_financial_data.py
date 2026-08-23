#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import unittest

from thesisforge.financial import service as financial_data


class FinancialDataTests(unittest.TestCase):
    def test_fingerprint_ignores_parameter_order(self) -> None:
        first = financial_data.RequestSpec("/prices", {"ticker": "GEV", "interval": "day"})
        second = financial_data.RequestSpec("prices", {"interval": "day", "ticker": "GEV"})
        self.assertEqual(financial_data.request_fingerprint(first), financial_data.request_fingerprint(second))

    def test_closed_historical_price_range_gets_long_ttl(self) -> None:
        spec = financial_data.RequestSpec("/prices", {"ticker": "GEV", "end_date": "2024-12-31"})
        duration, policy = financial_data.ttl_for(spec)
        self.assertGreaterEqual(duration, dt.timedelta(days=3650))
        self.assertEqual(policy, "historical_range_immutable")

    def test_payload_normalization_prefers_record_collection(self) -> None:
        payload = {
            "meta": {"ticker": "GEV"},
            "earnings": [
                {"ticker": "GEV", "report_period": "2026-06-30"},
                {"ticker": "GEV", "report_period": "2026-03-31"},
            ],
        }
        self.assertEqual(financial_data.records_from_payload(payload), payload["earnings"])

    def test_pilot_has_bounded_dataset_count(self) -> None:
        specs = financial_data.pilot_specs("gev", "2025-08-23", "2026-08-23")
        self.assertEqual(len(specs), 11)
        self.assertTrue(all(spec.params.get("ticker") == "GEV" for spec in specs))


if __name__ == "__main__":
    unittest.main()
