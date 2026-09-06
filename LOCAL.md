# Local Quantanamo terminal

The webapp is a localhost Bloomberg-style desk over the **live Quantanamo ledger** in Supabase (`xqungxapqicdmboniezz`). It does not serve a mock dataset and it does not run ingestion, research, or broker jobs.

**QUANTANAMO (Grok Bot) is the only live automation.** It reads X through the X connector and trades through Robinhood, then writes canonical tables (`runs`, `account_snapshots`, `theses`, `position_episodes`, …). ODDSBORNE `pm_*` rows (Polymarket) and BANDIT `meme_*` rows (coins) land on the same Book / Theses / Events chrome via venue chips when present. The public phone desk (`bun run desk:deploy`) is a read-only snapshot — see the README Public phone desk section. Cloudflare ingest workers and the old ThesisForge / Codex pipeline are retired from this desk: do not reconnect X OAuth here, do not press Run on a knowledge worker, and do not treat Cloudflare cron as due.

## Requirements

- Bun 1.4+
- Supabase Auth with **OAuth and/or passkeys** enabled on project `xqungxapqicdmboniezz`
- The **publishable / anon** key in the browser (`NEXT_PUBLIC_*`). Never put `service_role` or `QUANTANAMO_DATABASE_URL` in `NEXT_PUBLIC_*`.

Signed-out, the desk shows a sign-in screen and does not load theses, book, or runs. After sign-in, PostgREST runs as that user. RLS allows only rows in `public.ledger_operators`. The first confirmed sign-in is claimed via `claim_ledger_operator` when that table is empty; later accounts need a `ledger_operators` row (SQL insert). `private.is_ledger_operator()` is `SECURITY DEFINER` so the signed-in JWT can see that row under RLS; the public wrapper is `SECURITY INVOKER` so it is not an exposed definer RPC. Without the private helper the desk shows "This account is not on the operator allowlist" even when the row exists.

Optional worker / postgres.js env (`QUANTANAMO_DATABASE_URL`, `SUPABASE_SECRET_KEY`) is server-only and is not required to watch the agent.

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
- [`supabase/migrations/20260827142807_lock_exposed_security_definer_rpcs.sql`](supabase/migrations/20260827142807_lock_exposed_security_definer_rpcs.sql) (public operator RPCs are INVOKER wrappers; ontology write RPC dropped)

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
```

Do not commit `.env.local`. Worker URLs / `INTERNAL_SERVICE_TOKEN` are unused by the desk chrome.

## Run

```sh
bun install
bun run web:app
# same as: bun run dev
```

Open `http://localhost:5173` (this is the printed Local URL, the Auth Site URL, and the passkey RP ID). `http://127.0.0.1:5173` works for email **if you start and finish on that IP** — passkeys still require `localhost`. Sign in. Header source should read `postgrest`.

Tabs are spelled-out words: **Board, Book, Theses, Events, Tests, Team**. **Board** is the landing page at `/` — Liveline % curves in native units (`/leaderboard` redirects here). **Book** is `/book`. The chrome stays mounted; tab switches paint from the in-memory ledger payload (`history.pushState`, no refetch). Keyboard: `1-6` panels, `g` then letter (`p/b/t/c/e/m`), `j/k` thesis, `r` refresh, `?` help. There is no filter box. Last QUANTANAMO run is a header chip, not a tab. See `docs/liveline-pnl.md`.

## Confirm you are on the real ledger

Logged **out**: sign-in only. `/api/ledger` returns 401. No thesis names in the HTML.

Logged **in**:

On **Board** (`/`) Liveline draws each steward’s ledger series (Agentic NAV, `pm_pnl`, `meme_pnl`). On **Book** (`/book`) the hero is that same equity line in native units; lots stay a quiet table. Not `dashboard_snapshots.current`, and not `position_episodes`. Missing marks stay **not in ledger**. A refresh (or the 15s poll / realtime) picks up a new QUANTANAMO snapshot without a restart. The fill log is `broker_fills` when present, otherwise filled `trade_intents`, newest first. Empty fills say **not in ledger**. Sparse snapshots are honest — the desk does not invent prints.

Each thesis with an open lot shows that lot from the **same** 7638 snapshot, joined through `trade_proposals` (filled/approved/submitted/open) or `thesis_symbols.role = held`. Watchlist tags do not count. A thesis with no open lot still renders as **no position** on Theses.

On **Theses** you should see the eight theses (`neocloud_compute`, `ai_power_nuclear`, `defense_drones_space`, `semis_photonics`, `quantum`, `software_ai_apps`, `crypto`, `biotech_royalty`) with statuses `forming` or `hardening`, plus held/candidate symbols and a lessons pane.

On **Events** you should see the NVDA / IREN / MRVL / CRDO catalysts and the open `research_queue` (not AI-filtered). `/catalysts` redirects here.

On **Tests** you should see every `strategy_tests` row (including old seed keys like `ai-power-base`). Selecting a row opens a detail pane on the same tab: `summary_json`, equity curve (`chart_svg` or `equity_curve`), trades, params, and Financial Datasets `price_source`. Rows with no `backtest_artifacts` say **no artifacts in ledger** — the desk never draws a fake curve. Null metrics say **not in ledger**.

The desk is **read-only**. QUANTANAMO writes the ledger. Sign-in stays as the operator gate. There are no thesis status buttons, evidence/lesson forms, or other operator RPCs that insert/update/delete ledger rows.

The **public phone desk** is a different build: `NEXT_PUBLIC_DESK_MODE=public` or the Cloudflare Worker `quantanamo-desk`. It reads a published snapshot (`/api/desk`) and never signs in. See the README **Public phone desk** section. Do not point the public SPA at PostgREST. `desk:publish` reads `meme_*` / `pm_*` as `quantanamo_worker` — those tables need `quantanamo_worker_select` RLS, not just `GRANT SELECT`.

`curl` without the session cookie is 401. `POST /api/ledger/thesis|evidence|lesson|run` returns 410.

## What this app does not do

- It does not place trades or call Robinhood.
- It does not ingest X bookmarks or run Workers AI.
- `/api/x/authorize` is retired (410). QUANTANAMO reads X via the X connector.
- `POST /api/system/run`, `/api/system/refresh-account`, and `/api/ontology/manage` return 410. The desk does not write.

## Tests

```sh
bun run --cwd apps/dashboard test
```

Auth gate checklist:

1. Restart `bun run web:app` after setting `NEXT_PUBLIC_*`.
2. Logged out: `/` is sign-in; `/api/ledger` is 401; HTML has no `neocloud_compute`.
3. Sign in with the **email magic link** (or a social provider once it is enabled). First confirmed user is claimed via `claim_ledger_operator`. Later accounts need a `ledger_operators` row.
4. Book / Theses / Events load live rows. Header shows your email. **Sign out** returns to the gate.
5. Tab switches (1–5 or click) paint immediately from cached data; the filter box is gone.
6. **Passkey+** then sign out and **Passkey** sign-in.
7. Theses have no write controls. Status, evidence, and lessons are ledger reads.
