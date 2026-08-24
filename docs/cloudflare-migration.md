# Cloudflare migration plan

ThesisForge migrated before its first live trade. There was no historical order
state to backfill. The autonomous production launch gate was enabled on
2026-08-24 after a read-only shadow run completed with eight successful thesis
tasks, zero approved proposals, and zero live trade intents.

> The numbered phase sections below are retained as migration history. Their
> older statements about disabled scheduling, unavailable broker access,
> shadow-only operation, or blocked launch are superseded by the production
> status here and in the repository README.

## Production status (2026-08-24)

The system is cloud-native and does not depend on Codex or a powered-on laptop:

- Cloudflare Cron wakes `CloudResearchWorkflow` at three market-oriented slots
  per weekday; New York-time gating removes the duplicate DST wakeup.
- Cloudflare Queues fan out research and execution tasks. Workflows provide
  durable orchestration and retries.
- Workers AI creates typed research decisions. It has no broker tools or
  credentials and cannot directly place an order.
- `ThesisCoordinator`, `PositionMonitor`, `BrokerExecutionCoordinator`, and
  `RobinhoodBrokerAgent` are Durable Objects. Supabase remains canonical.
- The broker Agent keeps the Robinhood MCP OAuth connection and exposes only an
  exact equity read/review/place allowlist to the execution coordinator.
- `TRADING_ENABLED=true` and `BROKER_EXECUTION_ENABLED=true` are deployed.
  There is no per-order human approval in the application policy.
- `autonomous-execution` and `autonomous-position-management` are active
  code-level Supabase controls. Open, add, reduce, and exit actions are live.
- Each broker position reconciles to a canonical Supabase episode and an
  account+symbol `PositionMonitor` Durable Object at every scheduled run.

Every order fails closed unless it is an equity order in the 09:45-15:45 ET
window, its quote is at most 120 seconds old, spread is at most 80 bps, Robinhood
returns no order check, buying power is sufficient, and the account remains
below three agentic buys, 20% daily buy notional, and 5% single-buy notional.
UUIDv4 broker references and account-scoped Durable Object reservations prevent
duplicate logical orders.

### Emergency stop

Use either cloud control immediately; both are intentionally independent:

1. Set the `autonomous-execution` Supabase risk control to `paused`. New
   Workflow decisions will fail closed at the control plane.
2. Set `TRADING_ENABLED=false` in `web/wrangler.publication.jsonc` and deploy
   `thesisforge-dashboard-publication`. For defense in depth, also set
   `BROKER_EXECUTION_ENABLED=false` and deploy `thesisforge-broker-gateway`.

Disconnecting the Robinhood MCP connection is the broker-boundary emergency
stop. Never delete audit rows to stop execution.

## Target boundary

- Supabase remains the canonical Postgres database and private object store.
- Cloudflare Workers serves the private dashboard and small HTTP control APIs.
- Cloudflare Workflows orchestrate retryable research and publication steps.
- Robinhood inspection and equity execution run through the broker Agent.

The dashboard talks to Supabase through its HTTPS Data API. It does not open a
Postgres socket from the Worker. Cloudflare Access protects the Worker, and the
application independently verifies the Access JWT before reading any snapshot.

## Phase 1: private dashboard

The first Worker is `thesisforge-dashboard`. Its initial deployment kept both
`workers.dev` and preview URLs disabled. The release sequence was:

1. Build and upload the Worker without a public route.
2. Configure its server-only Supabase and manager secrets.
3. Attach an owner-only Cloudflare Access application and Allow policy.
4. Enable the production `workers.dev` route.
5. Verify an unauthenticated request is rejected and an authenticated request
   can read the current Supabase snapshot.

Required Worker values:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `THESISFORGE_DASHBOARD_TOKEN`
- `THESISFORGE_MANAGER_TOKEN`
- `THESISFORGE_MANAGER_USER_IDS`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`

All values are stored as Worker secrets or protected runtime configuration.
None belong in `wrangler.jsonc` or browser-visible `NEXT_PUBLIC_` variables.

### Cutover status (2026-08-24)

- The production Worker is live at
  <https://thesisforge-dashboard.davidwallach2.workers.dev>. Preview URLs remain
  disabled.
- Cloudflare Access protects the Worker with the `ThesisForge Dashboard`
  application and an Allow policy restricted to the owner's Access identity.
- All seven required runtime values are stored as encrypted Worker secrets;
  no secret values are committed to the repository.
- An anonymous request redirects to Cloudflare Access, and an authenticated
  owner request loads the current Supabase-backed dashboard successfully.
- The existing owner-only Sites deployment remains live and has the rotated
  credentials, so it is the fallback during cutover.
- Supabase accepts both the previous and rotated token hashes temporarily.
  Remove the previous hashes in a separate cleanup after the fallback path is
  no longer needed.
- No trading, broker execution, scheduler, or Workflow was enabled by this
  cutover.

## Phase 2: publication workflow

Dashboard snapshot publication now runs through the route-less
`thesisforge-dashboard-publication` Cloudflare Workflow. The Workflow calls a
token-authenticated Supabase Edge Function; only Supabase's internal
`service_role` can execute the `SECURITY INVOKER` publication RPC. No
database password or broad Supabase key is stored in Cloudflare.

The cloud publisher was first run against the `cloudflare-shadow` snapshot.
Its normalized output hash matched the Python publisher exactly, with no
changed top-level sections. A subsequent manual cloud run published `current`
and the owner-authenticated dashboard loaded the new snapshot successfully.

Automatic scheduling remains disabled. This preserves a manual observation
window before a `schedules` entry is added to the Workflow binding. The
Workflow and database result both assert `trading_enabled: false`; this phase
does not inspect a broker or place orders.

Rollback is to stop triggering the Workflow and resume
`bun run dashboard:publish`. The `cloudflare-shadow` row is intentionally
retained as a comparison target.

## Durable Objects follow-up

Do not make Durable Objects a second research database. Supabase remains the
canonical home for theses, symbols, evidence, and relationships.

After the ingestion and research workloads are cloud-native, evaluate a
Durable Object per thesis as a coordination atom when we need serialization,
an alarm, live progress, or concurrent-agent arbitration for that thesis.
Per-symbol objects should be added only if symbol-level quote or event
coordination has an independent lifecycle; otherwise symbols remain indexed
relations inside the thesis workflow. A thesis can span many symbols and a
symbol can support many theses, so storing the research corpus in both object
types would create ambiguous ownership and duplicate state.

## Phase 3: ingestion and research shadow runs

### Cloud control plane status (2026-08-24)

The route-less `thesisforge-dashboard-publication` Worker now also hosts the
cloud research control plane:

- `CloudResearchWorkflow` is the retryable orchestration layer.
- `thesisforge-research-tasks` fans thesis work out to a bounded Queue consumer;
  repeated delivery is safe because every task has a unique idempotency key.
- `thesisforge-research-tasks-dlq` retains exhausted jobs.
- Workers AI uses `@cf/meta/llama-3.1-8b-instruct-fast` through the `default` AI
  Gateway. Outputs are structured, audit-only, and cannot create trade intents.
- `ThesisCoordinator` is one SQLite Durable Object per thesis. It serializes and
  deduplicates recent model results; Supabase remains the research database.
- `PositionMonitor` is one Durable Object per account/instrument position
  episode. Its single alarm is reserved for the next exceptional review, not
  minute polling.
- `BrokerExecutionCoordinator` is one Durable Object per broker account. The
  deployed class can reserve a shadow intent only and always reports
  `blocked_no_broker_gateway`.

The current schedule targets 10:05, 13:05, and 15:25 America/New_York on
weekdays. Cloudflare Cron is UTC, so both DST candidate hours wake the Worker;
the Worker creates a Workflow only when the New York time exactly matches a
slot. This means three useful research runs per weekday, not continuous polling.
The gate does not yet prove an exchange holiday or early close, so it must never
be reused as a live-order market-calendar gate.

The account is currently on the Workers Free plan. Direct scheduled Workflows
require the paid plan, so the deployment uses free Cron Triggers to create
Workflow instances. The first production shadow verification completed in five
seconds, queued eight thesis jobs, ran all eight through Workers AI and AI
Gateway, recorded their canonical task rows, exercised thesis Durable Objects,
and finalized with zero failed tasks. The schedule now hashes each thesis plus
the canonical dashboard version and skips LLM inference when that input has not
changed. This makes inference event-driven even though orchestration wakes three
times per day.

The remaining Phase 3 source ports are X OAuth/bookmark ingestion, bounded
article fetch/archive, deterministic ontology refresh, and PDF extraction. They
still depend on local rotating X tokens, Python/Postgres transactions, or the
local `pdftotext` binary. PDF extraction needs a scale-to-zero Container or a
supported extraction service; the ordinary Worker runtime cannot execute that
binary.

## Phase 4: read-only broker integration

This phase is blocked at the vendor boundary. The repository has no Robinhood
client, remote MCP URL, server credential, or supported server-to-server API.
The Robinhood tools available in Codex are session connectors and cannot be
called by Cloudflare. Do not copy session tokens or reverse-engineer a private
Robinhood API.

When a supported endpoint exists, bind it behind a dedicated gateway and flow
all calls through the account-scoped `BrokerExecutionCoordinator`. The gateway
must first support read-only account, position, quote, tradability, and order
reconciliation calls. Pin one account during setup and persist atomic snapshot
batch identity before any sizing work.

## Phase 5: explicit live-trading launch

Live placement requires a separate, default-off production flag plus passing
integration tests for market hours, stale account state, sizing caps, buying
power, symbol verification, duplicate-order prevention, and audit persistence.
Enabling cloud scheduling alone must never enable trading.

The canonical tables now exist for position episodes, monitor events, trade
intents, execution attempts, broker reference IDs, and fills. They are RLS
enabled, inaccessible to `anon` and `authenticated`, and explicitly granted to
`service_role` only. `TRADING_ENABLED=false` and
`BROKER_GATEWAY_MODE=unavailable` are deployment guardrails; changing either
causes this shadow release to fail closed.

Live launch remains blocked until all of these are true:

1. Robinhood supplies a supported remote endpoint and unattended authentication
   contract.
2. The broker's mandatory per-order confirmation contract is reconciled with
   the repository's older autonomous-trading policy. The stricter broker
   contract wins.
3. Read-only shadow refreshes prove account/position reconciliation.
4. Deterministic market-calendar, stale-snapshot, buying-power, sizing,
   liquidity, symbol, quote, duplicate-order, confirmation, and reconciliation
   gates pass integration tests.
5. The owner explicitly enables the final production launch gate.

LLMs never receive broker credentials and never call the execution object.
They produce structured research and recommendations; deterministic code owns
eligibility, sizing, approval, idempotency, placement, and reconciliation.

## Cost posture

- Three useful weekday orchestrations; no minute polling.
- No LLM call when the versioned thesis input hash is unchanged.
- Small Workers AI model for classification; larger/frontier models should be
  added only behind a materiality threshold and AI Gateway spend limit.
- Queue concurrency is capped at two and batches at five.
- Durable Objects sleep when inactive. Position alarms are exceptional review
  deadlines, not quote polling.
- Supabase remains canonical, avoiding duplicated corpora in Durable Object
  SQLite storage.

## Rollback

Each phase is independently reversible. For phase 1, disable the Worker
`workers.dev` route and use the existing owner-only Sites deployment. For later
phases, disable the relevant Workflow and resume the prior local command.
Supabase remains intact and canonical throughout.
