# Steward entry scripts

The versioned entry points BANDIT (coins) and ODDSBORNE (Polymarket US) use for every **buy**. QUANTANAMO trades through Robinhood and follows the same contract through `docs/scheduled-run-prompt.md`.

Nothing secret is in this directory. Credentials come from the process environment first. If a credential isn't set there, the scripts fall back to a JSON file outside git: `STEWARD_SECRETS_FILE`, which defaults to `/home/box/sand-data/box-secrets.json` when that file exists.

## The entry contract (all stewards)

1. **Guidance first.** Call `public.steward_sizing_guidance(steward, thesis_id, instrument, requested, invalidation_price)` before any buy.
   - If `entry_allowed = false`, don't trade. The reasons are `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `missing_invalidation` or `stale_book`; QUANTANAMO can also get `quantanamo_requires_thesis` or `quantanamo_confidence_gate`.
   - Trade exactly `sized_notional`, which is `min(requested × multiplier, max_stake, spendable cash)`. `max_stake` is the edge-scaled cap per thesis (see `docs/sizing.md`).
2. **Invalidation is required.** Pass it in the lot's own unit: outcome price for ODDSBORNE, SOL per token for BANDIT, USD per share for QUANTANAMO.
   - Guidance refuses without it.
   - The database also rejects a new or re-opened `open` lot in `pm_positions`, `meme_positions` or `position_episodes` without `invalidation_price` (trigger `private.require_lot_invalidation`).
3. **Record the cap at entry.** Write guidance's `max_stake` and `max_stake_reason` to `max_stake_at_entry` and `max_stake_reason_at_entry` on the order or intent row.
   - If you leave them out, a trigger snapshots the same value at insert time.
   - The `entry_over_max_stake` watchdog check compares each entry with this snapshot, so an entry is judged against the cap that was in force when it was made.
4. **Tag the thesis** on the order and the lot. Buy fills also propagate the lot's thesis to the order.

The watchdog reads `public.v_ledger_watchdog`, `v_invalidation_breaches`, `v_open_lots_missing_invalidation` and `v_ledger_integrity`.

## BANDIT: `bandit/live_trade_clip.py`

```bash
cd /workspace/bandit && .venv/bin/python live_trade_clip.py \
  --mint <MINT> --symbol <SYM> [--name <NAME>] --request 0.45 --rationale "<why>" \
  [--invalidation-price <SOL per token>] [--dry-run]
```

| Arg | Meaning |
|---|---|
| `--mint`, `--symbol` | Token (required) |
| `--request` | Requested SOL before the multiplier (required) |
| `--invalidation-price` | SOL per token. Default is 0.6 × the Jupiter pre-trade price (−40%). The script aborts if there's no price. |
| `--dry-run` | Prints guidance and size, then exits without trading |

- Thesis: `meme_4h_momentum_clip`.
- Writes `meme_orders` (with thesis, `max_stake_at_entry` and reason), `meme_fills`, the `meme_positions` lot (with invalidation) and `meme_pnl`.
- Environment:
  - `BANDIT_SOLANA_PRIVATE_KEY`, `HELIUS_API_KEY`, `JUPITER_API_KEY`, `BANDIT_WORKER_DB_PASSWORD`.
  - Optional: `BANDIT_STATE_DIR` (where `_last_fill_*.json` goes; default is the script's directory).
- Python dependencies: `requests`, `base58`, `solders`, `psycopg`.

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
| `--usd` | Requested USD before the multiplier |
| `--invalidation` | Required, with 0 < inval < price. Written on the `pm_positions` lot along with `--invalidation-note`. |
| `--dry-run` | Venue preview only: no `orders.create`, no `pm_orders` / `pm_fills` writes, no heartbeat |

- Writes `pm_orders` (with `max_stake_at_entry` and reason), `pm_fills`, and the `pm_positions` lot (fills are linked to it).
- Environment:
  - `POLYMARKET_US_KEY_ID`, `POLYMARKET_US_SECRET_KEY`, `ODDSBORNE_WORKER_DB_PASSWORD`.
  - Optional: `ODDSBORNE_HOME` (helper modules), `ODDSBORNE_OUT_DIR` (orphan-order dumps).
- Python dependencies: `polymarket_us`, `psycopg`.

## The box copies

`/workspace/bandit/live_trade_clip.py` and `/workspace/oddsborne/pm_enter.py` are **identical copies** of these files, so existing invocations keep working. They are copies rather than symlinks because the box's git checkout changes branch.
- The scripts put the directory they are invoked from first on `sys.path`. On the box, they therefore keep using the box's own `load_secrets.py` and `db_connect.py`.
- After a merge, run `bash stewards/sync_box.sh`. It refuses to overwrite a box copy that has local edits which aren't in the repo, so edit here, then sync.

## Checks

`python3 -m unittest discover -s stewards -p 'test_*.py'` needs no dependencies: it byte-compiles the scripts, checks the contract points above in the source, and scans for credential-looking literals. It also runs inside `bun run test` (`apps/dashboard/lib/steward-scripts.test.ts`). `stewards-ci.yml` is a ready GitHub Actions workflow; move it to `.github/workflows/` with a token that has `workflow` scope (the agent's token doesn't).
