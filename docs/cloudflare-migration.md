# Cloudflare migration

ThesisForge's production runtime is Cloudflare-first. Supabase remains the canonical relational database, but no production path depends on Python, a laptop, local Cron, or a Codex automation.

## Final ownership model

| Worker | Owns | Does not own |
|---|---|---|
| `thesisforge-dashboard` | Private UI, Access identity verification, authenticated operator routes, read-only dashboard projection | Scheduling, ingestion, model decisions, broker state |
| `thesisforge-knowledge-pipeline` | X OAuth/token rotation, bookmark sync, article/PDF extraction, R2 archival, ontology learning/graph refresh, financial-data cache, research capture, projection refresh after knowledge mutations | Trading decisions or broker tools |
| `thesisforge-research-orchestrator` | Market-slot schedule, durable research Workflow, Workers AI tasks, position decisions, trade-intent coordination, projection refresh when a run becomes terminal | Source ingestion, X credentials, broker OAuth |
| `thesisforge-broker-gateway` | Robinhood MCP OAuth, read/review/place allowlist, final deterministic broker enforcement | Research or source ingestion |

The old `thesisforge-dashboard-publication` name was misleading: that Worker had become the research control plane. It is replaced by `thesisforge-research-orchestrator`. Dashboard publication is now a shared event-driven read-model update after canonical mutations and terminal research runs; it has no independent Cron.

## Data ownership

- Supabase Postgres is canonical for bookmarks, research, ontology, decisions, portfolio state, audit rows, and `dashboard_snapshots`.
- Hyperdrive connects the knowledge Worker using the dedicated least-privilege database role.
- New immutable source originals are content-addressed in private Cloudflare R2.
- Legacy objects remain readable from Supabase Storage and are identified by `research_documents.storage_provider='supabase'`; new objects use `'r2'`.
- Durable Object SQLite owns only serialized coordination, OAuth state/tokens, deduplication, and broker connection state.
- X and Robinhood refresh tokens never enter Postgres.

## Knowledge pipeline

A 30-minute Cron calls the single `XCredentialVault` Durable Object. The object serializes syncs, refreshes rotating OAuth credentials, and fetches bounded X pages. One Postgres transaction then:

1. upserts bookmarks, URLs, verified symbol evidence, and claims;
2. classifies source text against database-owned themes, terms, memberships, and lexicon;
3. records ontology observations, evidence, and reviewable candidates;
4. updates thesis evidence/scores and promotes candidates that meet source-quality gates;
5. enqueues previously unseen URLs.

The article Queue follows redirects defensively, rejects private-network destinations, caps response bytes, extracts HTML/text/PDF content in the Worker runtime, writes immutable bytes to R2, and commits queryable metadata/extracted text to Postgres. Queue failures retry with exponential delay and end in a DLQ.

Paid financial requests are never scheduled. They are available only through the authenticated internal API, use endpoint-specific TTLs, persist the purchased response before normalization, and serve fresh cached bytes whenever possible.

## Research and execution pipeline

Paired UTC Cron candidates admit exactly 10:05, 13:05, and 15:25 America/New_York on weekdays. `CloudResearchWorkflow` creates canonical `cloud_runs`/`cloud_tasks`, skips unchanged thesis hashes, fans out through the research Queue, and persists every typed result. Deterministic TypeScript policy—not the model—owns eligibility and sizing.

Any proposed trade passes through Supabase kill switches, account-scoped serialization, and `RobinhoodBrokerAgent`. The Agent refreshes account state and enforces the exact equity read/review/place allowlist immediately before submission. Unsupported tools and products fail closed.

When all tasks are terminal, run finalization immediately rebuilds the `current` dashboard snapshot. Knowledge mutations do the same after their transaction succeeds.

## Security boundaries

- Dashboard traffic is protected by Cloudflare Access and application-level identity verification.
- The knowledge Worker has no public route; dashboard calls use a service binding plus a shared internal token.
- Cloudflare stores the Hyperdrive connection, X OAuth values, and internal tokens as encrypted secrets or bindings. The optional paid financial-data API remains disabled until `FINANCIAL_DATASETS_API_KEY` is configured.
- Supabase Edge Functions retain the service-role key; Workers receive only narrow publication/control tokens.
- R2 is private and has no public development URL or custom domain.
- Worker HTTP responses are bounded and no secrets are logged.
- Trading and position-management risk controls are independent emergency stops.

## Validation and cutover

Cutover completed on 2026-08-24. The Cloudflare Worker dashboard is the sole repository deployment target; the former Sites integration, misleading publication Worker/Workflows, root Python package, Python test/configuration files, and local X scripts have been removed.

A release is complete only after:

1. TypeScript typechecks and unit/policy tests pass.
2. the dashboard production build and all three non-UI Worker Wrangler configurations complete successfully;
3. the declarative Supabase schema and remote migration history agree;
4. Hyperdrive can execute a scoped read/write transaction;
5. a manual X sync advances the bookmark import timestamp;
6. article Queue messages archive to R2 and clear their canonical backlog;
7. the dashboard projection advances after both a knowledge mutation and a terminal research run;
8. duplicate Cron/Queue delivery is harmless;
9. the old publication Worker and local Python/X runtime are removed only after the live checks pass.

The cutover validation on 2026-08-24 confirmed live X token refresh and bookmark ingestion, Hyperdrive writes, Queue delivery and retry, private R2 archival, event-driven dashboard publication, Durable Object state transfer, and a completed non-actionable smoke instance of `thesisforge-research-cycle`. The one-minute sync cadence used during validation was restored to 30 minutes.

## Emergency stop

Pause either Supabase risk control (`autonomous-execution` or `autonomous-position-management`) for the fastest canonical stop. For defense in depth, deploy `TRADING_ENABLED=false` on `thesisforge-research-orchestrator` and `BROKER_EXECUTION_ENABLED=false` on `thesisforge-broker-gateway`. Disconnecting Robinhood MCP is the broker-boundary stop. Never delete audit rows.
