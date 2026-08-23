# ThesisForge

ThesisForge turns bookmarks, articles, financial data, portfolio state, and
research judgments into a living investment ontology and decision ledger.

## Runtime

Bun 1.4 is the only JavaScript package manager and script orchestrator. Python
remains the runtime for research workers, isolated in `.venv` and invoked
through Bun.

```sh
bun run setup:python
cd web && bun install
```

## Database

Supabase Postgres is the only database and source of truth. Its declarative
schema lives in `supabase/schemas/`; migrations live in `supabase/migrations/`.
All tables use Row Level Security, and trusted jobs connect through the
least-privilege worker URL in `THESISFORGE_DATABASE_URL`.

The hosted dashboard reads `dashboard_snapshots` through its server-only
`SUPABASE_SECRET_KEY`. It deliberately shows an unavailable state when
Supabase cannot be reached—there is no bundled or local database fallback.

After configuring `.env.local` from `.env.example` and applying the Supabase
schema:

```sh
bun run supabase:verify
bun run dashboard:publish
```

## Common workflows

```sh
bun run research:refresh
bun run thesis:report
bun run ontology:report
bun run financial:stats
bun run financial:test
```

The `web/` directory contains the private OpenAI Sites dashboard. Its source is
also included in this managing repository, while the nested Git history remains
available for Sites publishing.
