"""Evidence-driven, database-backed ontology classification and learning."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Iterable

from thesisforge.clock import utc_now_iso
from thesisforge.db import Connection


TOKEN_RE = re.compile(r"[a-z0-9]+(?:[.-][a-z0-9]+)*")
CASHTAG_RE = re.compile(r"\$([A-Z][A-Z0-9.]{0,9})\b")
UPPERCASE_RE = re.compile(r"\b[A-Z]{2,10}\b")
HASHTAG_RE = re.compile(r"#([A-Za-z][A-Za-z0-9_]{2,40})")


def normalize_phrase(value: str) -> str:
    """Normalize natural-language vocabulary into a stable catalog key."""
    return " ".join(TOKEN_RE.findall(value.lower().replace("_", " ")))


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def text_features(text: str, *, max_ngram: int = 4) -> set[str]:
    tokens = TOKEN_RE.findall(text.lower().replace("_", " "))
    features = set(tokens)
    for width in range(2, min(max_ngram, len(tokens)) + 1):
        features.update(" ".join(tokens[index : index + width]) for index in range(len(tokens) - width + 1))
    return features


@dataclass(frozen=True)
class Theme:
    id: str
    thesis_id: str | None
    kind: str
    name: str
    description: str
    match_threshold: int
    auto_promote_sources: int


@dataclass(frozen=True)
class ThemeMatch:
    theme: Theme
    score: int
    matched_terms: tuple[str, ...]
    matched_symbols: tuple[str, ...]


class OntologyCatalog:
    """Immutable in-memory view of the active database ontology for one run."""

    def __init__(
        self,
        *,
        themes: Iterable[Theme],
        terms: Iterable[dict[str, Any]],
        memberships: Iterable[dict[str, Any]],
        lexicon: Iterable[dict[str, Any]],
        symbols: Iterable[str] = (),
        blacklisted_symbols: Iterable[str] = (),
    ) -> None:
        self.themes = {theme.id: theme for theme in themes}
        self.terms_by_theme: dict[str, dict[str, tuple[int, str]]] = defaultdict(dict)
        self.all_active_terms: set[str] = set()
        for row in terms:
            term = str(row["normalized_term"])
            self.terms_by_theme[str(row["theme_id"])][term] = (int(row["weight"]), str(row["term_type"]))
            self.all_active_terms.add(term)

        self.memberships_by_symbol: dict[str, dict[str, int]] = defaultdict(dict)
        for row in memberships:
            self.memberships_by_symbol[str(row["symbol"])][str(row["theme_id"])] = int(row["confidence"])
        self.known_symbols = {str(symbol).upper() for symbol in symbols} | set(self.memberships_by_symbol)
        self.blacklisted_symbols = {str(symbol).upper() for symbol in blacklisted_symbols}

        self.ignored_symbols: set[str] = set()
        self.market_keywords: dict[str, int] = {}
        self.market_context: dict[str, int] = {}
        self.candidate_stopwords: set[str] = set()
        for row in lexicon:
            token = str(row["token"])
            token_type = str(row["token_type"])
            if token_type == "ignored_symbol":
                self.ignored_symbols.add(token.upper())
            elif token_type == "market_keyword":
                self.market_keywords[normalize_phrase(token)] = int(row["weight"])
            elif token_type == "market_context":
                self.market_context[normalize_phrase(token)] = int(row["weight"])
            elif token_type == "candidate_stopword":
                self.candidate_stopwords.add(normalize_phrase(token))

    @classmethod
    def load(cls, conn: Connection) -> "OntologyCatalog":
        themes = [
            Theme(
                id=row["id"],
                thesis_id=row["thesis_id"],
                kind=row["kind"],
                name=row["name"],
                description=row["description"],
                match_threshold=row["match_threshold"],
                auto_promote_sources=row["auto_promote_sources"],
            )
            for row in conn.execute(
                """SELECT id, thesis_id, kind, name, description, match_threshold, auto_promote_sources
                   FROM ontology_themes WHERE status='active'"""
            )
        ]
        terms = conn.execute(
            "SELECT theme_id, normalized_term, term_type, weight FROM ontology_terms WHERE status='active'"
        ).fetchall()
        memberships = conn.execute(
            """SELECT m.symbol, m.theme_id, m.confidence
               FROM symbol_theme_memberships m
               JOIN ontology_themes t ON t.id=m.theme_id
               JOIN symbols s ON s.symbol=m.symbol
               WHERE m.status='active' AND t.status='active' AND s.status<>'blacklisted'"""
        ).fetchall()
        lexicon = conn.execute(
            "SELECT token, token_type, weight FROM ontology_lexicon WHERE status='active'"
        ).fetchall()
        symbols = [
            row["symbol"]
            for row in conn.execute(
                "SELECT symbol FROM symbols WHERE status IN ('known', 'verified', 'active', 'public_comp')"
            )
        ]
        blacklisted_symbols = [
            row["symbol"]
            for row in conn.execute("SELECT symbol FROM symbols WHERE status='blacklisted'")
        ]
        return cls(
            themes=themes,
            terms=terms,
            memberships=memberships,
            lexicon=lexicon,
            symbols=symbols,
            blacklisted_symbols=blacklisted_symbols,
        )

    def extract_symbols(self, text: str) -> set[str]:
        cashtags = {match.group(1).replace(".", "-").upper() for match in CASHTAG_RE.finditer(text)}
        uppercase = {
            match.group(0).upper()
            for match in UPPERCASE_RE.finditer(text)
            if match.group(0).upper() in self.known_symbols
        }
        return {
            symbol
            for symbol in cashtags | uppercase
            if symbol not in self.ignored_symbols
            and symbol not in self.blacklisted_symbols
            and not symbol.isdigit()
        }

    def market_score(self, text: str, symbols: set[str], annotations: list[dict[str, Any]]) -> int:
        features = text_features(text)
        score = min(len(symbols) * 12, 48)
        score += sum(weight for term, weight in self.market_keywords.items() if term in features)
        context = normalize_phrase(json.dumps(annotations or []))
        score += sum(weight for term, weight in self.market_context.items() if term and term in context)
        return min(score, 100)

    def classify(self, text: str, symbols: set[str]) -> list[ThemeMatch]:
        symbols = symbols - self.blacklisted_symbols
        features = text_features(text)
        term_hits: dict[str, list[str]] = defaultdict(list)
        symbol_hits: dict[str, list[str]] = defaultdict(list)
        scores: Counter[str] = Counter()

        for theme_id, terms in self.terms_by_theme.items():
            for term, (weight, term_type) in terms.items():
                if term not in features:
                    continue
                adjustment = -weight if term_type == "negative" else round(weight * 0.55)
                scores[theme_id] += adjustment
                term_hits[theme_id].append(term)

        for symbol in symbols:
            for theme_id, confidence in self.memberships_by_symbol.get(symbol, {}).items():
                scores[theme_id] += round(confidence * 0.5)
                symbol_hits[theme_id].append(symbol)

        matches = []
        for theme_id, raw_score in scores.items():
            theme = self.themes.get(theme_id)
            if theme is None:
                continue
            score = max(0, min(100, raw_score))
            if score < theme.match_threshold:
                continue
            matches.append(
                ThemeMatch(
                    theme=theme,
                    score=score,
                    matched_terms=tuple(sorted(set(term_hits[theme_id]))),
                    matched_symbols=tuple(sorted(set(symbol_hits[theme_id]))),
                )
            )
        return sorted(matches, key=lambda match: (-match.score, match.theme.id))

    def salient_features(self, text: str, *, limit: int = 40) -> list[tuple[str, str]]:
        normalized = normalize_phrase(re.sub(r"https?://\S+", " ", text, flags=re.IGNORECASE))
        tokens = normalized.split()
        counts: Counter[tuple[str, str]] = Counter()
        for hashtag in HASHTAG_RE.findall(text):
            value = normalize_phrase(hashtag)
            if value:
                counts[("hashtag", value)] += 1
        for token in tokens:
            if len(token) >= 5 and token not in self.candidate_stopwords and not token.isdigit():
                counts[("term", token)] += 1
        for left, right in zip(tokens, tokens[1:]):
            phrase = f"{left} {right}"
            if len(left) >= 4 and len(right) >= 4 and left not in self.candidate_stopwords and right not in self.candidate_stopwords:
                counts[("term", phrase)] += 1
        return [feature for feature, _ in counts.most_common(limit)]


class OntologyLearner:
    """Persists source observations and promotes repeatable ontology knowledge."""

    def __init__(self, conn: Connection, catalog: OntologyCatalog | None = None) -> None:
        self.conn = conn
        self.catalog = catalog or OntologyCatalog.load(conn)

    def refresh_catalog(self) -> None:
        self.catalog = OntologyCatalog.load(self.conn)

    def sync_theme_theses(self) -> None:
        """Give active thesis themes a durable thesis row without templates in code."""
        timestamp = utc_now_iso()
        for theme in self.catalog.themes.values():
            if theme.kind != "theme":
                continue
            thesis_id = theme.thesis_id or theme.id
            self.conn.execute(
                """INSERT INTO theses(id, name, summary, status, confidence, time_horizon, created_at, updated_at)
                   VALUES (?, ?, ?, 'forming', 40, 'days_to_weeks', ?, ?)
                   ON CONFLICT(id) DO NOTHING""",
                (thesis_id, theme.name, theme.description, timestamp, timestamp),
            )
            if theme.thesis_id is None:
                self.conn.execute(
                    "UPDATE ontology_themes SET thesis_id=?, updated_at=? WHERE id=? AND thesis_id IS NULL",
                    (thesis_id, timestamp, theme.id),
                )
        # thesis_symbols are downstream classifier output, not independent ground
        # truth. Feeding them back as active memberships would create a circular
        # learner that amplifies its own prior guesses.
        self.refresh_catalog()

    def record_source(
        self,
        *,
        source_type: str,
        source_key: str,
        text: str,
        symbols: set[str],
        matches: list[ThemeMatch],
        observed_at: str | None = None,
    ) -> None:
        timestamp = observed_at or utc_now_iso()
        salient = self.catalog.salient_features(text)
        observations = [
            (source_type, source_key, "symbol", symbol, 1, timestamp)
            for symbol in symbols
        ] + [
            (source_type, source_key, feature_type, feature_value, 1, timestamp)
            for feature_type, feature_value in salient
        ]
        if observations:
            self.conn.executemany(
                """INSERT INTO ontology_observations(
                     source_type, source_key, feature_type, feature_value, occurrences, observed_at
                   ) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_type, source_key, feature_type, feature_value) DO UPDATE SET
                     occurrences=greatest(ontology_observations.occurrences, excluded.occurrences),
                     observed_at=excluded.observed_at""",
                observations,
            )

        evidence_rows: list[tuple[Any, ...]] = []
        candidates: dict[tuple[str, str], dict[str, Any]] = {}

        for match in matches:
            for term in match.matched_terms:
                evidence_rows.append(
                    (source_type, source_key, match.theme.id, "term", term, "term", match.score, timestamp)
                )
            for symbol in match.matched_symbols:
                evidence_rows.append(
                    (source_type, source_key, match.theme.id, "symbol", symbol, "symbol", match.score, timestamp)
                )

            for symbol in symbols - set(match.matched_symbols):
                candidate_key = f"{match.theme.id}:{symbol}"
                candidates[("membership", candidate_key)] = {
                    "candidate_type": "membership",
                    "candidate_key": candidate_key,
                    "proposed_theme_id": match.theme.id,
                    "proposed_label": symbol,
                    "description": f"{symbol} repeatedly co-occurs with {match.theme.name} evidence.",
                    "score": match.score,
                    "context": {"symbol": symbol, "theme": match.theme.id, "excerpt": text[:500]},
                }

            for feature_type, feature_value in salient[:8]:
                if feature_value in self.catalog.terms_by_theme.get(match.theme.id, {}):
                    continue
                candidate_key = f"{match.theme.id}:{feature_value}"
                candidates[("term", candidate_key)] = {
                    "candidate_type": "term",
                    "candidate_key": candidate_key,
                    "proposed_theme_id": match.theme.id,
                    "proposed_label": feature_value,
                    "description": f"Learned vocabulary candidate for {match.theme.name}.",
                    "score": max(1, match.score - (5 if feature_type == "term" else 0)),
                    "context": {"feature_type": feature_type, "theme": match.theme.id, "excerpt": text[:500]},
                }

        if evidence_rows:
            self.conn.executemany(
                """INSERT INTO ontology_evidence(
                     source_type, source_key, theme_id, feature_type, feature_value,
                     match_method, score, observed_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_type, source_key, theme_id, feature_type, feature_value, match_method)
                   DO UPDATE SET score=greatest(ontology_evidence.score, excluded.score),
                                 observed_at=excluded.observed_at""",
                evidence_rows,
            )
        if candidates:
            self._record_candidates(
                source_type=source_type,
                source_key=source_key,
                candidates=list(candidates.values()),
                observed_at=timestamp,
            )

    def discover_emerging_themes(self, *, minimum_sources: int = 4) -> int:
        """Create evidence-backed themes that can activate without human review."""
        rows = self.conn.execute(
            """SELECT o.source_type, o.source_key, o.feature_type, o.feature_value, o.observed_at
               FROM ontology_observations o
               WHERE o.feature_type IN ('term', 'hashtag')
                 AND NOT EXISTS (
                   SELECT 1 FROM ontology_evidence e
                   WHERE e.source_type=o.source_type AND e.source_key=o.source_key
                 )
               ORDER BY o.observed_at DESC"""
        ).fetchall()
        sources_by_feature: dict[str, list[Any]] = defaultdict(list)
        for row in rows:
            feature = row["feature_value"]
            if feature in self.catalog.candidate_stopwords or feature in self.catalog.all_active_terms:
                continue
            sources_by_feature[feature].append(row)

        created = 0
        for feature, evidence_rows in sources_by_feature.items():
            if " " not in feature and not any(row["feature_type"] == "hashtag" for row in evidence_rows):
                continue
            distinct_sources = {(row["source_type"], row["source_key"]) for row in evidence_rows}
            if len(distinct_sources) < minimum_sources:
                continue
            similar_theme, similarity = self._closest_theme(feature)
            if similar_theme is not None and similarity >= 0.72:
                candidate_type = "term"
                candidate_key = f"{similar_theme.id}:{feature}"
                proposed_theme_id = similar_theme.id
                description = f"Lexically similar emerging vocabulary for {similar_theme.name}."
            else:
                candidate_type = "theme"
                candidate_key = f"emerging:{slugify(feature)}"
                proposed_theme_id = None
                description = f"Repeated unclassified source cluster centered on “{feature}”."
            for row in evidence_rows:
                self._record_candidate(
                    candidate_type=candidate_type,
                    candidate_key=candidate_key,
                    proposed_theme_id=proposed_theme_id,
                    proposed_label=feature.replace("_", " ").title(),
                    description=description,
                    source_type=row["source_type"],
                    source_key=row["source_key"],
                    score=min(95, 45 + len(distinct_sources) * 5),
                    context={
                        "feature": feature,
                        "feature_type": evidence_rows[0]["feature_type"],
                        "similarity": round(similarity, 3),
                    },
                    observed_at=str(row["observed_at"]),
                )
            if candidate_type == "theme" and len(distinct_sources) >= minimum_sources + 1:
                theme_id = slugify(feature).replace("-", "_")[:80]
                if theme_id:
                    timestamp = utc_now_iso()
                    self.conn.execute(
                        """INSERT INTO ontology_themes(
                             id, kind, name, description, status, match_threshold,
                             auto_promote_sources, created_by, created_at, updated_at
                           ) VALUES (?, 'theme', ?, ?, 'candidate', 35, 6, 'learning', ?, ?)
                           ON CONFLICT(id) DO NOTHING""",
                        (theme_id, feature.title(), description, timestamp, timestamp),
                    )
                    self.conn.execute(
                        """UPDATE ontology_candidates
                           SET proposed_theme_id=?
                           WHERE candidate_type='theme' AND candidate_key=?
                             AND status='pending' AND proposed_theme_id IS NULL""",
                        (theme_id, candidate_key),
                    )
            created += 1
        return created

    def promote_ready_candidates(self) -> int:
        promoted = 0
        rows = self.conn.execute(
            """SELECT c.*, t.auto_promote_sources
               FROM ontology_candidates c
               LEFT JOIN ontology_themes t ON t.id=c.proposed_theme_id
               WHERE c.status='pending' AND c.candidate_type IN ('theme', 'term', 'membership')
               ORDER BY c.score DESC, c.source_count DESC"""
        ).fetchall()
        for row in rows:
            required_sources = int(row["auto_promote_sources"] or 4)
            minimum_score = 75 if row["candidate_type"] == "theme" else 65
            if int(row["source_count"]) < required_sources or int(row["score"]) < minimum_score:
                continue
            if row["candidate_type"] == "theme":
                if not self._promote_theme(row, learned_by="auto_emergence"):
                    continue
            elif row["candidate_type"] == "membership":
                symbol = row["proposed_label"].upper()
                symbol_row = self.conn.execute("SELECT status FROM symbols WHERE symbol=?", (symbol,)).fetchone()
                if not symbol_row or symbol_row["status"] not in {"verified", "active", "public_comp"}:
                    continue
                self._promote_membership(row, symbol, learned_by="auto_cooccurrence")
            else:
                normalized_label = normalize_phrase(row["proposed_label"])
                if not normalized_label or any(
                    token in {"http", "https", "www", "t.co"}
                    for token in normalized_label.split()
                ):
                    continue
                total_sources = self.conn.execute(
                    """SELECT COUNT(DISTINCT source_type || ':' || source_key) AS count
                       FROM ontology_observations WHERE feature_value=?""",
                    (normalized_label,),
                ).fetchone()["count"]
                precision = int(row["source_count"]) / max(1, int(total_sources))
                if int(row["source_count"]) < required_sources + 1 or precision < 0.65:
                    continue
                self._promote_term(row, learned_by="auto_cooccurrence")
            promoted += 1
        if promoted:
            self.refresh_catalog()
        return promoted

    def approve_candidate(self, candidate_id: int, *, note: str = "Manual review") -> None:
        row = self._candidate(candidate_id)
        if row["candidate_type"] == "membership":
            self._promote_membership(row, row["proposed_label"].upper(), learned_by="manual")
        elif row["candidate_type"] == "term":
            self._promote_term(row, learned_by="manual")
        else:
            self._promote_theme(row, learned_by="manual", review_note=note)
        self.refresh_catalog()

    def reject_candidate(self, candidate_id: int, *, note: str) -> None:
        self._candidate(candidate_id)
        self.conn.execute(
            "UPDATE ontology_candidates SET status='rejected', reviewed_at=?, review_note=? WHERE id=?",
            (utc_now_iso(), note, candidate_id),
        )

    def verify_symbol(self, symbol: str) -> None:
        result = self.conn.execute(
            "UPDATE symbols SET status='verified', last_seen_at=? WHERE symbol=?",
            (utc_now_iso(), symbol.upper()),
        )
        if result.rowcount != 1:
            raise ValueError(f"Unknown symbol: {symbol.upper()}")

    def _closest_theme(self, feature: str) -> tuple[Theme | None, float]:
        best_theme = None
        best_score = 0.0
        for theme_id, theme in self.catalog.themes.items():
            vocabulary = set(self.catalog.terms_by_theme.get(theme_id, {})) | {normalize_phrase(theme.name)}
            score = max((SequenceMatcher(None, feature, term).ratio() for term in vocabulary), default=0.0)
            if score > best_score:
                best_theme, best_score = theme, score
        return best_theme, best_score

    def _upsert_observation(self, source_type: str, source_key: str, feature_type: str, feature_value: str, occurrences: int, observed_at: str) -> None:
        self.conn.execute(
            """INSERT INTO ontology_observations(source_type, source_key, feature_type, feature_value, occurrences, observed_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_type, source_key, feature_type, feature_value) DO UPDATE SET
                 occurrences=greatest(ontology_observations.occurrences, excluded.occurrences),
                 observed_at=excluded.observed_at""",
            (source_type, source_key, feature_type, feature_value, occurrences, observed_at),
        )

    def _upsert_evidence(self, source_type: str, source_key: str, theme_id: str, feature_type: str, feature_value: str, method: str, score: int, observed_at: str) -> None:
        self.conn.execute(
            """INSERT INTO ontology_evidence(source_type, source_key, theme_id, feature_type, feature_value, match_method, score, observed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_type, source_key, theme_id, feature_type, feature_value, match_method)
               DO UPDATE SET score=greatest(ontology_evidence.score, excluded.score), observed_at=excluded.observed_at""",
            (source_type, source_key, theme_id, feature_type, feature_value, method, score, observed_at),
        )

    def _record_candidate(
        self,
        *,
        candidate_type: str,
        candidate_key: str,
        proposed_theme_id: str | None,
        proposed_label: str,
        description: str,
        source_type: str,
        source_key: str,
        score: int,
        context: dict[str, Any],
        observed_at: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO ontology_candidates(
                 candidate_type, candidate_key, proposed_theme_id, proposed_label,
                 proposed_description, score, sample_context, first_seen_at, last_seen_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(candidate_type, candidate_key) DO UPDATE SET
                 score=greatest(ontology_candidates.score, excluded.score),
                 sample_context=excluded.sample_context,
                 last_seen_at=excluded.last_seen_at""",
            (
                candidate_type,
                candidate_key,
                proposed_theme_id,
                proposed_label,
                description,
                score,
                json.dumps(context, sort_keys=True),
                observed_at,
                observed_at,
            ),
        )
        candidate_id = self.conn.execute(
            "SELECT id FROM ontology_candidates WHERE candidate_type=? AND candidate_key=?",
            (candidate_type, candidate_key),
        ).fetchone()[0]
        self.conn.execute(
            """INSERT INTO ontology_candidate_evidence(candidate_id, source_type, source_key, evidence_score, context, observed_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(candidate_id, source_type, source_key) DO UPDATE SET
                 evidence_score=greatest(ontology_candidate_evidence.evidence_score, excluded.evidence_score),
                 context=excluded.context, observed_at=excluded.observed_at""",
            (candidate_id, source_type, source_key, score, json.dumps(context, sort_keys=True), observed_at),
        )
        self.conn.execute(
            """UPDATE ontology_candidates c SET
                 evidence_count=(SELECT COUNT(*) FROM ontology_candidate_evidence e WHERE e.candidate_id=c.id),
                 source_count=(SELECT COUNT(DISTINCT e.source_type || ':' || e.source_key) FROM ontology_candidate_evidence e WHERE e.candidate_id=c.id),
                 score=(SELECT round(avg(e.evidence_score))::integer FROM ontology_candidate_evidence e WHERE e.candidate_id=c.id)
               WHERE c.id=?""",
            (candidate_id,),
        )

    def _record_candidates(
        self,
        *,
        source_type: str,
        source_key: str,
        candidates: list[dict[str, Any]],
        observed_at: str,
    ) -> None:
        """Upsert every candidate from one source in one database round trip."""
        payload = [
            {
                **candidate,
                "source_type": source_type,
                "source_key": source_key,
                "observed_at": observed_at,
            }
            for candidate in candidates
        ]
        self.conn.execute(
            """WITH incoming AS (
                 SELECT * FROM jsonb_to_recordset(?::jsonb) AS item(
                   candidate_type text, candidate_key text, proposed_theme_id text,
                   proposed_label text, description text, score smallint,
                   context jsonb, source_type text, source_key text, observed_at timestamptz
                 )
               ), upserted AS (
                 INSERT INTO ontology_candidates(
                   candidate_type, candidate_key, proposed_theme_id, proposed_label,
                   proposed_description, score, sample_context, first_seen_at, last_seen_at
                 )
                 SELECT candidate_type, candidate_key, proposed_theme_id, proposed_label,
                        description, score, context, observed_at, observed_at
                 FROM incoming
                 ON CONFLICT(candidate_type, candidate_key) DO UPDATE SET
                   score=greatest(ontology_candidates.score, excluded.score),
                   sample_context=excluded.sample_context,
                   last_seen_at=excluded.last_seen_at
                 RETURNING id, candidate_type, candidate_key
               ), evidence AS (
                 INSERT INTO ontology_candidate_evidence(
                   candidate_id, source_type, source_key, evidence_score, context, observed_at
                 )
                 SELECT u.id, i.source_type, i.source_key, i.score, i.context, i.observed_at
                 FROM upserted u
                 JOIN incoming i USING (candidate_type, candidate_key)
                 ON CONFLICT(candidate_id, source_type, source_key) DO UPDATE SET
                   evidence_score=greatest(ontology_candidate_evidence.evidence_score, excluded.evidence_score),
                   context=excluded.context, observed_at=excluded.observed_at
                 RETURNING candidate_id
               )
               SELECT count(*) FROM evidence""",
            (json.dumps(payload, sort_keys=True),),
        )

    def recalculate_candidate_stats(self) -> None:
        """Refresh aggregate counters after a batch of source writes."""
        self.conn.execute(
            """UPDATE ontology_candidates c SET
                 evidence_count=stats.evidence_count,
                 source_count=stats.source_count,
                 score=stats.score
               FROM (
                 SELECT candidate_id, count(*) AS evidence_count,
                        count(DISTINCT source_type || ':' || source_key) AS source_count,
                        round(avg(evidence_score))::integer AS score
                 FROM ontology_candidate_evidence
                 GROUP BY candidate_id
               ) stats
               WHERE stats.candidate_id=c.id"""
        )

    def _candidate(self, candidate_id: int):
        row = self.conn.execute("SELECT * FROM ontology_candidates WHERE id=? AND status='pending'", (candidate_id,)).fetchone()
        if not row:
            raise ValueError(f"Unknown pending candidate: {candidate_id}")
        return row

    def _promote_membership(self, row, symbol: str, *, learned_by: str) -> None:
        timestamp = utc_now_iso()
        self.conn.execute(
            """INSERT INTO symbol_theme_memberships(
                 symbol, theme_id, confidence, evidence_count, source_count,
                 status, learned_by, first_seen_at, last_seen_at
               ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
               ON CONFLICT(symbol, theme_id) DO UPDATE SET
                 confidence=greatest(symbol_theme_memberships.confidence, excluded.confidence),
                 evidence_count=excluded.evidence_count, source_count=excluded.source_count,
                 status='active', learned_by=excluded.learned_by, last_seen_at=excluded.last_seen_at""",
            (
                symbol,
                row["proposed_theme_id"],
                row["score"],
                row["evidence_count"],
                row["source_count"],
                learned_by,
                row["first_seen_at"],
                timestamp,
            ),
        )
        self.conn.execute(
            "UPDATE ontology_candidates SET status='promoted', reviewed_at=?, review_note=? WHERE id=?",
            (timestamp, learned_by, row["id"]),
        )

    def _promote_theme(self, row, *, learned_by: str, review_note: str | None = None) -> bool:
        theme_id = row["proposed_theme_id"] or slugify(row["proposed_label"]).replace("-", "_")[:80]
        if not theme_id:
            raise ValueError("Theme candidate has no usable identifier")
        existing = self.conn.execute(
            "SELECT status FROM ontology_themes WHERE id=?",
            (theme_id,),
        ).fetchone()
        if existing and existing["status"] in {"blacklisted", "retired", "merged"}:
            if learned_by == "manual":
                raise ValueError(f"Theme {theme_id} is {existing['status']}; restore it before promotion")
            return False

        timestamp = utc_now_iso()
        thesis_id = theme_id
        self.conn.execute(
            """INSERT INTO theses(id, name, summary, status, confidence, time_horizon, created_at, updated_at)
               VALUES (?, ?, ?, 'forming', 40, 'days_to_weeks', ?, ?)
               ON CONFLICT(id) DO NOTHING""",
            (thesis_id, row["proposed_label"], row["proposed_description"], timestamp, timestamp),
        )
        self.conn.execute(
            """INSERT INTO ontology_themes(
                 id, thesis_id, kind, name, description, status, match_threshold,
                 auto_promote_sources, created_by, created_at, updated_at
               ) VALUES (?, ?, 'theme', ?, ?, 'active', 35, 6, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 thesis_id=coalesce(ontology_themes.thesis_id, excluded.thesis_id),
                 status='active', updated_at=excluded.updated_at""",
            (
                theme_id,
                thesis_id,
                row["proposed_label"],
                row["proposed_description"],
                learned_by,
                timestamp,
                timestamp,
            ),
        )
        normalized = normalize_phrase(row["proposed_label"])
        if normalized:
            self.conn.execute(
                """INSERT INTO ontology_terms(
                     theme_id, term, normalized_term, term_type, weight, status,
                     evidence_count, source_count, created_by, created_at, updated_at
                   ) VALUES (?, ?, ?, 'phrase', ?, 'active', ?, ?, ?, ?, ?)
                   ON CONFLICT(theme_id, normalized_term) DO UPDATE SET
                     weight=greatest(ontology_terms.weight, excluded.weight), status='active',
                     evidence_count=excluded.evidence_count, source_count=excluded.source_count,
                     updated_at=excluded.updated_at""",
                (
                    theme_id,
                    row["proposed_label"],
                    normalized,
                    row["score"],
                    row["evidence_count"],
                    row["source_count"],
                    learned_by,
                    timestamp,
                    timestamp,
                ),
            )
        self.conn.execute(
            """UPDATE ontology_candidates
               SET proposed_theme_id=?, status='promoted', reviewed_at=?, review_note=?
               WHERE id=?""",
            (theme_id, timestamp, review_note or learned_by, row["id"]),
        )
        return True

    def _promote_term(self, row, *, learned_by: str) -> None:
        timestamp = utc_now_iso()
        normalized = normalize_phrase(row["proposed_label"])
        self.conn.execute(
            """INSERT INTO ontology_terms(
                 theme_id, term, normalized_term, term_type, weight, status,
                 evidence_count, source_count, created_by, created_at, updated_at
               ) VALUES (?, ?, ?, 'alias', ?, 'active', ?, ?, ?, ?, ?)
               ON CONFLICT(theme_id, normalized_term) DO UPDATE SET
                 weight=greatest(ontology_terms.weight, excluded.weight), status='active',
                 evidence_count=excluded.evidence_count, source_count=excluded.source_count,
                 updated_at=excluded.updated_at""",
            (
                row["proposed_theme_id"],
                row["proposed_label"],
                normalized,
                row["score"],
                row["evidence_count"],
                row["source_count"],
                learned_by,
                timestamp,
                timestamp,
            ),
        )
        self.conn.execute(
            "UPDATE ontology_candidates SET status='promoted', reviewed_at=?, review_note=? WHERE id=?",
            (timestamp, learned_by, row["id"]),
        )
