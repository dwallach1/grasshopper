# Sizing: results set the size, no hard cap per position, no fixed rails

Position size follows results, and there is **no hard cap per position** (David, 2026-09-26). The other fixed trading rails are gone too ("Kill the old rules!"): no trade count, spread block, 09:45–15:45 window, fixed add %, add count or spacing, reduce band, averaging-down ban, global stop-loss, or portfolio drawdown limit. This reverses the 20%-of-book cap from #84, and the old fixed 5% per-order rule is gone too. Each thesis gets a results score from its expected return per trade (live trades plus discounted out-of-sample backtests), each entry is bounded by an **edge-scaled max stake** that starts at an equal-risk share of the book (v = 3% / bet volatility) and grows only with measured, proven edge (live trades plus discounted out-of-sample backtests), scaled down only when the steward's whole book is in drawdown (see below), and each steward's open risk to invalidation stays within 10% of its book. Every rule here has a court ruling in [`docs/rules/`](rules/README.md). A buy also can't spend more cash than the steward actually has (no margin).

## The rules

| Rule | Value |
|---|---|
| Per-position cap | **None** |
| Multiplier | **Retired** by the 2026-09-26 court ruling ([confidence-multiplier](rules/confidence-multiplier.md)): it was gameable and noise at small n, and `max_stake` does the small-sample work. Guidance no longer returns `multiplier` / `multiplier_basis` / `half_kelly_fraction` (migration 40). `public.thesis_sizing()` still computes it for the retired `workers/research` code only |
| Max stake | Edge-scaled per thesis, in the book's unit (see [Edge-scaled max stake](#edge-scaled-max-stake)). Starter while unproven: 0.03 × current book / steward bet volatility (QUANTANAMO 12%, ODDSBORNE 1.53%, BANDIT 6.68% of book on 2026-09-26 = $660 / $4.24 / 0.1205 SOL), × the steward drawdown scale |
| Size | `min(requested, max_stake, spendable cash, exposure fit)` (see [Portfolio exposure](#portfolio-exposure-10-of-book-at-risk)). Spendable cash: QUANTANAMO `min(cash, buying_power)` on Agentic 7638, ODDSBORNE latest `pm_pnl.cash`, BANDIT latest `meme_pnl.cash_sol` |
| Applies to | New entries and **adds** |
| Never applies to | Sells, trims, closes, kill-criteria exits, time stops |
| Confidence gate | **QUANTANAMO equity entries only**: autonomous buys need a `hardening` thesis with **gate score** ≥ 80 (`results_basis.gate_score`: the results score shrunk toward 50 by a prior of 16 zero-mean trades, so 3–9 live trades have to be surer than the raw score says). The shown results score is not the gate. Stated confidence never opens it; an unscored thesis (< 3 live trades) returns `quantanamo_unscored` and David approves |
| Portfolio exposure | Open risk ≤ 10% of book per steward: equities to invalidation, ODDSBORNE binaries and BANDIT memes at full notional (`risk_basis`); guidance sizes a new entry down to fit, or returns `exposure_cap` |
| ODDSBORNE and BANDIT | No confidence gate; `max_stake` is the throttle. They may enter at the returned size at any confidence |
| Rejected or killed thesis | No new entries for any steward (`entry_allowed = false`, `sized_notional = 0`, reason `thesis_rejected` / `thesis_killed`) |
| Learned rules | Beliefs and lessons in force (`belief_updates` with `meta.kind = 'playbook_rule'`, `research_lessons`) stay in force. They're scored by outcomes, not fixed rails |
| Clip sizes (BANDIT, ODDSBORNE) | No fixed clip. A steward's usual clip is the *requested* size; `max_stake` and cash set what actually goes on |

## Edge-scaled max stake

`requested` is not trusted on its own. Every entry is bounded by a per-thesis `max_stake` derived from measured edge, with small-sample shrinkage (`private.edge_max_stake`; court rulings [edge-max-stake](rules/edge-max-stake.md), [starter-stake](rules/starter-stake.md), [drawdown-scaling](rules/drawdown-scaling.md), [backtest-evidence-credit](rules/backtest-evidence-credit.md)):

- `r_i = realized_pnl / cost` for each priced, non-paper closed trade on the thesis (the whole steward's trades when the thesis is null). `n`, `mean(r)`, `sd(r)`.
- **Backtest evidence (pass or fail, live-gated; migration 47).** A row in `public.thesis_backtest_evidence` counts when it is **verified**: its `strategy_tests` row is `survived` or `killed` (placeholder, lookahead_invalid, queued and unverified tests earn nothing), carries a price source and a date window, had its rules locked before its results (`rules_locked_at < results_at`, both copied from the test / research cycle), has a stored deflated Sharpe at a trial count ≥ the tests the thesis had run by then, and is `out_of_sample`, `costs_included` and active (`verified` / `ineligible_reason` on the row). There is **no backtest credit until the thesis has 3 live trades**. Then the pooled weight is `w = min(Σ 0.5 × n, 5, n / 2) × survivor factor` (a survivors-only test's factor is `1 − missing_share`) and the credited mean is `deflated Sharpe × spread`, pass or fail, no further shrink: `n_eff = n + w`, `mean = (n·mean_live + w·mean_bt) / n_eff`, spread = the live spread. A test whose point-in-time inputs are unverified (a `*point_in_time` param not `true`, e.g. test 32) or that filters another test's events on the same thesis (`parent_test_id`, e.g. test 32 of test 31) gets no row: it counts as a trial, never as more evidence. Stewards can only append rows (one per test). Every other completed thesis test must be logged; `public.v_backtest_tests_unlogged` lists any that aren't. One-sigma lower bound `LCB = mean − sd / √n_eff`.
- **Unproven** (n_eff < 10, or LCB ≤ 0): `max_stake = starter` = `0.03 / bet_vol` × current book. `bet_vol` (`private.steward_bet_vol`) is the sd of return on stake over the steward's closed priced non-paper trades, floored at 0.25 (so the starter is at most 12% of book), and 1.0 while the steward has fewer than 5 trades. Every unproven bet therefore risks about the same 3% of book in volatility terms, whatever the instrument.
- **Proven** (n_eff ≥ 10 and LCB > 0): `max_stake = max(starter, min(book_equity × 0.5 × LCB / sd², starter × 2^(1 + (n_eff − 10) / 5)))`. That is half-Kelly on the lower bound, never faster than doubling every 5 proven trades.
- **Drawdown scale (steward-wide).** × 1 while the book is within 10% of its closing high-water mark (max of each UTC day's last book observation), falling linearly to × 0.5 at ≥ 40% below it (`private.steward_drawdown`). It applies to every thesis, new or old, so registering a new thesis never escapes it. The old per-thesis consecutive-loss halving is **repealed** ([loss-streak-halving](rules/loss-streak-halving.md): loss streaks carried no information, P(loss | loss) 0.53 vs P(loss) 0.51).

| Steward | Unit | Bet vol (sd of return on stake) | Starter share | Starter at the 2026-09-26 book | Drawdown scale on 2026-09-26 |
|---|---|---|---|---|---|
| QUANTANAMO | USD | 0.222 → floor 0.25 | 12% | $660 (book $5,501) | × 1 (9.8% below $6,099) |
| ODDSBORNE | USD | 1.957 | 1.53% | $4.24 (book $277) | × 0.5 (47.2% below $525) → $2.12 |
| BANDIT | SOL | 0.449 | 6.68% | 0.1205 SOL (book 1.80) | × 0.987 (10.8% below 2.02) → 0.119 |

The level v = 3% was decided on 2026-09-26 (migration 41; the court's options are in [SIMULATION.md](rules/SIMULATION.md)). The share moves as each steward's bet volatility moves. The cap grows with n_eff and LCB and shrinks only in a book drawdown. `public.v_thesis_max_stake` (or `public.thesis_max_stakes()`) lists the current value, reason, n and LCB per live thesis. Guidance returns `max_stake`, `max_stake_reason`, `edge_trades` and `edge_lcb`. The results score (below) is sample-size aware through its standard error.

## Required invalidation and a fresh book

- **Invalidation.** Pass the planned `invalidation_price` as the 5th guidance argument (and the entry price as the optional 6th, `p_entry_price`, in the same unit): USD per share, outcome price, or SOL per token. Without it, guidance returns `entry_allowed = false`, `sized_notional = 0`, `entry_blocked_reason = 'missing_invalidation'`. The database enforces the same rule: `private.require_lot_invalidation` rejects any insert (or re-open, or clear) of an `open` row in `position_episodes`, `pm_positions` or `meme_positions` whose `invalidation_price` is null (SQLSTATE 23514, message `missing_invalidation`). Lots that existed before this change are grandfathered.
- **Fresh book.** Guidance sizes only from a book and cash observation no older than 6 hours (`book_age_minutes`). Otherwise it returns `entry_blocked_reason = 'stale_book'` with size 0. QUANTANAMO: record a fresh `account_snapshots` row before sizing. ODDSBORNE and BANDIT: refresh `pm_pnl` / `meme_pnl` first.

Reason priority: `unknown_thesis` > `thesis_rejected` > `thesis_killed` > `quantanamo_requires_thesis` > `quantanamo_unscored` > `quantanamo_confidence_gate` > `missing_invalidation` > `stale_book` > `exposure_cap` (ODDSBORNE and BANDIT skip the three `quantanamo_*` reasons).

## Portfolio exposure: 10% of book at risk

Court ruling [portfolio-exposure](rules/portfolio-exposure.md), migrations 41 and 44. Per steward, **open risk** is the sum over open lots in the book's unit, on the book's `risk_basis`:

| Steward | `risk_basis` | Per lot |
|---|---|---|
| QUANTANAMO | `to_invalidation` | `qty × max(mark − invalidation_price, 0)`: what the lot loses if it falls to its own line. No invalidation: `qty × mark`. Unmarked: 0, flagged (`lots_unmarked`). |
| ODDSBORNE | `full_notional` | `contracts × price` (mark, else average cost). A binary goes to 0 on one score, so the line bounds nothing. |
| BANDIT | `full_notional` | full cost basis, `qty × average cost` (else `qty × mark`). A meme can rug in one block. |

The budget is `private.risk_budget_share()` = 10% of book. `public.v_exposure_lots` lists each lot's risk.

- Guidance sizes a new entry to fit the headroom: `exposure fit = headroom / risk fraction`. The fraction is 1 on the `full_notional` books; for equities it is `(entry − invalidation) / entry` when you pass the entry price as the 6th argument (`p_entry_price`), else 1. BANDIT's budget (0.180 SOL on 2026-09-26) against its 0.119 SOL starter makes it effectively one clip at a time (one open clip leaves 0.061 SOL of headroom); ODDSBORNE's $27.69 budget holds about 13 of today's $2.12 tickets.
- No headroom left: `entry_allowed = false`, `sized_notional = 0`, `entry_blocked_reason = 'exposure_cap'`. Sells never apply. Risk comes down by exiting, or by raising a lot's invalidation toward its mark.
- Guidance also returns `open_risk`, `risk_budget`, `risk_headroom`, `entry_risk_fraction` and `risk_basis`.
- `public.v_exposure_usage` (or `private.steward_open_risk(steward)`) lists usage per steward. `v_ledger_watchdog` has `exposure_over_budget` and an `exposure` summary.

On 2026-09-26 QUANTANAMO's open risk was $654 = 11.9% of $5,501 (NBIS $161, CIFR $186, CODA $308 at the 9/25 after-hours marks), over budget. At 3:08 PM PT it raised all three lines above cost (NBIS 220.80, CIFR 16.50, CODA 10.35), which brought it to $351 = 6.4% (NBIS $80, CIFR $79, CODA $193). ODDSBORNE and BANDIT had no open lots (0%).

## Results score and re-scoring

Court rulings [outcome-rescore-confidence](rules/outcome-rescore-confidence.md) and [quantanamo-80-gate](rules/quantanamo-80-gate.md), migration 41. A thesis is scored on **expected return per trade**, not hit rate, so an asymmetric winner earns its score.

`private.thesis_results_score(thesis_id)`:

- Live: `r_i = realized_pnl / cost` over the thesis's priced, non-paper closed trades (`n`, mean, sd).
- Backtest: verified tests, pass or fail (same evidence as the max stake), add `w = min(Σ 0.5 × n_bt, 5, n / 2) × survivor factor` once the thesis has 3 live trades, with mean = deflated Sharpe × spread. `n_eff = n + w`, pooled mean, `sd_eff = max(live sd, 0.25)`.
- `results_confidence = round(100 × Φ(mean_eff / (sd_eff / √n_eff)))` when the thesis has **≥ 3 live trades**, else null (**unscored**). It is P(expected return per trade > 0).
- Backtest only: unscored. Backtests can't score a thesis or open the QUANTANAMO 80 gate on their own, and they are at most a third of `n_eff` (never more than 5 effective trades).

`private.rescore_thesis_confidence(thesis_id)` writes `theses.results_confidence`, `results_basis` and `results_scored_at`, and sets `theses.confidence` (the display number the desk chips read) to the results score when scored, else the stated number (`theses.stated_confidence`).

- **Demote** `hardening → forming` only when the live upper bound `mean + max(sd, 0.25)/√n < 0`, or `n ≥ 10` with a negative mean. **Kill** only when `n ≥ 10` and the upper bound is below 0. (Was: Beta on hit rate, cap 60, demote at n ≥ 5 with negative P/L.)
- Runs from a trigger after every `trade_outcomes` insert (and updates to realized P/L, thesis or paper flag) and after changes to `thesis_backtest_evidence`. Manual or nightly: `select private.rescore_all_thesis_confidence();`
- Every change goes to `belief_updates` with `meta.kind = 'outcome_rescore'`, rule `results_score_v2`.
- A steward that writes `theses.confidence` sets its stated view only; a steward write never changes status. Only the re-score writes the results columns (trigger `theses_results_guard` ignores anything else).

Scores on 2026-09-26: `weather_same_day_high` 79, `meme_4h_momentum_clip` 60, `earnings_gap_structure` 56; `neocloud_compute` (1 trade) and `semis_photonics` (0) unscored. No QUANTANAMO thesis passes the gate, so every QUANTANAMO entry needs David until one earns ≥ 80.

## QUANTANAMO: enforced in code

`workers/research` (retired code, left as is) (`approvedCandidate` / `sizeBuyNotional`, position-decision adds) takes the thesis multiplier from `public.thesis_sizing()` (through cloud-control context) and fails closed when it's missing. The notional is `requested % of live NAV × multiplier`, limited by `min(cash, buying_power)`. The broker gateway has **no fixed rails**. It only runs mechanical checks: a valid quantity and notional (a sell within available shares; a reduce smaller than a full exit), buying power, cash (a buy that would need margin is rejected), a fresh uncrossed quote, no same-symbol order already pending, and an open US regular session (orders are regular-hours market orders). Adds are `requested % × multiplier` like entries: no fixed add %, add count, spacing or averaging-down rule. Reduces use the model's requested partial %: no fixed band. Wide spreads and the first and last 15 minutes of the session are guidance, not blocks.

`steward_sizing_guidance` refuses a thesis id that names no thesis, for every steward: `entry_allowed = false`, `sized_notional = 0`, `entry_blocked_reason = 'unknown_thesis'`. A null thesis is unchanged. QUANTANAMO still requires a thesis (`quantanamo_requires_thesis`), while ODDSBORNE and BANDIT size untagged entries at the steward-level max stake.

There is no global stop-loss and no portfolio drawdown limit (a book drawdown only scales the size of new entries; it never forces an exit). Exits come from the position's own written invalidation, read in this order:

1. **The lot.** The steward writes it on the open lot: `position_episodes.invalidation_price` (USD per share) and `position_episodes.invalidation_note` (text). When a fresh **regular-session** price (NYSE core session: 09:30–16:00 America/New_York Mon–Fri, 13:00 on early-close days, never on an exchange holiday; `public.us_equity_market_calendar` / `NYSE_CALENDAR`, source nyse.com/markets/hours-calendars, 2026–2028) is at or below `invalidation_price`, the lot exits in full, because it has hit its own definition. A pre-market or after-hours print at or below the line does **not** exit: the decision is `hold` with `review_at_open: true` (trigger `lot_invalidation_price_extended_hours`), and the lot is re-read on the next regular-session print (monitor policy `autonomous-position-v5`, execution `autonomous-equity-v8`). An `invalidation_note` counts as the written invalidation for the confirmed exit below, and it is read before the thesis.
2. **The linked thesis.** `theses.falsifier`. The position review prefers the thesis linked to the position episode.

A written invalidation (the lot note or the thesis falsifier) triggers an exit only once it is confirmed: the model says the thesis is invalidated with confidence ≥ 90, and there is deterministic adverse evidence. If neither the lot nor a linked thesis has a written invalidation, the exit is left to the steward's judgment and its learned beliefs.

`pm_positions` and `meme_positions` have the same two columns, priced in each row's own unit (outcome price, or SOL per token). Prediction markets and coins trade around the clock, so there is no session filter for them: any mark at or below the line is a breach. ODDSBORNE and BANDIT apply them in their own exit logic. Each book's worker role can update the columns on its own table. The desk holdings line shows the invalidation chip for stock, prediction-market and coin lots, each in its own unit.

## Backstop watchdog

The automated position monitor is retired, so the ledger watches itself with read-only views (security invoker; granted to `authenticated`, `quantanamo_worker`, `desk_public_reader`). They never invent a mark: a lot without a ledger mark is reported as `open_lot_no_mark`, never as a breach.

| View | What it lists |
|---|---|
| `public.v_ledger_watchdog` | one row of counts: `invalidation_breaches`, `breaches_actionable`, `breaches_review_at_open`, `lots_missing_invalidation`, `integrity_issues`, `integrity_errors`, `integrity` (per check), `open_lots` |
| `public.v_invalidation_breaches` | open lots whose latest ledger mark is at or below `invalidation_price`, with steward, table, unit, mark age, lot age and `action_hint` (`exit_full_lot`, or `review_at_open` for an equity marked outside the regular session) |
| `public.v_open_lots_missing_invalidation` | open lots with no `invalidation_price` |
| `public.v_ledger_integrity` | open lot without thesis, no mark, stale mark (>24h equities/PM, >6h coins), lot vs broker quantity mismatch, broker position without a lot, fill without a position, buy order without a thesis, broker fill without an intent, entry over max_stake (a live buy, buy intent, or intent-less new lot whose filled size is above the `max_stake_at_entry` snapshotted on that row + 10%: an entry that bypassed guidance; a cap that shrinks later never flags an old entry) |
| `public.v_open_lot_marks` | every open lot with its latest mark in its own unit |
| `public.v_thesis_max_stake` | the edge-scaled cap per live thesis |

The counts are in `/api/health` (`watchdog`), in the desk payload (`watchdog`), and in `build_dashboard_snapshot()` (`watchdog`, plus `scorecard`). The ledger health routine should run `select * from public.v_ledger_watchdog;` and list the rows from the breach, missing and integrity views when a count is above zero. It should also run `select * from public.v_backtest_tests_unlogged;`: any row is a completed, preregistered thesis test that hasn't been logged as backtest evidence (pass or fail, every one gets logged; see [backtest-evidence-credit](rules/backtest-evidence-credit.md)). On the box it should also run `bash /workspace/grasshopper/stewards/doctor.sh`: exit 1 means a steward's Python env is missing or broken (a box refresh wipes `.venv/`). Report it, and fix it with `bash /workspace/grasshopper/stewards/sync_box.sh` (see `stewards/README.md`). The database can't see the box, so this check isn't in `v_ledger_watchdog`.

The deprecated intent fields (`maxTradePercent`, `maxDailyNotionalPercent`, `maxTradesPerDay`, `maxSpreadBps`) are no longer sent, and the gateway ignores them.

## ODDSBORNE and BANDIT: guidance (not a DB guard)

Before any **buy/add**, call:

```sql
-- BANDIT: instrument = mint or symbol; unit is SOL; requested = the clip you'd take at full size
select * from public.steward_sizing_guidance('bandit', 'meme_4h_momentum_clip', '<mint>', 0.45, <invalidation SOL/token>);
-- ODDSBORNE: instrument = pm_markets.slug or id; unit is USD
select * from public.steward_sizing_guidance('oddsborne', '<thesis_id>', '<market slug>', <requested usd>, <invalidation outcome price>);
-- QUANTANAMO: select * from public.steward_sizing_guidance('quantanamo', '<thesis_id>', '<SYMBOL>', <requested usd>, <invalidation usd/share>);
```

The call returns `book_equity`, `spendable_cash`, `current_position_value`, `requested`, sample stats (`sample_trades`, `sample_wins`, `hit_rate`, `avg_win`, `avg_loss`), `sized_notional = min(requested, max_stake, spendable_cash)`, `max_stake` / `max_stake_reason`, and the thesis's `thesis_confidence` / `stated_confidence` / `thesis_status`. Leave out `requested` to get just the caps and gates. Only the worker roles (`quantanamo_worker`, `oddsborne_worker`, `bandit_worker`) and `service_role` can execute it. `public.thesis_sizing()` returns one row per thesis.

Entry fields:

| Field | QUANTANAMO | ODDSBORNE / BANDIT |
|---|---|---|
| `gate_applies` | `true` | `false` |
| `autonomous_buy_gate_pass` | `hardening` and `results_confidence` ≥ 80 (null with no thesis) | `true` unless the thesis is rejected or killed |
| `thesis_rejected` / `thesis_killed` | `theses.status` = `'rejected'` / `'killed'` | same |
| `entry_allowed` | the gate passes, an invalidation is given, the book is fresh, and there is exposure headroom | the thesis is known and not rejected or killed, an invalidation is given, the book is fresh, and there is exposure headroom |
| `entry_blocked_reason` | `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `quantanamo_requires_thesis`, `quantanamo_unscored`, `quantanamo_confidence_gate`, `missing_invalidation`, `stale_book`, `exposure_cap` | `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `missing_invalidation`, `stale_book`, `exposure_cap` or null |

**Before a buy, read `entry_allowed`, then size to `sized_notional`.** A rejected or killed thesis returns `sized_notional = 0`. Sells and exits never go through this call.

Example (ledger on 2026-09-26 ~15:00 PT, after migration 41): a 0.45 SOL BANDIT clip on `meme_4h_momentum_clip` (unproven) sizes to `max_stake` **0.119 SOL** (starter 0.1205 × drawdown scale 0.987). An ODDSBORNE $20 request sizes to **$2.12** (starter $4.24 × 0.5, book 47% below its high). A QUANTANAMO request on `neocloud_compute` is blocked (`quantanamo_unscored`, and QUANTANAMO is also over its exposure budget); its `max_stake` would be **$660**.

Size is **not** a DB reject guard (the invalidation is). ODDSBORNE and BANDIT record orders after the venue accepts them. The cap-breach audit view from #84 has been dropped, and the `thesis-notional` risk control is retired.

## Thesis links follow the source position

A `thesis_id` change on a source position row (`meme_positions`, `pm_positions`, `position_episodes`) now propagates to its `trade_outcomes` row through the `trade_outcome_thesis_sync` trigger. That trigger fires for any origin (trigger, backfill or manual) and records the change in `meta.thesis_relinked`. The re-score trigger then updates both the old and the new thesis. `manual_backfill` outcomes have no source position, so tag the outcome row directly and note why in `meta.retro_tag`.

## Re-pricing after fill backfills

Outcome P/L can be re-run from fills. New or corrected rows in `broker_fills`, `meme_fills` (fee_sol / price / qty) and `pm_fills` re-price the affected outcome automatically. To force a full refresh:

```sql
select private.reprice_trade_outcomes('oddsborne');   -- or 'quantanamo', 'bandit', null = all
select private.rescore_all_thesis_confidence();
```

QUANTANAMO rows priced from balanced broker fills get `pnl_source = 'fills'`, and the previous numbers are kept in `meta.repriced_from`. ODDSBORNE rows are priced from venue-keyed `pm_fills`: `fills` when buys equal sells, and `settlement` when the rest was held to resolution (the held quantity pays 1 if that side won, otherwise 0). Fees are the net venue fee, where maker rebates are negative. A fill with no venue execution id, or an aggregated placeholder, blocks pricing (`fills_suspect`). Venue liquidity rewards live in `pm_notes` and are never trade P/L. BANDIT fees come from `meme_fills.fee_sol`. The desk fees line shows `sum(meme_fills.fee_sol)`, not `meme_pnl.fees`.

## Cap at entry

`pm_orders`, `meme_orders`, `trade_intents` (buys) and `position_episodes` (new open lots) carry `max_stake_at_entry`, `max_stake_reason_at_entry` and `max_stake_snapshot_at`. Stewards pass the `max_stake` / `max_stake_reason` their guidance call returned; a row inserted without them gets the same `private.edge_max_stake` value from a BEFORE INSERT trigger (`private.snapshot_entry_max_stake`, never blocks). `entry_over_max_stake` compares with that snapshot only.

## Session calendar

`public.us_regular_session_open(timestamptz default now())` answers "is the NYSE core session open" with holidays and 13:00 ET early closes. The watchdog (`private.is_us_regular_session`), `position-decision` (`isRegularSession`), the broker gateway and the research schedule gate all use the same calendar (`packages/contracts/src/market-calendar.ts`, tested equal to the SQL rows). Add the next year to both when NYSE publishes it.
