from __future__ import annotations

import datetime as dt
import unittest

from thesisforge.ontology.learning import OntologyCatalog, Theme, normalize_phrase, text_features
from thesisforge.research.event_map import event_date, week_bounds


class OntologyCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.theme = Theme(
            id="grid_storage",
            thesis_id="grid_storage",
            kind="theme",
            name="Grid storage",
            description="Battery and long-duration grid storage",
            match_threshold=30,
            auto_promote_sources=3,
        )
        self.catalog = OntologyCatalog(
            themes=[self.theme],
            terms=[
                {"theme_id": "grid_storage", "normalized_term": "grid storage", "weight": 80, "term_type": "phrase"},
                {"theme_id": "grid_storage", "normalized_term": "battery", "weight": 60, "term_type": "keyword"},
            ],
            memberships=[{"symbol": "FLNC", "theme_id": "grid_storage", "confidence": 90}],
            symbols=["FLNC"],
            lexicon=[
                {"token": "CEO", "token_type": "ignored_symbol", "weight": 0},
                {"token": "revenue", "token_type": "market_keyword", "weight": 8},
                {"token": "financial", "token_type": "market_context", "weight": 8},
                {"token": "about", "token_type": "candidate_stopword", "weight": 0},
            ],
        )

    def test_database_term_classifies_without_code_change(self) -> None:
        matches = self.catalog.classify("Long-duration grid storage demand is accelerating", set())
        self.assertEqual([match.theme.id for match in matches], ["grid_storage"])
        self.assertIn("grid storage", matches[0].matched_terms)

    def test_database_membership_classifies_known_symbol(self) -> None:
        matches = self.catalog.classify("Watching $FLNC into the print", {"FLNC"})
        self.assertEqual(matches[0].theme.id, "grid_storage")
        self.assertEqual(matches[0].matched_symbols, ("FLNC",))

    def test_new_symbol_is_discovered_but_not_forced_into_theme(self) -> None:
        symbols = self.catalog.extract_symbols("CEO discusses $ZETA and FLNC but not BEFORE")
        self.assertEqual(symbols, {"ZETA", "FLNC"})
        self.assertEqual(self.catalog.classify("New issuer $ZETA", {"ZETA"}), [])

    def test_market_scoring_uses_database_lexicon(self) -> None:
        score = self.catalog.market_score(
            "Revenue inflected for $FLNC",
            {"FLNC"},
            [{"domain": {"name": "Financial Services"}}],
        )
        self.assertEqual(score, 28)

    def test_salient_features_exclude_learning_stopwords(self) -> None:
        features = self.catalog.salient_features("About battery storage economics")
        self.assertNotIn(("term", "about"), features)
        self.assertIn(("term", "battery storage"), features)


class NormalizationTests(unittest.TestCase):
    def test_normalization_and_ngram_generation(self) -> None:
        self.assertEqual(normalize_phrase("GPU_Cloud / 1.6T"), "gpu cloud 1.6t")
        self.assertIn("gpu cloud", text_features("GPU cloud capacity"))

    def test_event_map_uses_dynamic_week(self) -> None:
        start, end = week_bounds(dt.date(2026, 8, 23))
        self.assertEqual(start, dt.date(2026, 8, 17))
        self.assertEqual(end, dt.date(2026, 8, 23))
        self.assertEqual(event_date("2026-08-24_to_2026-08-30"), dt.date(2026, 8, 24))


if __name__ == "__main__":
    unittest.main()
