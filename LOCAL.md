# Local Quantanamo terminal

The webapp is a localhost Bloomberg-style desk over the **live Quantanamo ledger** in Supabase (`xqungxapqicdmboniezz`). It does not serve a mock dataset and it does not run ingestion, research, or broker jobs. Cloudflare Workers keep writing the ledger; this app reads those tables and can apply operator mutations (thesis status, evidence, lessons, run notes).

## Requirements

- Bun 1.4+
- Supabase Auth with **OAuth and/or passkeys** enabled on project `xqungxapqicdmboniezz`
- The **publishable / anon** key in the browser (`NEXT_PUBLIC_*`). Never put `service_role` or `QUANTANAMO_DATABASE_URL` in `NEXT_PUBLIC_*`.

Signed-out, the desk shows a sign-in screen and does not load theses, book, or runs. After sign-in, PostgREST runs as that user. RLS allows only rows in `public.ledger_operators`. The first confirmed sign-in is claimed via `claim_ledger_operator` when that table is empty; later accounts need a `ledger_operators` row (SQL insert). `is_ledger_operator()` is `SECURITY DEFINER` so the signed-in JWT can see that row under RLS — without it the desk shows "This account is not on the operator allowlist" even when the row exists.

Workers still use `QUANTANAMO_DATABASE_URL` / `service_role` on the server. That path is not the watch-the-agent UX.

## Supabase Auth setup

Live GoTrue settings on `xqungxapqicdmboniezz` (2026-08-26): **passkeys on**, **email on**, GitHub/Google **off** until you add client IDs. The desk reads `/auth/v1/settings` and only shows working buttons.

In the Supabase dashboard:

1. **Authentication → URL configuration**
   - Site URL **must** be `http://localhost:5173` (not the GoTrue default `http://localhost:3000`). If Site URL stays on `:3000`, PKCE `/token` runs against that host and the desk on `:5173` never keeps the session.
   - Redirect allow-list (add **both** callback origins — `localhost` and `127.0.0.1` are different cookie hosts):
     - `http://localhost:5173/auth/callback`
     - `http://127.0.0.1:5173/auth/callback`
     - `http://localhost:5173/**`
     - `http://127.0.0.1:5173/**`
2. **Authentication → Providers → Email** — leave enabled. First-time operators use **Send magic link**. Confirm the mailer delivers (hosted SMTP). Open the desk at **`http://localhost:5173`**, send the link from that origin, and open the email link so it returns to `/auth/callback` on the **same** host. Switching `localhost` ↔ `127.0.0.1` drops the PKCE code verifier. A failed exchange redirects to `/?auth_error=…` on the gate — never a silent re-lock.
3. **Authentication → Passkeys** — enable. Relying party ID **`localhost`** (not `127.0.0.1` — browsers reject IP RP IDs) and origin `http://localhost:5173`. Open the desk at `http://localhost:5173`. After the first email (or OAuth) sign-in, use **Passkey+** in the header. Later you can sign in with **Passkey** alone. Passkeys cannot be the first-ever account.
4. **Authentication → Providers** (optional social OAuth) — enable GitHub and/or Google with a real OAuth app. The sign-in screen picks them up automatically. Set `NEXT_PUBLIC_AUTH_OAUTH_PROVIDERS` only to reorder (`google,github`).

Add another operator after the first `claim_ledger_operator` (empty allowlist only):

```sql
insert into public.ledger_operators(user_id, email)
select id, email from auth.users where email = 'you@example.com';
```

Operator RLS is **already applied** on `xqungxapqicdmboniezz` (`anon` remains revoked):

- [`supabase/migrations/20260826200000_ledger_operator_auth.sql`](supabase/migrations/20260826200000_ledger_operator_auth.sql)
- [`supabase/migrations/20260826215510_is_ledger_operator_security_definer.sql`](supabase/migrations/20260826215510_is_ledger_operator_security_definer.sql) (`is_ledger_operator` SECURITY DEFINER + `ledger_operators_self_select`)

Service role / `quantanamo_worker` still bypass RLS for Cloudflare Workers.

## Env

Copy [`.env.example`](.env.example) to the **repo root** `.env.local` (not `apps/dashboard/.env.local`).

```sh
# required for sign-in (public)
NEXT_PUBLIC_SUPABASE_URL=https://xqungxapqicdmboniezz.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=  # Project Settings → API → publishable / anon
# alias: NEXT_PUBLIC_SUPABASE_ANON_KEY=  (legacy JWT anon key; never service_role)
# optional: reorder social buttons when those providers are enabled
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

Open `http://localhost:5173` (this is the printed Local URL, the Auth Site URL, and the passkey RP ID). `http://127.0.0.1:5173` works for email **if you start and finish on that IP** — passkeys still require `localhost`. Sign in. Header source should read `postgrest`.

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
3. Sign in with the **email magic link** (or a social provider once it is enabled). First confirmed user is claimed via `claim_ledger_operator`. Later accounts need a `ledger_operators` row.
4. MON/BOOK/THES load live rows. Header shows your email. **Sign out** returns to the gate.
5. **Passkey+** then sign out and **Passkey** sign-in.
6. Thesis evidence / status from the UI writes without `SUPABASE_SECRET_KEY` in the client bundle.
