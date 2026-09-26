# Sizing: results set the size, no hard cap per position, no fixed rails

Position size follows results, and there is **no hard cap per position** (David, 2026-09-26). The other fixed trading rails are gone too ("Kill the old rules!"): no trade count, spread block, 09:45–15:45 window, fixed add %, add count or spacing, reduce band, averaging-down ban, global stop-loss, or portfolio drawdown limit. This reverses the 20%-of-book cap from #84, and the old fixed 5% per-order rule is gone too. Each thesis's confidence is re-scored from its closed trades, each new entry or add is scaled by a half-Kelly multiplier, and each entry is bounded by an **edge-scaled max stake** that starts small and grows only with measured, proven edge (see below). A buy also can't spend more cash than the steward actually has (no margin).

## The rules

| Rule | Value |
|---|---|
| Per-position cap | **None** |
| Multiplier | Half-Kelly from the thesis's closed `trade_outcomes`: `clamp((kelly / 2) / 0.20, 0.25, 1.0)`. Uses **0.5 when n < 5**, 0.25 when there are no wins yet (or no edge), 1.0 when there are no losses yet. The 0.20 is only a scale reference (a half-Kelly of 20% of book = full size); it does not cap anything |
| Max stake | Edge-scaled per thesis, in the book's unit (see [Edge-scaled max stake](#edge-scaled-max-stake)). Starter while unproven: QUANTANAMO $250, ODDSBORNE $15, BANDIT 0.10 SOL |
| Size | `min(requested × multiplier, max_stake, spendable cash)`. Spendable cash: QUANTANAMO `min(cash, buying_power)` on Agentic 7638, ODDSBORNE latest `pm_pnl.cash`, BANDIT latest `meme_pnl.cash_sol` |
| Applies to | New entries and **adds** |
| Never applies to | Sells, trims, closes, kill-criteria exits, time stops |
| Confidence gate | **QUANTANAMO equity entries only**: autonomous buys need a `hardening` thesis with outcome-adjusted confidence ≥ 80 |
| ODDSBORNE and BANDIT | No confidence gate; the multiplier is the throttle. They may enter at the returned size at any confidence |
| Rejected or killed thesis | No new entries for any steward (`entry_allowed = false`, `sized_notional = 0`, reason `thesis_rejected` / `thesis_killed`) |
| Learned rules | Beliefs and lessons in force (`belief_updates` with `meta.kind = 'playbook_rule'`, `research_lessons`) stay in force. They're scored by outcomes, not fixed rails |
| Clip sizes (BANDIT, ODDSBORNE) | No fixed clip. A steward's usual clip is the *requested* size; the multiplier sets what actually goes on |

## Edge-scaled max stake

`requested` is not trusted on its own. Every entry is bounded by a per-thesis `max_stake` derived from measured edge, with small-sample shrinkage (`private.edge_max_stake`, 2026-09-26):

- `r_i = realized_pnl / cost` for each priced, non-paper closed trade on the thesis (the whole steward's trades when the thesis is null). `n`, `mean(r)`, `sd(r)`, and the one-sigma lower bound `LCB = mean − sd / √n`.
- **Unproven** (n < 10, or LCB ≤ 0): `max_stake = starter`.
- **Proven** (n ≥ 10 and LCB > 0): `max_stake = max(starter, min(book_equity × 0.5 × LCB / sd², starter × 2^(1 + (n − 10) / 5)))`. That is half-Kelly on the lower bound, never faster than doubling every 5 proven trades.
- **After losses:** × 0.5 per consecutive most-recent loss (at most two halvings, so never below 0.25 × the uncut value).

| Steward | Unit | Starter | Book on 2026-09-26 |
|---|---|---|---|
| QUANTANAMO | USD | 250 | ~$5,500 |
| ODDSBORNE | USD | 15 | ~$277 |
| BANDIT | SOL | 0.10 | ~1.79 SOL |

The starters are about 5% of each book. That isn't a rail: the cap grows with n and LCB and shrinks after losses. `public.v_thesis_max_stake` (or `public.thesis_max_stakes()`) lists the current value, reason, n and LCB per live thesis. Guidance returns `max_stake`, `max_stake_reason`, `edge_trades` and `edge_lcb`. The Beta-prior re-score (k = 10) already makes confidence sample-size aware. `max_stake` also bounds the noise in the half-Kelly multiplier at n = 5–9.

## Required invalidation and a fresh book

- **Invalidation.** Pass the planned `invalidation_price` as the 5th guidance argument: USD per share, outcome price, or SOL per token. Without it, guidance returns `entry_allowed = false`, `sized_notional = 0`, `entry_blocked_reason = 'missing_invalidation'`. The database enforces the same rule: `private.require_lot_invalidation` rejects any insert (or re-open, or clear) of an `open` row in `position_episodes`, `pm_positions` or `meme_positions` whose `invalidation_price` is null (SQLSTATE 23514, message `missing_invalidation`). Lots that existed before this change are grandfathered.
- **Fresh book.** Guidance sizes only from a book and cash observation no older than 6 hours (`book_age_minutes`). Otherwise it returns `entry_blocked_reason = 'stale_book'` with size 0. QUANTANAMO: record a fresh `account_snapshots` row before sizing. ODDSBORNE and BANDIT: refresh `pm_pnl` / `meme_pnl` first.

Reason priority: `unknown_thesis` > `thesis_rejected` > `thesis_killed` > `quantanamo_requires_thesis` > `quantanamo_confidence_gate` > `missing_invalidation` > `stale_book`.

## Confidence re-scoring

`private.rescore_thesis_confidence(thesis_id)` uses a Beta prior with k = 10 pseudo-trades, centered on the thesis's **stated** confidence (`theses.stated_confidence`, i.e. the latest numeric belief update written by a steward). It then updates on wins / trades from `trade_outcomes`: `round(100 × (k·p + wins) / (k + n))`. When n ≥ 5 and summed P/L is negative, confidence is capped at 60 and a `hardening` thesis is demoted to `forming`.

- The re-score runs from a trigger after every insert on `trade_outcomes` (and on updates to realized P/L, thesis or paper flag).
- Wrapper for a nightly or manual run: `select private.rescore_all_thesis_confidence();`
- Every change is written to `belief_updates` with `meta.kind = 'outcome_rescore'`.
- A steward that writes `theses.confidence` sets its stated view. The trigger then tempers that by outcomes, so `theses.confidence` always shows the outcome-adjusted number. The desk chips read this number.

## QUANTANAMO: enforced in code

`workers/research` (`approvedCandidate` / `sizeBuyNotional`, position-decision adds) takes the thesis multiplier from `public.thesis_sizing()` (through cloud-control context) and fails closed when it's missing. The notional is `requested % of live NAV × multiplier`, limited by `min(cash, buying_power)`. The broker gateway has **no fixed rails**. It only runs mechanical checks: a valid quantity and notional (a sell within available shares; a reduce smaller than a full exit), buying power, cash (a buy that would need margin is rejected), a fresh uncrossed quote, no same-symbol order already pending, and an open US regular session (orders are regular-hours market orders). Adds are `requested % × multiplier` like entries: no fixed add %, add count, spacing or averaging-down rule. Reduces use the model's requested partial %: no fixed band. Wide spreads and the first and last 15 minutes of the session are guidance, not blocks.

`steward_sizing_guidance` refuses a thesis id that names no thesis, for every steward: `entry_allowed = false`, `sized_notional = 0`, `entry_blocked_reason = 'unknown_thesis'`. A null thesis is unchanged. QUANTANAMO still requires a thesis (`quantanamo_requires_thesis`), while ODDSBORNE and BANDIT size untagged entries at the steward-level multiplier.

There is no global stop-loss and no portfolio drawdown limit. Exits come from the position's own written invalidation, read in this order:

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

The counts are in `/api/health` (`watchdog`), in the desk payload (`watchdog`), and in `build_dashboard_snapshot()` (`watchdog`, plus `scorecard`). The ledger health routine should run `select * from public.v_ledger_watchdog;` and list the rows from the breach, missing and integrity views when a count is above zero.

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

The call returns `book_equity`, `spendable_cash`, `current_position_value`, `requested`, `multiplier` (+ `multiplier_basis`, sample stats, `half_kelly_fraction`), `sized_notional = min(requested × multiplier, max_stake, spendable_cash)`, `max_stake` / `max_stake_reason`, and the thesis's `thesis_confidence` / `stated_confidence` / `thesis_status`. Leave out `requested` to get just the multiplier. Only the worker roles (`quantanamo_worker`, `oddsborne_worker`, `bandit_worker`) and `service_role` can execute it. `public.thesis_sizing()` returns one row per thesis.

Entry fields:

| Field | QUANTANAMO | ODDSBORNE / BANDIT |
|---|---|---|
| `gate_applies` | `true` | `false` |
| `autonomous_buy_gate_pass` | `hardening` and confidence ≥ 80 (null with no thesis) | `true` unless the thesis is rejected or killed |
| `thesis_rejected` / `thesis_killed` | `theses.status` = `'rejected'` / `'killed'` | same |
| `entry_allowed` | the gate passes, an invalidation is given, and the book is fresh | the thesis is known and not rejected or killed, an invalidation is given, and the book is fresh |
| `entry_blocked_reason` | `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `quantanamo_requires_thesis`, `quantanamo_confidence_gate`, `missing_invalidation`, `stale_book` | `unknown_thesis`, `thesis_rejected`, `thesis_killed`, `missing_invalidation`, `stale_book` or null |

**Before a buy, read `entry_allowed`, then size to `sized_notional`.** A rejected or killed thesis returns `sized_notional = 0`. Sells and exits never go through this call.

Example (ledger on 2026-09-26 ~11:00 PT): BANDIT's book is ~1.79 SOL, with 1.46 SOL cash. A 0.45 SOL clip on `meme_4h_momentum_clip` (3 closed trades, multiplier 0.5 → 0.225) is capped at `max_stake` **0.025 SOL** (unproven starter 0.10, halved twice after two straight losses). ODDSBORNE's $200 Miami request would now size to at most the $3.75–$15 cap instead of $100.

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
