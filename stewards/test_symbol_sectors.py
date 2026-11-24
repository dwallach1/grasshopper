"""Company-facts parsing for symbol_sectors.py. No ticker is assigned a sector here."""
from __future__ import annotations

import importlib.util
import io
import sys
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PATH = HERE / "quantanamo" / "symbol_sectors.py"
SCHEMA = HERE.parent / "supabase" / "schemas" / "105_ontology_sector_membership.sql"
MIGRATION = HERE.parent / "supabase" / "migrations" / "20261123190000_ontology_sector_membership.sql"
ROBINHOOD_SCHEMA = HERE.parent / "supabase" / "schemas" / "106_symbol_sector_robinhood_fundamentals.sql"
ROBINHOOD_MIGRATION = HERE.parent / "supabase" / "migrations" / "20261124190000_symbol_sector_robinhood_fundamentals.sql"
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

    def test_http_404_is_no_sector_402_is_credit_and_5xx_is_a_retry(self) -> None:
        mod = load()
        self.assertEqual(mod.classify_http(404), "none")
        self.assertEqual(mod.classify_http(200), "ok")
        self.assertEqual(mod.classify_http(402), "credit")
        for status in (401, 429, 500, 503):
            self.assertEqual(mod.classify_http(status), "retry", status)
        self.assertTrue(mod.credit_exhausted(402, b""))
        self.assertTrue(mod.credit_exhausted(403, b'{"error":"Insufficient credits remaining"}'))
        self.assertTrue(mod.credit_exhausted(400, b"prepaid balance exhausted"))
        self.assertFalse(mod.credit_exhausted(200, b'{"sector":"Finance","balance_sheet":{"cash":1}}'))
        self.assertFalse(mod.credit_exhausted(429, b"rate limited"))
        self.assertFalse(mod.credit_exhausted(500, b"credit card on file"))

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

    def test_robinhood_source_keeps_the_first_taxonomy_and_names_the_theme(self) -> None:
        sql = ROBINHOOD_MIGRATION.read_text()
        self.assertEqual(ROBINHOOD_SCHEMA.read_text(), sql)
        self.assertIn("'robinhood_fundamentals'", sql)
        self.assertIn("'financialdatasets_company_facts'", sql)
        self.assertIn("'kept_existing_source'", sql)
        self.assertIn("sector_producer_manufacturing", sql)
        self.assertIn(
            "Sector from Robinhood equity fundamentals (robinhood_fundamentals).",
            sql,
        )
        self.assertIn("v_created_by := 'robinhood_fundamentals'", sql)
        self.assertIn("v_created_by := 'company_facts'", sql)
        self.assertIn("'sector', v_sector", sql)
        self.assertIn("parent_theme_id", sql)
        self.assertIn("35, 3, v_created_by, now(), now()", sql)
        self.assertIn("current_user::text <> 'quantanamo_worker'", sql)
        self.assertIn("not_operator", sql)
        self.assertIn("symbol_not_in_ledger", sql)
        self.assertIn("'no_sector'", sql)
        self.assertIn(
            "source must be financialdatasets_company_facts or robinhood_fundamentals",
            sql,
        )
        fn = sql.split("create or replace function public.upsert_symbol_sector", 1)[1]
        self.assertLess(fn.index("'kept_existing_source'"), fn.index("insert into public.symbol_sectors"))
        for line in sql.splitlines():
            lowered = line.lower()
            if "desk_public_reader" in lowered and "grant" in lowered and "revoke" not in lowered:
                self.fail(line)
        self.assertIn("revoke all on table public.symbol_sectors from desk_public_reader", sql)
        self.assertNotIn("grant select on table public.symbol_sectors", sql.lower())
        self.assertNotIn("grant insert", sql.lower())
        self.assertNotIn("grant update", sql.lower())

    def test_credit_exhaustion_stops_the_run_and_exits_zero(self) -> None:
        mod = load()
        upserts = []

        def caller(fn, payload):
            if fn == "symbol_sector_gaps":
                return {"symbols": ["AMAT", "KKR"]}
            if fn == "symbol_sector_vault":
                return {"rows": []}
            if fn == "upsert_symbol_sector":
                upserts.append(payload)
                return {"ok": True, "symbol": payload["symbol"], "theme_id": "sector_producer_manufacturing"}
            raise AssertionError(fn)

        def fetch(symbol, api_key):
            if symbol == "AMAT":
                return {
                    "symbol": "AMAT",
                    "sector": "Producer Manufacturing",
                    "industry": "Industrial Machinery",
                    "source": mod.SOURCE,
                }
            raise mod.CreditExhausted("financial datasets prepaid balance exhausted (HTTP 402)")

        mod.fetch_facts = fetch
        report = mod.populate(caller, "test-key")
        self.assertTrue(report["ok"])
        self.assertEqual(report["skip"], "financialdatasets_credit_exhausted")
        self.assertIn("402", report["skip_reason"])
        self.assertEqual(report["unfetched"], ["KKR"])
        self.assertEqual(report["retry"], [])
        self.assertEqual([row["symbol"] for row in upserts], ["AMAT"])
        self.assertIn("robinhood_fundamentals", PATH.read_text())
        self.assertIn("upsert_symbol_sector", PATH.read_text().split('"""', 2)[1])

        mod.populate = lambda *args, **kwargs: {
            "ok": True,
            "skip": "financialdatasets_credit_exhausted",
            "skip_reason": "financial datasets prepaid balance exhausted (HTTP 402)",
            "wrote": 0,
            "retry": [],
            "rows": [],
        }
        argv = sys.argv
        sys.argv = ["symbol_sectors.py"]
        try:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                mod.main()
        finally:
            sys.argv = argv
        self.assertIn("financialdatasets_credit_exhausted", err.getvalue())
        self.assertIn("financialdatasets_credit_exhausted", out.getvalue())

    def test_fetch_facts_turns_a_402_into_credit_exhausted_and_a_404_into_no_sector(self) -> None:
        mod = load()

        def raise_status(status: int, body: bytes):
            def urlopen(req, timeout=0):
                raise urllib.error.HTTPError(
                    req.full_url, status, "nope", None, io.BytesIO(body),
                )
            return urlopen

        with mock.patch.object(mod.urllib.request, "urlopen", raise_status(402, b'{"error":"insufficient credits"}')):
            with self.assertRaises(mod.CreditExhausted) as ctx:
                mod.fetch_facts("AMAT", "secret-key")
        self.assertIn("402", str(ctx.exception))
        self.assertNotIn("secret-key", str(ctx.exception))

        with mock.patch.object(mod.urllib.request, "urlopen", raise_status(403, b"prepaid balance exhausted")):
            with self.assertRaises(mod.CreditExhausted) as ctx:
                mod.fetch_facts("KKR", "secret-key")
        self.assertIn("403", str(ctx.exception))

        with mock.patch.object(mod.urllib.request, "urlopen", raise_status(404, b"missing")):
            self.assertIsNone(mod.fetch_facts("AMAT", "secret-key")["sector"])

    def test_a_server_error_is_still_a_retry(self) -> None:
        mod = load()

        def caller(fn, payload):
            if fn == "symbol_sector_gaps":
                return {"symbols": ["FIXT"]}
            if fn == "symbol_sector_vault":
                return {"rows": []}
            raise AssertionError(fn)

        def fetch(symbol, api_key):
            raise mod.SourceError("financial datasets company facts HTTP 500")

        mod.fetch_facts = fetch
        report = mod.populate(caller, "test-key")
        self.assertFalse(report["ok"])
        self.assertNotIn("skip", report)
        self.assertEqual(report["retry"][0]["symbol"], "FIXT")


if __name__ == "__main__":
    unittest.main()
