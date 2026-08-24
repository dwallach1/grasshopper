# ThesisForge Ontology

ThesisForge should build a living graph, not a flat watchlist.

## Core Idea

Every bookmark, article, filing, earnings event, IPO report, Robinhood quote, trade proposal, critic note, and postmortem becomes a node or edge in the persistent Supabase knowledge graph.

The graph is paired with a judgment ledger. Evidence records what a source says; the ledger records what ThesisForge currently believes, what would falsify it, what it predicts, and why it will participate in or abstain from an event.

## Judgment Model

- Each thesis has an explicit `bullish`, `bearish`, or `neutral` stance, a variant perception, and a falsifier.
- Predictions are dated, probabilistic, and resolvable as confirmed, refuted, or expired.
- Insights are derived research objects with novelty and confidence scores. They link back to the graph nodes that produced the synthesis.
- Thesis relations explain how ideas enable, pull through, substitute for, or compete with one another.
- Event decisions are separate from events. They record `participate`, `watch`, or `skip`, the reason, and the trigger for reconsideration.

Run `bun run research:capture -- --help` to add structured judgments, then `bun run dashboard:publish` to refresh the canonical dashboard snapshot in Supabase. The hosted dashboard also provides durable quick-capture for insights and predictions.

## Closed-Loop Research

Every strategy idea can move through `research → code → backtest → live → postmortem → fine-tune` as a durable research cycle.

- The expected outcome is preregistered before testing.
- Specialist research runs may be isolated from one another and blinded to current price to reduce anchoring.
- The breaker is a separate adversarial role. It applies doubled transaction costs and adverse historical regimes.
- Risk limits are stored as code-enforced controls, never prompt-only guidance.
- Every tested variant and scenario survives as data, including killed variants and their autopsies.
- Postmortems create persistent lessons tagged with the market regime where the failure occurred.
- A lesson remains an open loop until it has been incorporated into the next research cycle.

The graph should answer:

- What themes are forming?
- Which tickers are linked to multiple independent concepts?
- Which upcoming events could reprice those concepts?
- Which theses are hardening or softening?
- Which exposures do we already have elsewhere?
- Which asymmetric swing setups are emerging?

## Adaptive Taxonomy

Themes and ticker baskets are data, not Python constants. Supabase owns:

- `ontology_themes`: active, candidate, merged, retired, and blacklisted themes or concepts.
- `ontology_terms`: weighted keywords, aliases, phrases, entities, and negative terms.
- `symbol_theme_memberships`: evidence-backed relationships between verified symbols and themes.
- `ontology_observations` and `ontology_evidence`: the source-level audit trail behind classification.
- `ontology_candidates` and `ontology_candidate_evidence`: observable proposed themes, vocabulary, and memberships with their source trail.
- `ontology_lexicon`: ignored uppercase tokens, market-scoring vocabulary, and learning stopwords.

The default candidate queue suppresses one-off observations, URL tokens, unverified uppercase prose, and weak single-word theme clusters. The underlying evidence remains queryable for audit and future rescoring.

Bookmark, article, and event ingestion first matches active database terms and symbol memberships. New symbols are persisted with `candidate` status. Repeated co-occurrence creates membership or vocabulary candidates; only verified symbols and sufficiently distinctive, multi-source evidence can auto-promote. Repeated source clusters that do not resemble an active theme create a new `candidate` theme, which activates autonomously after six independent sources and a higher score threshold. Managers can promote, demote, restore, or blacklist themes and symbols through the hosted ontology manager; blacklists are enforced by ingestion and classification, but no manager action is required for learning to continue.

```sh
bun run ontology:learn
bun run ontology:candidates
bun run cli -- ontology verify-symbol SYMBOL
bun run cli -- ontology approve CANDIDATE_ID
bun run cli -- ontology add-theme theme_id "Theme name" --status active
bun run cli -- ontology add-term theme_id "learned phrase"
bun run cli -- ontology add-membership theme_id SYMBOL --relationship beneficiary
bun run cli -- ontology add-lexicon "low information phrase" --type candidate_stopword
```

The initial vocabulary in `supabase/seed.sql` is only a bootstrap. Once loaded, taxonomy growth and review happen through Supabase records rather than code edits.

## Durable Source Archive

Supabase Storage preserves immutable originals in the private
`research-originals` bucket. Storage holds bytes; Postgres remains the canonical
index and judgment layer:

- `research_documents` records the SHA-256 checksum, private object path, MIME
  type, extraction state, and searchable text.
- `research_document_sources` connects one deduplicated original to its URLs,
  article record, publisher, and mutable usefulness judgment.
- `research_document_annotations` records sentiment and evidence role per
  market, symbol, theme, or thesis with provenance and model version.

Paths use `<document-type>/<year>/<month>/<sha256>.<extension>`. They never
encode `bullish`, `bearish`, `useful`, a ticker, or a theme because those
judgments overlap and change. Article-linked originals retain the existing
`source:article:<id>` ontology key; standalone documents use
`source:document:<id>`, preventing the same evidence from inflating independent
source counts.

```sh
bun run documents:setup
bun run cli -- documents archive URL_OR_FILE --usefulness useful
bun run cli -- documents verify DOCUMENT_ID
bun run documents:status
```

## Node Types

- `concept`: AI power, neoclouds, nuclear fuel, photonics, defense autonomy, crypto AI.
- `symbol`: Robinhood-validated ticker or crypto pair.
- `thesis`: A tradable hypothesis with horizon, catalyst, invalidation, and confidence.
- `event`: Earnings, IPO, lockup expiry, product launch, investor day, filing, policy event.
- `source`: X bookmark, linked article, SEC filing, 13F, company press release, web article.
- `agent_view`: Bull case, bear case, portfolio-risk critic, postmortem.
- `trade`: Proposed, reviewed, placed, exited, rejected.

## Edge Types

- `supports`: Source or agent view strengthens a thesis.
- `contradicts`: Evidence weakens a thesis.
- `mentions`: Source mentions a symbol/concept/event.
- `catalyzes`: Event can move a symbol/thesis.
- `exposes`: Portfolio already has exposure to a symbol/concept.
- `substitutes`: One symbol is an alternate expression of a thesis.
- `depends_on`: A thesis depends on a macro/event/company claim.
- `learned_from`: Postmortem updates a thesis after outcome.

## Confidence

Confidence should not be simple popularity. Link thickness should combine:

- Independent source count
- Source quality
- Recency
- Robinhood validation
- Event proximity
- Price/volume confirmation
- Cross-agent agreement
- Portfolio fit
- Postmortem reliability

A thick link from five low-quality X posts should be weaker than a thinner link from one official filing plus Robinhood data plus bull/bear agreement.

## Dormant Research Loop

When markets are closed, ThesisForge should:

1. Refresh X bookmarks and linked articles.
2. Search for upcoming earnings, IPOs, filings, 13Fs, lockups, investor days, and policy events.
3. Add event nodes and link them to concepts and symbols.
4. Ask subagents for bull, bear, and portfolio-risk views.
5. Harden/soften theses and update confidence.
6. Prepare event watchlists for the next market session.

## Nscale Example

Nscale is not currently a Robinhood-tradable public ticker, but it is an important event node:

- Concept links: neocloud compute, AI data centers, power bottlenecks, GPU infrastructure.
- Potential public comps: NBIS, CRWV, IREN, VST, CEG, GEV, AAOI, COHR.
- Event links: possible U.S. IPO, contracted revenue claims, Anyscale acquisition, power commitments.
- Trading use: watch public comps before/after the IPO roadshow or filing, not direct Nscale unless/when tradable.
