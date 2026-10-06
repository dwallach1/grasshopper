# Steward entry and exit scripts

The versioned entry points BANDIT (coins) and ODDSBORNE (Polymarket US) use for every **buy**, and the exit, mark and P&L scripts that close those lots ([below](#exits-marks-and-pl-both-stewards)). QUANTANAMO trades through Robinhood and follows the same contract through `docs/scheduled-run-prompt.md`.

Nothing secret is in this directory. Credentials come from the process environment first. If a credential isn't set there, the scripts fall back to a JSON file outside git: `STEWARD_SECRETS_FILE`, which defaults to `/home/box/sand-data/box-secrets.json` when that file exists.

## The entry contract (all stewards)

1. **Guidance first.** Call `public.steward_sizing_guidance(steward, thesis_id, instrument, requested, invalidation_price)` before any buy.
   - If `entry_allowed = false`, don't trade. The reasons are `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `missing_invalidation`, `stale_book` or `exposure_cap` (open risk already at 10% of book: equities to invalidation, ODDSBORNE binaries and BANDIT memes at full notional, per `risk_basis`); QUANTANAMO can also get `quantanamo_requires_thesis`, `quantanamo_unscored` (fewer than 3 effective trades: David approves) or `quantanamo_confidence_gate` (results score below 80).
   - Trade exactly `sized_notional`, which is `min(requested, max_stake, spendable cash, exposure fit)`. Pass the entry price as the optional 6th argument so the exposure fit counts only (entry − invalidation) / entry as risk. `max_stake` is the edge-scaled cap per thesis: a starter of 0.03 × book / the steward's bet volatility until proven, × the steward drawdown scale (see `docs/sizing.md` and the court rulings in `docs/rules/`). Guidance no longer returns a multiplier (struck by the court, docs/rules/confidence-multiplier.md).
2. **Invalidation is required.** Pass it in the lot's own unit: outcome price for ODDSBORNE, SOL per token for BANDIT, USD per share for QUANTANAMO.
   - Guidance refuses without it.
   - The database also rejects a new or re-opened `open` lot in `pm_positions`, `meme_positions` or `position_episodes` without `invalidation_price` (trigger `private.require_lot_invalidation`).
3. **Record the cap at entry.** Write guidance's `max_stake` and `max_stake_reason` to `max_stake_at_entry` and `max_stake_reason_at_entry` on the order or intent row.
   - If you leave them out, a trigger snapshots the same value at insert time.
   - The `entry_over_max_stake` watchdog check compares each entry with this snapshot, so an entry is judged against the cap that was in force when it was made.
4. **Tag the thesis** on the order and the lot. Buy fills also propagate the lot's thesis to the order.

The watchdog reads `public.v_ledger_watchdog`, `v_invalidation_breaches`, `v_open_lots_missing_invalidation`, `v_ledger_integrity`, and `v_learning_loop_gaps` (closes with no lesson yet; not a trading breach).

**Equity marks (QUANTANAMO): write the real venue price at any hour.** Premarket and after-hours marks are fine and expected; never write the prior close as a stand-in (a stale mark). The watchdog reads the session from the mark time (`public.us_equity_session(observed_at)`: `pre`, `rth`, `post`, `closed`). A mark at or below the lot's `invalidation_price` is `exit_full_lot` only in `rth`; in any other session it is `review_at_open`, and the desk shows it as "premarket print under its exit, decides at open". Exits still decide on regular-session trades.

## BANDIT: `bandit/live_trade_clip.py`

```bash
cd /workspace/bandit && .venv/bin/python live_trade_clip.py \
  --mint <MINT> --symbol <SYM> [--name <NAME>] --request 0.45 --rationale "<why>" \
  [--invalidation-price <SOL per token>] [--dry-run]
```

| Arg | Meaning |
|---|---|
| `--mint`, `--symbol` | Token (required) |
| `--request` | Requested SOL before the max-stake cap (required) |
| `--invalidation-price` | SOL per token. Default is 0.6 × the Jupiter pre-trade price (−40%). The script aborts if there's no price. |
| `--dry-run` | Prints guidance and size, then exits without trading |

- Thesis: `meme_4h_momentum_clip`.
- Writes `meme_orders` (with thesis, `max_stake_at_entry` and reason), `meme_fills`, the `meme_positions` lot (with invalidation) and `meme_pnl`.
- Environment:
  - `BANDIT_SOLANA_PRIVATE_KEY`, `HELIUS_API_KEY`, `JUPITER_API_KEY`, `BANDIT_WORKER_DB_PASSWORD`.
  - Optional: `BANDIT_STATE_DIR` (where `_last_fill_*.json` goes; default is the script's directory).
- Python dependencies: `requests`, `base58`, `solders` (`psycopg` only for the `STEWARD_DB_TRANSPORT=pg` fallback).
- Ledger writes go over HTTPS; see [Ledger transport](#ledger-transport-https). If the swap lands but the ledger write fails, the fill is saved to `$BANDIT_STATE_DIR/_unrecorded_fill_<symbol>.json` and the script exits non-zero.
- After every close, run `bandit/paper_bank20.py <position_id>` to record the shadow exit (see [Shadow exits](#shadow-exits-all-stewards) and `bandit/README.md`).

## ODDSBORNE: `oddsborne/pm_enter.py`

```bash
cd /workspace/oddsborne && .venv/bin/python pm_enter.py \
  --slug <market slug> --outcome yes|no --price 0.42 --usd 20 --thesis <thesis_id> --p 0.55 \
  --invalidation 0.30 --invalidation-note "<what makes this wrong>" \
  [--order-type maker_gtc|gtc|ioc|fok] [--fair-source ...] [--rationale ...] [--kill ...] [--dry-run]
```

| Arg | Meaning |
|---|---|
| `--thesis` | Required (the script refuses without it) |
| `--price` | Limit price of the outcome being bought |
| `--p` | Your probability. The only edge rule is `edge_after_costs = p − price − Θ·p·(1−p) > 0`. |
| `--usd` | Requested USD before the max-stake cap |
| `--invalidation` | Required, with 0 < inval < price. Written on the `pm_positions` lot along with `--invalidation-note`. |
| `--dry-run` | Venue preview only: no `orders.create`, no `pm_orders` / `pm_fills` writes, no heartbeat |

- Writes `pm_orders` (with `max_stake_at_entry` and reason), `pm_fills`, and the `pm_positions` lot (fills are linked to it).
- Environment:
  - `POLYMARKET_US_KEY_ID`, `POLYMARKET_US_SECRET_KEY`, `ODDSBORNE_WORKER_DB_PASSWORD`.
  - Optional: `ODDSBORNE_HOME` (helper modules), `ODDSBORNE_OUT_DIR` (orphan-order dumps).
- Python dependencies: `polymarket_us` (`psycopg` only for the `STEWARD_DB_TRANSPORT=pg` fallback).
- Ledger writes go over HTTPS; see [Ledger transport](#ledger-transport-https). Note that `--dry-run` still upserts the `pm_markets` reference row.

## Exits, marks and P&L (both stewards)

A lot opened by `live_trade_clip.py` or `pm_enter.py` is marked and closed from the box by these scripts. Every ledger write goes over HTTPS (see [Ledger transport](#ledger-transport-https)) through the `SECURITY INVOKER` functions in `supabase/schemas/51_steward_exit_rpc.sql`. Each script has `--dry-run`, which reads the venue and the ledger but places no order and writes nothing. A refusal prints `REFUSED`/`not_open`/`ABORT_…` and exits 2. Exit code 10 means "an exit is due".

**Realized P&L on every close.** The close functions link the lot's buy and sell fills before the lot flips to `closed`, so `private.trade_outcome_capture` writes `realized_pnl` with `pnl_source = 'fills'`.
- `oddsborne_exit_record` refuses a close whose linked buys don't cover linked sells + remaining quantity (`refusal:fills_incomplete`), so a close can't silently land as `manual` with a null `realized_pnl`. `--allow-unpriced "<reason>"` overrides this and records the reason on the lot.
- This was the 10/4 TEN and MIA case: the late maker entry fills were never recorded in `pm_fills`. `pm_exit.py` now pulls the lot's entry fills from the venue and sells the venue-backed quantity.

### BANDIT (`cd /workspace/bandit`)

| Script | What it does |
|---|---|
| `mark_clip.py --all-open` (or `--position-id <id>`) | Takes a Jupiter full-size quote for each open lot, then writes `meme_positions.mark` and `meta.last_mark`, a `meme_pnl` mark row and the heartbeat (`bandit_mark_position`). It applies the rails in order: 4h time stop, −40%, invalidation price, then full bank at +50%. When one fires, it prints the `exit_clip.py` command and exits 10. |
| `exit_clip.py --position-id <id> --trigger <kill_-40pct\|invalidation\|deadline_4h_stop\|tp50_full_bank\|thesis_invalid\|manual>` | Market-sells the whole lot through Jupiter (3% slippage, then 5%; Helius send as a fallback). It then calls `bandit_exit_record_fill`, which writes the sell order and fill, closes the lot (`exit_reason` = trigger), records realized P&L in `meme_pnl` and the trade outcome, and runs the heartbeat. Finally it closes the empty token account. If the ledger write fails after the swap, the fill is saved to `$BANDIT_STATE_DIR/exit_clip_orphan_<position_id>_<ts>.json` (exit 1); record it before anything else. |
| `close_lesson.py --position-id <id> --rationale "<lesson>" --new-confidence <1-100>` | Writes the close lesson (a `belief_updates` row with `lot_id`), which clears `v_learning_loop_gaps`. Run it after every close, along with `paper_bank20.py <id>`. |
| `pnl_snapshot.py [--notes "<standup>"]` | Writes a `meme_pnl` snapshot of wallet SOL plus open marks (`bandit_pnl_snapshot`). |

### ODDSBORNE (`cd /workspace/oddsborne`)

| Script | What it does |
|---|---|
| `pm_watch.py --all-open [--routine <name>]` | Reads the outcome bid (falling back to last, then mid) for each open lot and writes `pm_positions.mark` and `meta` (`oddsborne_mark_position`). At or below `invalidation_price` it prints the `pm_exit.py` command and exits 10. |
| `pm_exit.py --position-id <id> --reason <invalidation\|take_profit\|thesis_exit\|pre_settle\|edge_gone\|manual> [--price <p>] [--order-type ioc\|fok\|gtc] [--dry-run]` | Sells the lot at the bid (or `--price`). It then calls `oddsborne_exit_record`, which writes the sell order and fills, the lot's entry fills, the close or reduce, the `pm_pnl` row and the heartbeat. For `invalidation` it aborts if the print is back above the line, unless `--force`. `--record-only --venue-order-id <sell id>` records a sell that was already placed. If the ledger write fails after the sell, the payload is saved to `$ODDSBORNE_OUT_DIR/pm_exit_orphan_<sell id>.json`. |
| `pm_fills_sync.py --venue-order-id <buy id>` | Records maker fills that landed after `pm_enter.py` returned, and adds them to the open lot. It refuses when the venue no longer holds the shares (already sold); record those with the exit instead. |
| `close_lesson.py --position-id <id> --rationale "<lesson>" --new-confidence <1-100>` | Same as BANDIT's (an identical file). |
| `pm_pnl_snapshot.py [--notes "<standup>"]` | Writes a `pm_pnl` snapshot of venue cash plus asset notional (`oddsborne_pnl_snapshot`). |

## Ledger transport (HTTPS)

The box only egresses HTTPS (443), through a proxy that resolves every host to a 198.18.0.0/15 address. Raw TCP to the Supavisor pooler (5432/6543) and to `db.<ref>.supabase.co` times out, so `db_connect` cannot reach Postgres from the box. The entry scripts therefore write the ledger over HTTPS:

- `steward_rpc.py` (identical copy in `bandit/` and `oddsborne/`) POSTs to the `steward-rpc` edge function (`supabase/functions/steward-rpc`) with HTTP Basic auth `<steward>_worker:<STEWARD>_WORKER_DB_PASSWORD`, the same secret `db_connect` uses. There is no new secret and no service_role.
- The edge function connects to Postgres **as that worker role** (via `SUPABASE_DB_URL`'s host) and runs `select public.<fn>($1::jsonb)`. Only functions on its per-role allowlist can be called. Grants, RLS and triggers (`require_lot_invalidation`, `snapshot_entry_max_stake`, ...) apply exactly as before.
- The functions live in `supabase/schemas/50_steward_entry_rpc.sql`. Each one is `SECURITY INVOKER`, takes and returns one `jsonb`, runs in one transaction, and is executable only by its steward's worker role (and service_role). `steward_entry_guidance` wraps `steward_sizing_guidance` unchanged, so every gate (QUANTANAMO 80 gate, killed/rejected thesis, cash/no-margin, fresh book) is enforced the same way.
- A gate refusal raised in SQL as `refusal:<gate>: <reason>` comes back as `RpcError.refusal`. Only idempotent calls (guidance, reads) are retried. A failed write is never retried blindly; `RpcError.maybe_committed` says whether it may have landed.
- Check the path: `cd /workspace/<steward> && .venv/bin/python steward_rpc.py <steward>` prints the role and DB time.
- `STEWARD_DB_TRANSPORT=pg` switches back to a direct psycopg connection through `db_connect` (for a host that can reach the pooler). `STEWARD_RPC_URL` overrides the function URL.

Ad-hoc box scripts that still `import db_connect` (the per-symbol `_<sym>_exit_once.py` / `_mark_once.py` clones, ODDSBORNE's `watch_*` and session scripts) will keep timing out on the box until they are ported. Use the exit/mark scripts above instead. Other scripts must be ported to `steward_rpc` (add a function to the allowlist and the schema file) or until box egress allows TCP to the pooler.

## Shadow exits (all stewards)

To test an alternative exit rule without trading it, write one object per closed lot to the lot's own `meta` under a key starting with `paper_` (for example `meme_positions.meta.paper_bank20`). There is no separate table; the views read `meta` on `meme_positions`, `pm_positions` and `position_episodes`.

| Key | Meaning |
|---|---|
| `rule` | Rule id, e.g. `bank_at_+20pct` (required) |
| `paper_exit_pct` | Return vs entry if the rule had been followed, in % (required). Equals `real_exit_pct` when it didn't fire. |
| `real_exit_pct` | Real exit return vs entry **on the same mark basis**, in % (required) |
| `delta_pct_pts` | `paper − real`, in percentage points (computed if absent) |
| `triggered`, `trigger_minute` | Did it fire, and how many minutes after entry |
| `source`, `note` | Mark basis |

Numbers may be JSON numbers or numeric strings.

- `public.v_shadow_exits`: one row per closed lot × rule, including the fill-based `real_fill_return_pct` from `trade_outcomes` for reference.
- `public.v_shadow_exit_scorecard`: per steward × rule, with `n`, `paper_better` / `paper_worse`, mean and LCB of the delta, `clips_to_decide`, and `promotable`. `promotable` means n ≥ 10 and LCB (mean − sd/√n) of the delta > 0, the same bar the edge-scaled cap uses.

The views only measure. Promoting a rule is a steward decision, recorded as a playbook rule.

## Box environment (venvs)

Each steward runs its scripts with its own venv: `/workspace/bandit/.venv` and `/workspace/oddsborne/.venv`. The pinned dependencies are in `bandit/requirements.txt` and `oddsborne/requirements.txt` (full `pip freeze` of the working envs). QUANTANAMO doesn't use Python.

**Why the venvs disappear.** The box's durable store restores `/workspace` and `/home/box` after a box refresh, but its default ignore list skips `.venv/`, `venv/`, `.cache/` (so the pip cache), `node_modules/`, `__pycache__/` and `build/`/`dist/` directories. Every refresh therefore wipes the venvs while the scripts, the requirements and the secret mirrors survive. Re-including `.venv/` wouldn't be enough: pip ships its own `build/` directory, which the store would still drop.

**What survives, and the one command to rebuild.** These are all plain files, so they survive a refresh:
- The requirements, both in this repo and mirrored to `/workspace/<steward>/requirements.txt`.
- The wheel cache at `/workspace/.steward-wheelhouse`.

Any steward, after a refresh or whenever `doctor.sh` says broken, runs:

```bash
bash /workspace/grasshopper/stewards/sync_box.sh
```

It is idempotent:
- It syncs the scripts and requirements to the box. It skips this step with `--env`, or when the checkout isn't on `main`.
- It creates, repairs or rebuilds each venv. It installs offline from the wheel cache first, falling back to PyPI and refilling the cache.
- It then runs `doctor.sh` and exits with its status.

A rebuild takes about 10 s, and no network is needed once the cache exists.

- `bash /workspace/grasshopper/stewards/doctor.sh` checks that each venv exists, that its imports work (including the box `db_connect`, `load_secrets` and `steward_rpc`), and that the invoked files are present. It prints one line per steward and exits 1 when anything is broken. The ledger health routine runs it too.
- `live_trade_clip.py`, `pm_enter.py` and the exit/mark scripts check their imports before any venue or DB call. When the env is missing or broken, they stop with exit code 3 and the message `Python env not ready … Nothing was sent. Run: bash /workspace/grasshopper/stewards/sync_box.sh`, instead of failing halfway through an order. Set `GRASSHOPPER_REPO` if the checkout lives elsewhere.
- Credentials follow the durable-secrets pattern: env → `box-secrets.json` → the agent's private mirror under `/home/box/agent-data/agents/<id>/private/`, healing `box-secrets.json` from the mirror.

## The box copies

`/workspace/bandit/{live_trade_clip,paper_bank20,clip_common,mark_clip,exit_clip,pnl_snapshot,close_lesson}.py`, `/workspace/oddsborne/{pm_enter,pm_exit,pm_watch,pm_fills_sync,pm_pnl_snapshot,close_lesson}.py` and both `steward_rpc.py` files are **identical copies** of these files, so existing invocations keep working. They are copies rather than symlinks because the box's git checkout changes branch.
- The scripts put the directory they are invoked from first on `sys.path`. On the box, they therefore keep using the box's own `load_secrets.py` and `db_connect.py`.
- After a merge, run `bash stewards/sync_box.sh` (it also repairs the venvs; see above). It refuses to overwrite a box copy that has local edits which aren't in the repo, so edit here, then sync.

## Checks

`python3 -m unittest discover -s stewards -p 'test_*.py'` needs no dependencies: it byte-compiles the scripts, checks the contract points above in the source, and scans for credential-looking literals. It also runs inside `bun run test` (`apps/dashboard/lib/steward-scripts.test.ts`). `stewards-ci.yml` is a ready GitHub Actions workflow; move it to `.github/workflows/` with a token that has `workflow` scope (the agent's token doesn't).
