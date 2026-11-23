"""Company-facts parsing for symbol_sectors.py. No ticker is assigned a sector here."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATH = HERE / "quantanamo" / "symbol_sectors.py"
SCHEMA = HERE.parent / "supabase" / "schemas" / "105_ontology_sector_membership.sql"
MIGRATION = HERE.parent / "supabase" / "migrations" / "20261123190000_ontology_sector_membership.sql"
EDGE = HERE.parent / "supabase" / "functions" / "steward-rpc" / "index.ts"


def load():
    spec = importlib.util.spec_from_file_location("symbol_sectors", PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class SymbolSectors(unittest.TestCase):
    def test_schema_file_is_the_migration(self) -> None:
        self.assertEqual(SCHEMA.read_text(), MIGRATION.read_text())

    def test_flat_and_wrapped_facts_keep_the_payload_sector(self) -> None:
        mod = load()
        flat = mod.sector_from_payload(
            {"ticker": "FIXT", "sector": "Utilities", "industry": "Electric Utilities"},
            "FIXT",
        )
        self.assertEqual(flat["sector"], "Utilities")
        self.assertEqual(flat["industry"], "Electric Utilities")
        self.assertEqual(flat["source"], "financialdatasets_company_facts")
        wrapped = mod.sector_from_payload(
            {"company_facts": {"ticker": "FIXT", "sector": "Materials", "industry": "Metals & Mining"}},
            "fixt",
        )
        self.assertEqual(wrapped["sector"], "Materials")
        self.assertIsNone(mod.sector_from_payload({"ticker": "FIXT", "industry": "Only"}, "FIXT")["sector"])

    def test_a_different_ticker_is_not_stored_as_this_symbol(self) -> None:
        mod = load()
        with self.assertRaises(mod.SourceError):
            mod.sector_from_payload({"ticker": "OTHER", "sector": "Financials"}, "FIXT")

    def test_http_404_is_no_sector_and_a_credit_or_5xx_is_a_retry(self) -> None:
        mod = load()
        self.assertEqual(mod.classify_http(404), "none")
        self.assertEqual(mod.classify_http(200), "ok")
        for status in (401, 402, 429, 500, 503):
            self.assertEqual(mod.classify_http(status), "retry", status)

    def test_populate_writes_vault_rows_and_does_not_invent_the_rest_without_a_key(self) -> None:
        mod = load()
        calls = []
        upserts = []

        def caller(fn, payload):
            calls.append(fn)
            if fn == "symbol_sector_gaps":
                return {"symbols": ["FIXT", "NONE"]}
            if fn == "symbol_sector_vault":
                return {"rows": [{"symbol": "FIXT", "sector": "Utilities", "industry": "Electric Utilities"}]}
            if fn == "upsert_symbol_sector":
                upserts.append(payload)
                return {"ok": True, "symbol": payload["symbol"], "theme_id": "sector_utilities"}
            raise AssertionError(fn)

        report = mod.populate(caller, None, dry_run=False)
        self.assertFalse(report["ok"])
        self.assertEqual(report["retry"], ["NONE"])
        self.assertEqual(report["wrote"][0]["symbol"], "FIXT")
        self.assertEqual(report["wrote"][0]["via"], "vault")
        self.assertEqual(report["wrote"][0]["theme_id"], "sector_utilities")
        self.assertNotIn("NONE", {row["symbol"] for row in report["wrote"]})
        self.assertEqual(upserts, [{
            "symbol": "FIXT",
            "sector": "Utilities",
            "industry": "Electric Utilities",
            "source": "financialdatasets_company_facts",
        }])

    def test_the_script_and_sql_name_no_sector_and_do_not_grant_retired_roles(self) -> None:
        text = PATH.read_text()
        sql = SCHEMA.read_text()
        edge = EDGE.read_text()
        self.assertNotIn("AAPL", text)
        self.assertIn("financialdatasets_company_facts", text)
        self.assertIn("symbol_sector_gaps", text)
        self.assertIn("symbol_sector_vault", text)
        self.assertIn("upsert_symbol_sector", text)
        self.assertIn("'no_sector'", sql)
        self.assertIn("kind = 'sector'", sql)
        self.assertIn("'traded_lot'", sql)
        self.assertIn("'earnings_sheet'", sql)
        self.assertIn("r.theme_id is distinct from 'earnings_events'", sql)
        self.assertIn("having count(distinct i.source_type || ':' || i.source_key) >= 3", sql)
        allow = edge[edge.index("quantanamo_worker: new Set(["):]
        allow = allow[:allow.index("])")]
        for fn in ("symbol_sector_gaps", "symbol_sector_vault", "upsert_symbol_sector"):
            self.assertIn(f"'{fn}'", allow)
        for role in ("oddsborne_worker", "bandit_worker"):
            block = edge[edge.index(f"{role}: new Set(["):]
            block = block[:block.index("])")]
            for fn in ("symbol_sector_gaps", "symbol_sector_vault", "upsert_symbol_sector"):
                self.assertNotIn(f"'{fn}'", block, role)


if __name__ == "__main__":
    unittest.main()
