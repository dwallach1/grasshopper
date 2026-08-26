# Local Quantanamo terminal

The webapp is a localhost Bloomberg-style desk over the **live Quantanamo ledger** in Supabase (`xqungxapqicdmboniezz`). It does not serve a mock dataset and it does not run ingestion, research, or broker jobs. Cloudflare Workers keep writing the ledger; this app reads those tables and can apply operator mutations (thesis status, evidence, lessons, run notes).

## Requirements

- Bun 1.4+
- Supabase Auth with **OAuth and/or passkeys** enabled on project `xqungxapqicdmboniezz`
- The **publishable / anon** key in the browser (`NEXT_PUBLIC_*`). Never put `service_role` or `QUANTANAMO_DATABASE_URL` in `NEXT_PUBLIC_*`.

Signed-out, the desk shows a sign-in screen and does not load theses, book, or runs. After sign-in, PostgREST runs as that user. RLS allows only rows in `public.ledger_operators`. The first confirmed sign-in claims an empty allowlist; later accounts need a SQL insert.

Workers still use `QUANTANAMO_DATABASE_URL` / `service_role` on the server. That path is not the watch-the-agent UX.

## Supabase Auth setup

In the Supabase dashboard for `xqungxapqicdmboniezz`:

1. **Authentication → URL configuration**
   - Site URL: `http://127.0.0.1:5173`
   - Redirect allow-list: `http://127.0.0.1:5173/auth/callback`
2. **Authentication → Providers** — enable the OAuth apps you use (GitHub and Google are the desk defaults). Set `NEXT_PUBLIC_AUTH_OAUTH_PROVIDERS` if you enabled others (`github,google,azure`).
3. **Authentication → Passkeys** — enable passkeys. Relying party ID `127.0.0.1` (or `localhost`) and origin `http://127.0.0.1:5173`. Register a passkey from the desk header (`Passkey+`) after the first OAuth sign-in; later you can sign in with **Passkey** alone.

Add another operator after the first claim:

```sql
insert into public.ledger_operators(user_id, email)
select id, email from auth.users where email = 'you@example.com';
```

## Env

Copy [`.env.example`](.env.example) to the **repo root** `.env.local` (not `apps/dashboard/.env.local`).

```sh
# required for sign-in (public)
NEXT_PUBLIC_SUPABASE_URL=https://xqungxapqicdmboniezz.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=  # Project Settings → API → publishable / anon
# optional: comma list, default github,google
NEXT_PUBLIC_AUTH_OAUTH_PROVIDERS=github,google

# optional, server-only — workers / ontology RPC / postgres.js
QUANTANAMO_DATABASE_URL=postgresql://quantanamo_worker.xqungxapqicdmboniezz:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require
SUPABASE_URL=https://xqungxapqicdmboniezz.supabase.co
SUPABASE_SECRET_KEY=  # service_role; never NEXT_PUBLIC_*

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

Open `http://127.0.0.1:5173`. Sign in. Header source should read `postgrest`.

The shell polls `/api/ledger` every 15s (session cookie). Keyboard: `1-7` panels, `g` then `b/t/r/c/l`, `j/k` thesis, `r` refresh, `/` filter, `?` help.

## Confirm you are on the real ledger

Logged **out**: sign-in only. `/api/ledger` returns 401. No thesis names in the HTML.

Logged **in**:

On **MON** / **THES** you should see the eight theses (`neocloud_compute`, `ai_power_nuclear`, `defense_drones_space`, `semis_photonics`, `quantum`, `software_ai_apps`, `crypto`, `biotech_royalty`) with statuses `forming` or `hardening`.

On **BOOK** you should see the Agentic book when the worker has written it (IREN / NBIS / CIFR episodes and filled intents from 2026-08-26).

On **RUNS** you should see `grokbot_live` plus `bookmark_ingest` / cloud workflow rows, and next weekday NY slots (09:35 / 10:05 / 14:35 / 15:05 ET).

On **TEST** you should see `strategy_tests` variants (survived/killed) and `test_scenarios`.

On **CAT** you should see the NVDA / IREN / MRVL / CRDO catalysts and the open `research_queue`.

On **LRN** you should see `research_lessons` and postmortems.

## Mutations (no Worker deploy)

These hit Supabase as the signed-in operator and show up on the next poll:

| UI | API | Table |
|---|---|---|
| Theses status buttons | `POST /api/ledger/thesis` | `theses.status` |
| Theses evidence form | `POST /api/ledger/evidence` | `thesis_evidence` |
| Learnings form | `POST /api/ledger/lesson` | `research_lessons` (requires an existing `research_cycles` row for that thesis) |
| (API) operator run | `POST /api/ledger/run` | `runs` with `notes` JSON `{ "outcome": "passed"\|"failed"\|"skipped", ... }` |

`curl` without the session cookie is 401. Use the UI, or pass the browser cookie.

## What this app does not do

- It does not place trades or call Robinhood.
- It does not ingest X bookmarks or run Workers AI.
- Optional `POST /api/system/run` and `/api/system/refresh-account` still trigger Cloudflare Workers when `INTERNAL_SERVICE_TOKEN` and worker URLs are set (still requires a signed-in operator).

## Tests

```sh
bun run --cwd apps/dashboard test
```

Auth gate checklist:

1. Restart `bun run web:app` after setting `NEXT_PUBLIC_*`.
2. Logged out: `/` is sign-in; `/api/ledger` is 401; HTML has no `neocloud_compute`.
3. Sign in with OAuth; first user becomes the operator.
4. MON/BOOK/THES load live rows. Header shows your email. **Sign out** returns to the gate.
5. **Passkey+** then sign out and **Passkey** sign-in.
6. Thesis evidence / status from the UI writes without `SUPABASE_SECRET_KEY` in the client bundle.
