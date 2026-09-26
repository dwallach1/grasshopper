# Sizing: results set the size, no hard cap per position, no fixed rails

Position size follows results, and there is **no hard cap per position** (David, 2026-09-26). The other fixed trading rails are gone too ("Kill the old rules!"): no trade count, spread block, 09:45–15:45 window, fixed add %, add count or spacing, reduce band, or averaging-down ban. This reverses the 20%-of-book cap from #84, and the old fixed 5% per-order rule is gone too. Each thesis's confidence is re-scored from its closed trades, and each new entry or add is scaled by a half-Kelly multiplier. The only hard limit on size is mechanical: a buy can't spend more cash than the steward actually has (no margin).

## The rules

| Rule | Value |
|---|---|
| Per-position cap | **None** |
| Multiplier | Half-Kelly from the thesis's closed `trade_outcomes`: `clamp((kelly / 2) / 0.20, 0.25, 1.0)`. Uses **0.5 when n < 5**, 0.25 when there are no wins yet (or no edge), 1.0 when there are no losses yet. The 0.20 is only a scale reference (a half-Kelly of 20% of book = full size); it does not cap anything |
| Size | `requested × multiplier`, limited only by spendable cash: QUANTANAMO `min(cash, buying_power)` on Agentic 7638, ODDSBORNE latest `pm_pnl.cash`, BANDIT latest `meme_pnl.cash_sol` |
| Applies to | New entries and **adds** |
| Never applies to | Sells, trims, closes, kill-criteria exits, time stops |
| Confidence gate | **QUANTANAMO equity entries only**: autonomous buys need a `hardening` thesis with outcome-adjusted confidence ≥ 80 |
| ODDSBORNE and BANDIT | No confidence gate; the multiplier is the throttle. They may enter at the returned size at any confidence |
| Rejected or killed thesis | No new entries for any steward (`entry_allowed = false`, `sized_notional = 0`, reason `thesis_rejected` / `thesis_killed`) |
| Learned rules | Beliefs and lessons in force (`belief_updates` with `meta.kind = 'playbook_rule'`, `research_lessons`) stay in force. They're scored by outcomes, not fixed rails |
| Clip sizes (BANDIT, ODDSBORNE) | No fixed clip. A steward's usual clip is the *requested* size; the multiplier sets what actually goes on |

## Confidence re-scoring

`private.rescore_thesis_confidence(thesis_id)` uses a Beta prior with k = 10 pseudo-trades, centered on the thesis's **stated** confidence (`theses.stated_confidence`, i.e. the latest numeric belief update written by a steward). It then updates on wins / trades from `trade_outcomes`: `round(100 × (k·p + wins) / (k + n))`. When n ≥ 5 and summed P/L is negative, confidence is capped at 60 and a `hardening` thesis is demoted to `forming`.

- The re-score runs from a trigger after every insert on `trade_outcomes` (and on updates to realized P/L, thesis or paper flag).
- Wrapper for a nightly or manual run: `select private.rescore_all_thesis_confidence();`
- Every change is written to `belief_updates` with `meta.kind = 'outcome_rescore'`.
- A steward that writes `theses.confidence` sets its stated view. The trigger then tempers that by outcomes, so `theses.confidence` always shows the outcome-adjusted number. The desk chips read this number.

## QUANTANAMO: enforced in code

`workers/research` (`approvedCandidate` / `sizeBuyNotional`, position-decision adds) takes the thesis multiplier from `public.thesis_sizing()` (through cloud-control context) and fails closed when it's missing. The notional is `requested % of live NAV × multiplier`, limited by `min(cash, buying_power)`. The broker gateway has **no fixed rails**. It only runs mechanical checks: a valid quantity and notional (a sell within available shares; a reduce smaller than a full exit), buying power, cash (a buy that would need margin is rejected), a fresh uncrossed quote, no same-symbol order already pending, and an open US regular session (orders are regular-hours market orders). Adds are `requested % × multiplier` like entries: no fixed add %, add count, spacing or averaging-down rule. Reduces use the model's requested partial %: no fixed band. Wide spreads and the first and last 15 minutes of the session are guidance, not blocks.

One fixed protective rule is still in code: the −8% hard-loss exit on a position (`hard_loss_exit_percent`). The `portfolio-drawdown` risk control (8%) is also still active, as text only (nothing enforces it). Both are exits, not limits on entries. Neither was on the removal list.

The deprecated intent fields (`maxTradePercent`, `maxDailyNotionalPercent`, `maxTradesPerDay`, `maxSpreadBps`) are no longer sent, and the gateway ignores them.

## ODDSBORNE and BANDIT: guidance (not a DB guard)

Before any **buy/add**, call:

```sql
-- BANDIT: instrument = mint or symbol; unit is SOL; requested = the clip you'd take at full size
select * from public.steward_sizing_guidance('bandit', 'meme_4h_momentum_clip', '<mint>', 0.45);
-- ODDSBORNE: instrument = pm_markets.slug or id; unit is USD
select * from public.steward_sizing_guidance('oddsborne', '<thesis_id>', '<market slug>', <requested usd>);
```

The call returns `book_equity`, `spendable_cash`, `current_position_value`, `requested`, `multiplier` (+ `multiplier_basis`, sample stats, `half_kelly_fraction`), `sized_notional = min(requested × multiplier, spendable_cash)`, and the thesis's `thesis_confidence` / `stated_confidence` / `thesis_status`. Leave out `requested` to get just the multiplier. Only the worker roles (`quantanamo_worker`, `oddsborne_worker`, `bandit_worker`) and `service_role` can execute it. `public.thesis_sizing()` returns one row per thesis.

Entry fields:

| Field | QUANTANAMO | ODDSBORNE / BANDIT |
|---|---|---|
| `gate_applies` | `true` | `false` |
| `autonomous_buy_gate_pass` | `hardening` and confidence ≥ 80 (null with no thesis) | `true` unless the thesis is rejected or killed |
| `thesis_rejected` / `thesis_killed` | `theses.status` = `'rejected'` / `'killed'` | same |
| `entry_allowed` | the gate passes | the thesis is not rejected or killed |
| `entry_blocked_reason` | `thesis_rejected`, `thesis_killed`, `quantanamo_confidence_gate` or `quantanamo_requires_thesis` | `thesis_rejected`, `thesis_killed` or null |

**Before a buy, read `entry_allowed`, then size to `sized_notional`.** A rejected or killed thesis returns `sized_notional = 0`. Sells and exits never go through this call.

Example (ledger on 2026-09-26): BANDIT's book is 1.84 SOL, with 1.46 SOL cash. A 0.45 SOL clip on `meme_4h_momentum_clip` (3 closed trades, so the multiplier is still 0.5) sizes to **0.225 SOL**. With no thesis, the steward multiplier is 0.25 (34 trades, no edge) → 0.1125 SOL.

Size is **not** a DB reject guard. ODDSBORNE and BANDIT record orders after the venue accepts them. The cap-breach audit view from #84 has been dropped, and the `thesis-notional` risk control is retired.

## Thesis links follow the source position

A `thesis_id` change on a source position row (`meme_positions`, `pm_positions`, `position_episodes`) now propagates to its `trade_outcomes` row through the `trade_outcome_thesis_sync` trigger. That trigger fires for any origin (trigger, backfill or manual) and records the change in `meta.thesis_relinked`. The re-score trigger then updates both the old and the new thesis. `manual_backfill` outcomes have no source position, so tag the outcome row directly and note why in `meta.retro_tag`.

## Re-pricing after fill backfills

Outcome P/L can be re-run from fills. New or corrected rows in `broker_fills`, `meme_fills` (fee_sol / price / qty) and `pm_fills` re-price the affected outcome automatically. To force a full refresh:

```sql
select private.reprice_trade_outcomes('oddsborne');   -- or 'quantanamo', 'bandit', null = all
select private.rescore_all_thesis_confidence();
```

QUANTANAMO rows priced from balanced broker fills get `pnl_source = 'fills'`, and the previous numbers are kept in `meta.repriced_from`. ODDSBORNE rows are priced from venue-keyed `pm_fills`: `fills` when buys equal sells, and `settlement` when the rest was held to resolution (the held quantity pays 1 if that side won, otherwise 0). Fees are the net venue fee, where maker rebates are negative. A fill with no venue execution id, or an aggregated placeholder, blocks pricing (`fills_suspect`). Venue liquidity rewards live in `pm_notes` and are never trade P/L. BANDIT fees come from `meme_fills.fee_sol`. The desk fees line shows `sum(meme_fills.fee_sol)`, not `meme_pnl.fees`.
