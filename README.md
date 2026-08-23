# ThesisForge

ThesisForge is a persistent investment-research system that turns bookmarks,
articles, financial data, portfolio state, and research judgments into a living
ontology and decision ledger.

## Database

Supabase Postgres is the canonical database. The schema is declared in
`supabase/schemas/01_thesisforge.sql`; browser roles are denied by default and
all tables have Row Level Security enabled. Trusted local jobs connect through
`THESISFORGE_DATABASE_URL`. The hosted dashboard reads a precomputed snapshot
through a server-only `SUPABASE_SECRET_KEY` and falls back to its bundled
snapshot if Supabase is temporarily unavailable.

Install the pinned Python dependency:

```sh
python3 -m pip install -r requirements.txt
```

Configure `.env.local` from `.env.example`, apply the Supabase schema, then
perform the one-time import:

```sh
npm run db:migrate
npm run ontology:export
```

The importer verifies every table's row count before committing. Keep the
ignored `data/thesisforge.sqlite` file as a rollback copy until the cutover has
been observed through at least one complete scheduled run.

## Common workflows

```sh
npm run research:refresh
npm run thesis:report
npm run ontology:report
npm run financial:stats
npm run financial:test
```

The `web/` directory contains the private OpenAI Sites dashboard. Its source is
also included in this managing repository, while the nested Git history remains
available for Sites publishing.
