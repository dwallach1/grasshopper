# ThesisForge Ontology

ThesisForge should build a living graph, not a flat watchlist.

## Core Idea

Every bookmark, article, filing, earnings event, IPO report, Robinhood quote, trade proposal, critic note, and postmortem becomes a node or edge in a local knowledge graph.

The graph is paired with a judgment ledger. Evidence records what a source says; the ledger records what ThesisForge currently believes, what would falsify it, what it predicts, and why it will participate in or abstain from an event.

## Judgment Model

- Each thesis has an explicit `bullish`, `bearish`, or `neutral` stance, a variant perception, and a falsifier.
- Predictions are dated, probabilistic, and resolvable as confirmed, refuted, or expired.
- Insights are derived research objects with novelty and confidence scores. They link back to the graph nodes that produced the synthesis.
- Thesis relations explain how ideas enable, pull through, substitute for, or compete with one another.
- Event decisions are separate from events. They record `participate`, `watch`, or `skip`, the reason, and the trigger for reconsideration.

Run `npm run research:capture -- --help` to add structured judgments, then `npm run ontology:export` to refresh the web snapshot. The hosted dashboard also provides durable quick-capture for insights and predictions.

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
