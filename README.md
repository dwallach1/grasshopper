```
  ___  _   _    _    _   _ _____    _    _   _    _    __  __  ___
 / _ \| | | |  / \  | \ | |_   _|  / \  | \ | |  / \  |  \/  |/ _ \
| | | | | | | / _ \ |  \| | | |   / _ \ |  \| | / _ \ | |\/| | | | |
| |_| | |_| |/ ___ \| |\  | | |  / ___ \| |\  |/ ___ \| |  | | |_| |
 \__\_\\___//_/   \_\_| \_| |_| /_/   \_\_| \_/_/   \_\_|  |_|\___/
```

**QUANTANAMO** is a Grok Bot. It researches, sizes, and (when every gate passes) trades equities. Independent theses and the Agentic book live in Supabase. A localhost Bloomberg-style desk watches that ledger. X bookmarks are seeds, not the thesis store.

> Experimental software, not a promise of performance. It fails closed: missing evidence, stale broker state, a closed session, or a broken gate means **no order**. Never invent P/L on the desk — if the ledger has no mark, say so.

Operator how-to (auth, env, keyboard): [`LOCAL.md`](LOCAL.md).

## Keep this file current

This README is the living map of the **live** loop. When a PR adds or retires a routine, thesis family, desk panel, or trading limit, **edit the tables below in the same PR**. Do not leave Cloudflare / ThesisForge described as the brain.

| If you change… | Also update |
|---|---|
| A Grok Bot cadence | [Routines](#routines) and `apps/dashboard/lib/routines.ts` |
| A thesis family | [Theses](#theses) (ids from `public.theses`) |
| A desk tab | [Desk](#local-desk) and `apps/dashboard/lib/desk-nav.ts` |
| A live trading limit | [Trading](#trading) and `config/trade_policy.json` |

---

## System

```mermaid
flowchart LR
  X["X bookmarks<br/>@wallachworld<br/>seeds only"]
  G["QUANTANAMO<br/>Grok Bot"]
  L[("Supabase ledger<br/>xqungxapqicdmboniezz")]
  D["Local operator desk<br/>bun run web:app"]
  P["Public phone desk<br/>Cloudflare Worker"]
  R["Robinhood MCP<br/>Agentic ····7638"]

  X -->|X connector| G
  G -->|theses · runs · snapshots| L
  L -->|PostgREST as operator| D
  L -->|publish-public-desk| P
  G -->|review then place| R
  R -->|NAV · fills · positions| G
```

| Piece | Role |
|---|---|
| **QUANTANAMO (Grok Bot)** | Research and trading brain. Writes the ledger. Places equities through Robinhood MCP when gates pass. |
| **Supabase** `xqungxapqicdmboniezz` | Canonical store: theses, runs, `account_snapshots`, `position_episodes`, `trade_intents`, `portfolio_exposure`, … |
| **Local desk** | `bun run web:app` / `bash scripts/web-app.sh`. Reads the ledger as the signed-in operator. Does not run the bot. |
| **Public phone desk** | Cloudflare Worker `quantanamo-desk`. Same Book/Theses/Events/Tests chrome, read-only snapshot from KV. No Supabase keys in the browser. |
| **X connector** | Bookmark seeds from `@wallachworld`. Not the reconnect-OAuth path on the desk. |
| **Robinhood Agentic** | Live proof account, nickname **Agentic**, last4 **7638**. Official MCP only. |

ThesisForge cron and the `dashboard-publication` / `cloud-control` edge functions are **retired ingest**. The operator desk talks to PostgREST as the signed-in user. `workers/desk` is the public read-only phone site (snapshot only). Other worker folders are not the live research/trading loop.

---

## Routines

Edit this table when a cadence is added, renamed, or retired. Last-run times on the desk come from `public.runs`, not a fake next-fire clock.

| Routine | Folder / id | When (America/New_York) | Writes |
|---|---|---|---|
| Market scan | `quantanamo-market-scan` | Weekdays hourly **10:59–15:59** | `runs` (`market_scan`), snapshots, theses/evidence, intents when gated |
| Missed-swing autopsy | `quantanamo-missed-swing-autopsy` | Weekdays **16:15** | `runs` (`missed_swing_autopsy`), lessons / earnings-gap notes |

A scan that cannot refresh the Agentic account, or that hits a closed session, fails closed and still records a run.

### Market-scan sequence

```mermaid
sequenceDiagram
  autonumber
  participant Slot as Hourly slot 10:59-15:59 ET
  participant Bot as QUANTANAMO
  participant X as X connector
  participant RH as Robinhood MCP
  participant DB as Supabase ledger
  participant Desk as Local desk

  Slot->>Bot: fire quantanamo-market-scan
  Bot->>X: read bookmark seeds
  Bot->>RH: refresh Agentic account and positions
  RH-->>Bot: NAV, cash, buying power, fills
  Bot->>DB: account_snapshots, portfolio_exposure
  Bot->>DB: read theses, episodes, risk_controls
  Note over Bot: Size from live NAV every order. Equities only. 20% per name, 80% deployed, 3 new buys/day.
  alt Regular session open and every gate passes
    Bot->>RH: review_equity_order then place_equity_order
    RH-->>Bot: fill or reject
    Bot->>DB: trade_intents, position_episodes
  else Fail closed
    Bot->>DB: run with outcome skipped or failed
  end
  Bot->>DB: runs, evidence
  Desk->>DB: GET /api/ledger JWT
  DB-->>Desk: Book, Theses, Events, Tests, Team
```

---

## Trading

Live book: **Agentic** proof account (last4 7638). Starting capital is the first Agentic `account_snapshots` row (~$5,000). Open names are **every lot** on the latest `portfolio_exposure` snapshot for that last4 (as of 2026-08-27: IREN, NBIS, CIFR, DG). The Book panel shows NAV, cash, and buying power from the matching `account_snapshots` row. Per-name mark is shown only if the ledger has it.

| Limit | Value | Note |
|---|---|---|
| Asset class | Equities only | No options, crypto, margin, or shorting |
| Per name | 20% of **live** NAV | Recalculate from the fresh Robinhood total every order |
| Deployed | 80% of live NAV | Remainder cash |
| New equity buys | 3 / day | Risk-reducing sells are a separate path |
| Session | US regular hours | No after-hours queue |
| Review | `review_equity_order` immediately before `place_equity_order` | Any broker check blocks |

Keep [`config/trade_policy.json`](config/trade_policy.json) aligned with this table when limits change.

---

## Theses

Independent of X. Source of truth: `public.theses` on `xqungxapqicdmboniezz`. Refresh this table when a family is added or killed.

| Id | Name | Status |
|---|---|---|
| `neocloud_compute` | Neocloud and GPU compute burst basket | hardening |
| `semis_photonics` | AI semiconductor and photonics second derivative | hardening |
| `ai_power_nuclear` | AI power bottleneck beneficiaries | hardening |
| `software_ai_apps` | AI software and developer tooling watchlist | hardening |
| `defense_drones_space` | Defense, drones, and space momentum basket | hardening |
| `quantum` | Quantum momentum burst basket | hardening |
| `biotech_royalty` | Biotech royalty asymmetric setup | hardening |
| `earnings_gap_structure` | Earnings gap structure and missed-swing autopsy | forming |
| `crypto` | Crypto and decentralized AI optionality | forming |

---

## Local desk

```sh
bun install
bun run web:app    # same as: bash scripts/web-app.sh
```

Open `http://localhost:5173`. Sign in with **email magic link** or a **passkey** (RP ID `localhost`). The publishable / anon key is the only Supabase key in the browser (`NEXT_PUBLIC_*`). `service_role` and `QUANTANAMO_DATABASE_URL` stay server-side. First confirmed user is claimed via `claim_ledger_operator`; later operators need a `public.ledger_operators` row. `anon` is revoked. The desk queries PostgREST as that JWT.

It does not ingest X, call Robinhood, or run Grok. `/api/x/authorize` is retired (410). The desk does not display retired worker caps (3 buys/day, 20% name, RTH 09:45–15:45); those contradict the live mandate. PLTR is a compliance skip, not a position.

| Key | Tab | Shows |
|---|---|---|
| 1 | Book | Landing (`/`). One book, three venues: QUANTANAMO stocks (Agentic last4 7638 NAV / cash / lots from `portfolio_exposure` + `account_snapshots`), ODDSBORNE predictions (`pm_positions` / `pm_pnl` when present), and BANDIT coins (`meme_positions` / `meme_pnl` when present). **All** is the union of those lots / fills / intents — not the stocks chip. Venue chips filter the same table — not a second app. Fill tape. Next dated catalyst on held names in the active filter. Thesis lots with ledger P/L (or **not in ledger**). Living diagnostic is the Agentic 7638 path (hidden on Predictions-only and Coins-only). Unmarked lots are muted, never a fake P/L color. Venues are **not** summed into one NAV. |
| 2 | Theses | Same thesis list with EQ/PM chips. Lifecycle + evidence + held/candidate symbols (ontology folded in) + lessons (`research_lessons` and `pm_notes`). |
| 3 | Events | Dated catalysts and `pm_markets.close_time` on one sheet + `research_queue`. `/catalysts` redirects here. |
| 4 | Tests | Backtests from `strategy_tests` + `backtest_artifacts`. Equity curve and trades only when those artifacts exist. Prices from Financial Datasets. Missing artifact or null metric → **not in ledger**. |
| 5 | Team | Cards for every `desk_agents` row (today: GRASSHOPPER, QUANTANAMO, ODDSBORNE, BANDIT) with current `desk_domain_stewards` chips (`desk_domains`: Ledger / Stocks / Predictions / Meme coins). Soft stewardship — rotate a steward without renaming a domain. Heartbeat glow is ledger `heartbeat_at` only. Empty tables fall back to identity rows, never invented P/L. `/mates` redirects here. |

Last QUANTANAMO scan/autopsy is a chrome **chip** (from `public.runs` + `apps/dashboard/lib/routines.ts`), not a tab. Retired routes keep chrome mounted: `/book` and `/risk` and `/runs` → `/`; `/catalysts` → `/events`; `/ontology` and `/learnings` → `/theses`; `/mates` → `/team`. Risk controls stay in the database and are not a settings page.

Chrome stays mounted. Tab switches paint from the in-memory ledger payload. Keyboard: `1–5`, `g` then letter (`b/t/c/e/m`), `j/k` thesis, `r` refresh, `?` help. Venue chips (All / STOCKS / PREDICTIONS / COINS) filter Book, Theses, and Events — not a search box.

Canonical reads: `account_snapshots`, `portfolio_exposure` (latest last4 7638), `trade_intents`, `broker_fills`, `theses`, `thesis_symbols`, `trade_proposals`, `runs`, `strategy_tests`, `backtest_artifacts`, plus ODDSBORNE `pm_markets` / `pm_positions` / `pm_orders` / `pm_fills` / `pm_pnl` / `pm_notes` when those relations exist, plus BANDIT `meme_tokens` / `meme_positions` / `meme_orders` / `meme_fills` / `meme_pnl` / `meme_notes` when those relations exist, plus Team `desk_agents` / `desk_domains` / `desk_domain_stewards` / `desk_accounts` when those relations exist. Missing `pm_*`, `meme_*`, or `desk_*` tables yield an empty slice — the desk still loads. Not `dashboard_snapshots.current`. Equity book names come from the 7638 exposure snapshot, not `position_episodes`.

---

## Ledger

| Domain | Tables |
|---|---|
| Research | `theses`, `thesis_evidence`, `thesis_scores`, `catalysts`, `research_queue`, `research_lessons` |
| Book | `account_snapshots`, `position_episodes`, `portfolio_exposure`, `trade_intents`, `broker_fills` |
| Prediction | `pm_markets`, `pm_positions`, `pm_orders`, `pm_fills`, `pm_pnl`, `pm_notes` (ODDSBORNE / Polymarket; GRASSHOPPER) |
| Coins | `meme_tokens`, `meme_positions`, `meme_orders`, `meme_fills`, `meme_pnl`, `meme_notes` (BANDIT / Solana; `solana-bandit-primary`). Publisher role needs `quantanamo_worker_select` RLS, not just `GRANT SELECT` — same as `pm_*`. |
| Automation | `runs` (`notes.outcome` is `passed` \| `failed` \| `skipped` when JSON) |
| Tests | `research_cycles`, `strategy_tests`, `test_scenarios`, `backtest_artifacts` (Financial Datasets prices) |
| Team | `desk_domains`, `desk_agents`, `desk_domain_stewards`, `desk_accounts` (soft stewardship; public Worker reads the snapshot only) |
| Operators | `ledger_operators` + `is_ledger_operator()` (private DEFINER, public INVOKER wrapper) |

The desk is read-only. QUANTANAMO writes the ledger. See [`LOCAL.md`](LOCAL.md).

---

## Repository

```text
apps/dashboard/          local Next desk (PostgREST as operator; public mode via env)
config/trade_policy.json human-authored live limits (keep in sync with Trading)
docs/                    runbooks (some still describe retired Cloudflare ingest)
supabase/schemas/        declarative Postgres
supabase/migrations/     history
packages/                shared helpers
workers/desk             public phone desk (static assets + snapshot API)
workers/                 retired Cloudflare ingest — not the live brain
```

---

## Public phone desk

The operator desk stays localhost-only (`bun run web:app`). The public site is the **same terminal chrome** (Book / Theses / Events / Tests / Team) hosted on Cloudflare Workers static assets. It never talks to PostgREST.

```
phone  →  Worker GET /api/desk  →  KV key `current`  (curated DeskPayload, source=snapshot)
operator machine / QUANTANAMO  →  bun run desk:publish  →  file + optional PUT /internal/snapshot
```

### How data is published (no live DB on the public Worker)

1. `bun run desk:publish` runs **server-side** with `QUANTANAMO_DATABASE_URL`. It uses the same `loadDeskFromPostgres()` assembler as the operator desk, then `toPublicDeskSnapshot()` (`source: 'snapshot'`, operator audit rows dropped).
2. It writes `workers/desk/.data/current.json` (gitignored) and, when the DB is reachable, an audit row `dashboard_snapshots.id = 'public'`.
3. With `DESK_PUBLISH_URL` + `DESK_PUBLISH_TOKEN` it PUTs that JSON to the Worker (`/internal/snapshot`). The Worker stores it in KV. Wrong/missing token looks like `404`.
4. The public SPA only fetches `/api/desk`. There are no write routes, no auth, no admin chrome, and no `NEXT_PUBLIC_SUPABASE_*` in the public build.

`anon` cannot read `dashboard_snapshots` (or live tables) through PostgREST. Do not put `service_role`, `QUANTANAMO_DATABASE_URL`, or a publishable/anon key in the public client. Ignore retired 410 stubs `dashboard-publication` and `cloud-control` — they are not this path.

`pm_*` and `meme_*` rows (now live on Supabase) map into the **same** Book / Theses / Events language as equities. The public Worker does not query them — the publisher folds `prediction_markets` and `meme_coins` into the snapshot. Empty tables stay empty; no invented P/L. New domain lanes need `quantanamo_worker_select` RLS (`using (true)`), not just `GRANT SELECT` — otherwise `desk:publish` writes empty arrays with no Postgres error.

### Deploy

```sh
# KV DESK_SNAPSHOT is already created (id in workers/desk/wrangler.jsonc).
# Publish token is a Worker secret — never commit it.
bun --cwd workers/desk wrangler secret put DESK_PUBLISH_TOKEN
bun run desk:deploy
```

Push to `main` (or **Actions → Deploy public desk → Run workflow**) runs that same build + `wrangler deploy` from `workers/desk` after `bun run desk:build` writes `workers/desk/dist`. Required GitHub Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | `97af2e2312077d4689e9a012ef5dde75` |

`DESK_PUBLISH_TOKEN` is already a Wrangler Worker secret (`wrangler secret put`). It is not a GitHub Actions secret and is not needed to deploy.

The Worker is `grasshopper-desk` on `*.workers.dev` until a custom domain is attached. No sign-in on the public URL. Face ID / passkey stays on `bun run web:app` only. Local Worker preview: `bun run desk:build && bun run desk:dev` (port 8787).

### Local operator vs public

| | Operator (`bun run web:app`) | Public (`NEXT_PUBLIC_DESK_MODE=public` or the Worker) |
|---|---|---|
| Auth | Magic link / passkey; `ledger_operators` RLS | None. Snapshot only. |
| Data | `/api/ledger` as the signed-in JWT (or postgres.js server-side) | `/api/desk` from a file (local) or KV (Cloudflare) |
| Keys | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the browser | No Supabase keys |
| Writes | Retired 410s | 405 / 404 |
| Chrome | Sign out / Passkey+ | Hidden |

Local public preview (same Next app, no Cloudflare):

```sh
bun run desk:publish          # needs QUANTANAMO_DATABASE_URL
bun run web:public            # http://localhost:5173 — GET /api/desk
```

Env (see `.env.example`; never commit secrets):

| Var | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DESK_MODE=public` | Public client / `web:public` | Skip operator auth |
| `NEXT_PUBLIC_DESK_URL` | Public metadata | Canonical public origin |
| `PUBLIC_DESK_SNAPSHOT_PATH` | Local Next `/api/desk` | Snapshot file (default `workers/desk/.data/current.json`) |
| `QUANTANAMO_DATABASE_URL` | Publisher only | Assemble the snapshot |
| `DESK_PUBLISH_URL` | Publisher | `https://<worker>/internal/snapshot` |
| `DESK_PUBLISH_TOKEN` | Publisher + `wrangler secret` | Timing-safe ingest. Not `NEXT_PUBLIC_*`. |

After deploy: run `desk:publish` after market-scan / ledger writes (or wire QUANTANAMO to PUT `/internal/snapshot`) so the public URL is not an empty snapshot. Optional custom domain. Keep writing `pm_*` — do not add a second public app. The public URL has no sign-in; Face ID / passkey stays on the local operator desk.

```sh
bun run --cwd apps/dashboard test
bun test
```

Never commit `.env.local`, `.dev.vars`, OAuth tokens, or `service_role` keys.

## Further reading

- [`LOCAL.md`](LOCAL.md) — sign-in, env, how to confirm you are on the live ledger
- [`config/trade_policy.json`](config/trade_policy.json) — execution contract
- [`docs/live-trading-checklist.md`](docs/live-trading-checklist.md) — pre-trade gates
