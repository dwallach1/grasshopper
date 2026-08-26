# Cloudflare Workers runtime

Quantanamo's production research and trading path runs on Cloudflare Workers. Supabase remains the canonical relational database. The desk UI (`apps/dashboard`) runs only locally and reads Supabase; it is not deployed to Cloudflare.

## Ownership model

| Component | Owns | Does not own |
|---|---|---|
| `apps/dashboard` (local) | Local desk UI and ontology manager actions against Supabase | Scheduling, ingestion, model decisions, broker state, Cloudflare hosting |
| `quantanamo-knowledge-pipeline` | X OAuth/token rotation, bookmark sync, Workers AI semantic ontology analysis, article/PDF extraction, R2 archival, ontology promotion/graph refresh, financial-data cache, research capture, projection refresh after knowledge mutations | Trading decisions or broker tools |
| `quantanamo-research-orchestrator` | Market-slot schedule, durable research Workflow, Workers AI tasks, position decisions, trade-intent coordination, projection refresh when a run becomes terminal | Source ingestion, X credentials, broker OAuth |
| `quantanamo-broker-gateway` | Robinhood MCP OAuth, read/review/place allowlist, final deterministic broker enforcement | Research or source ingestion |

The old `quantanamo-dashboard` Worker (vinext + Workers Assets) was removed. Dashboard publication remains a shared event-driven read-model update after canonical mutations and terminal research runs; it has no independent Cron.

## Data ownership

- Supabase Postgres is canonical for bookmarks, research, ontology, decisions, portfolio state, audit rows, and `dashboard_snapshots`.
- Hyperdrive connects the knowledge Worker using the dedicated least-privilege database role.
- New immutable source originals are content-addressed in private Cloudflare R2.
- Legacy objects remain readable from Supabase Storage and are identified by `research_documents.storage_provider='supabase'`; new objects use `'r2'`.
- Durable Object SQLite owns only serialized coordination, OAuth state/tokens, deduplication, and broker connection state.
- X and Robinhood refresh tokens never enter Postgres.

## Knowledge pipeline

A Cron calls the single `XCredentialVault` Durable Object. The object serializes syncs, refreshes rotating OAuth credentials, and fetches bounded X pages. The Worker loads the active ontology and bookmarks whose model/prompt version is stale, then sends bounded batches to Workers AI through AI Gateway. Invalid, incomplete, or source-ungrounded model output aborts the learning run. A short Postgres transaction then upserts evidence, records ontology observations, and enqueues previously unseen URLs.

Paid financial requests are never scheduled. They are available only through the authenticated internal Worker API (service binding / internal token), use endpoint-specific TTLs, and serve fresh cached bytes whenever possible. Operator tooling uses `bun run cloud:sync` and Worker deploy scripts—not the local webapp.

## Research and execution pipeline

Paired UTC Cron candidates admit the New York decision windows on weekdays. `CloudResearchWorkflow` creates canonical `cloud_runs`/`cloud_tasks`, skips unchanged thesis hashes, fans out through the research Queue, and persists every typed result. Deterministic TypeScript policy—not the model—owns eligibility and sizing.

Any proposed trade passes through Supabase kill switches, account-scoped serialization, and `RobinhoodBrokerAgent`. When all tasks are terminal, run finalization rebuilds the `current` dashboard snapshot. Knowledge mutations do the same after their transaction succeeds.

## Security boundaries

- The local desk is localhost-only; it is not behind Cloudflare Access.
- The knowledge Worker has no public route; internal callers use a shared internal token (research/knowledge bindings).
- Account-shared credentials live in Cloudflare Secrets Store: `INTERNAL_SERVICE_TOKEN` and `QUANTANAMO_PUBLICATION_TOKEN` for knowledge/research, `FINANCIAL_DATASETS_API_KEY` only for knowledge.
- Supabase Edge Functions retain the service-role key; Workers receive only narrow publication/control tokens.
- R2 is private and has no public development URL or custom domain.
- Trading and position-management risk controls are independent emergency stops.

## Emergency stop

Pause either Supabase risk control (`autonomous-execution` or `autonomous-position-management`) for the fastest canonical stop. For defense in depth, deploy `TRADING_ENABLED=false` on `quantanamo-research-orchestrator` and `BROKER_EXECUTION_ENABLED=false` on `quantanamo-broker-gateway`. Disconnecting Robinhood MCP is the broker-boundary stop. Never delete audit rows.
