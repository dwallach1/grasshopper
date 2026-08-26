# Local Quantanamo terminal

The webapp is a localhost Bloomberg-style desk over the **live Quantanamo ledger** in Supabase (`xqungxapqicdmboniezz`). It does not serve a mock dataset and it does not run ingestion, research, or broker jobs. Cloudflare Workers keep writing the ledger; this app reads those tables and can apply operator mutations (thesis status, evidence, lessons, run notes).

## Requirements

- Bun 1.4+
- A credential that can **read and write** public tables (RLS is deny-by-default for `anon` / `authenticated`)

Use **one** of:

1. `QUANTANAMO_DATABASE_URL` — Postgres URI for the Quantanamo project (Session or transaction pooler, `sslmode=require`). This is the preferred path; the desk uses `postgres.js` server-side.
2. `SUPABASE_SECRET_KEY` — project `service_role` key (Supabase → Project Settings → API). Never prefix with `NEXT_PUBLIC_`. Combined with `SUPABASE_URL`, the desk uses PostgREST.

`anon` / publishable keys cannot see `theses`, `runs`, `trade_intents`, etc. Do not weaken production RLS for the browser. The local Next server holds the secret and never sends it to the client.

## Env

Copy [`.env.example`](.env.example) to the **repo root** `.env.local` (not `apps/dashboard/.env.local`).

```sh
# required for the terminal (pick database URL and/or service_role)
QUANTANAMO_DATABASE_URL=postgresql://postgres.xqungxapqicdmboniezz:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require
SUPABASE_URL=https://xqungxapqicdmboniezz.supabase.co
SUPABASE_SECRET_KEY=  # service_role; optional if DATABASE_URL is set

# local operator identity (manager mutations)
LOCAL_DEV_IDENTITY=local@quantanamo.dev
QUANTANAMO_MANAGER_USER_IDS=local@quantanamo.dev

# optional: trigger Cloudflare workers from the old Run/Refresh API routes
INTERNAL_SERVICE_TOKEN=
QUANTANAMO_KNOWLEDGE_WORKER_URL=https://quantanamo-knowledge-pipeline.davidwallach2.workers.dev
QUANTANAMO_RESEARCH_WORKER_URL=https://quantanamo-research-orchestrator.davidwallach2.workers.dev
```

Do not commit `.env.local`.

## Run

```sh
bun install
bun run web:app
# same as: bun run dev
```

Open `http://127.0.0.1:5173`.

The shell polls `/api/ledger` every 15s. Keyboard: `1-7` panels, `g` then `b/t/r/c/l`, `j/k` thesis, `r` refresh, `/` filter, `?` help.

## Confirm you are on the real ledger

On **MON** / **THES** you should see the eight theses (`neocloud_compute`, `ai_power_nuclear`, `defense_drones_space`, `semis_photonics`, `quantum`, `software_ai_apps`, `crypto`, `biotech_royalty`) with statuses `forming` or `hardening`.

On **BOOK** you should see the Agentic book when the worker has written it (IREN / NBIS / CIFR episodes and filled intents from 2026-08-26).

On **RUNS** you should see `grokbot_live` plus `bookmark_ingest` / cloud workflow rows, and next weekday NY slots (09:35 / 10:05 / 14:35 / 15:05 ET).

On **TEST** you should see `strategy_tests` variants (survived/killed) and `test_scenarios`.

On **CAT** you should see the NVDA / IREN / MRVL / CRDO catalysts and the open `research_queue`.

On **LRN** you should see `research_lessons` and postmortems.

Footer source reads `postgres` or `postgrest` according to which credential you used.

## Mutations (no Worker deploy)

These hit Supabase immediately and show up on the next poll:

| UI | API | Table |
|---|---|---|
| Theses status buttons | `POST /api/ledger/thesis` | `theses.status` |
| Theses evidence form | `POST /api/ledger/evidence` | `thesis_evidence` |
| Learnings form | `POST /api/ledger/lesson` | `research_lessons` (requires an existing `research_cycles` row for that thesis) |
| (API) operator run | `POST /api/ledger/run` | `runs` with `notes` JSON `{ "outcome": "passed"\|"failed"\|"skipped", ... }` |

Example:

```sh
curl -sS -X POST http://127.0.0.1:5173/api/ledger/run \
  -H 'content-type: application/json' \
  -d '{"run_type":"operator_note","outcome":"passed","headline":"Desk check","summary":"Local terminal write path."}'
```

Reload **RUNS**; the row should appear without publishing `dashboard_snapshots` or deploying Workers.

## What this app does not do

- It does not place trades or call Robinhood.
- It does not ingest X bookmarks or run Workers AI.
- Optional `POST /api/system/run` and `/api/system/refresh-account` still trigger Cloudflare Workers when `INTERNAL_SERVICE_TOKEN` and worker URLs are set.

## Tests

```sh
bun run --cwd apps/dashboard test
```
