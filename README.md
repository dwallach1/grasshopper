# ThesisForge

ThesisForge turns bookmarks, articles, financial data, portfolio state, and
research judgments into a living investment ontology and decision ledger.

## Runtime

Bun 1.4 is the JavaScript package manager and task orchestrator. Python research
workers live in the installable `src/thesisforge/` package, are isolated in
`.venv`, and are invoked through one `thesisforge` command surface.

```sh
bun run setup:python
cd web && bun install
```

The X OAuth and bookmark commands remain small Bun entry points under
`scripts/x/`. Shared X API and token behavior lives in `scripts/x/client.mjs`;
bookmark ingestion crosses into Python through `python -m thesisforge` rather
than a hardcoded worker script.

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
bun run ontology:learn
bun run ontology:candidates
bun run financial:stats
bun run financial:test
```

To inspect the unified Python command surface or invoke a worker directly:

```sh
bun run cli -- --help
.venv/bin/python -m thesisforge ontology report
.venv/bin/python -m thesisforge research capture --help
```

Python tests live in `tests/` and can be run together with `bun run test`.

The `web/` directory contains the private OpenAI Sites dashboard. Its source is
also included in this managing repository, while the nested Git history remains
available for Sites publishing.
