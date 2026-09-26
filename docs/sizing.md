# Sizing: outcomes set the size, 20% of book is the hard cap

Position size follows results. Each thesis's confidence gets re-scored from its closed trades, and each new entry or add gets scaled by a half-Kelly multiplier. There is one hard cap: **a single position may not exceed 20% of that steward's book**. This replaces the old 5% rule. There are no other new hard caps.

## The rules

| Rule | Value |
|---|---|
| Single-position cap | 20% of the steward's own book (QUANTANAMO: Agentic 7638 total value, ODDSBORNE: latest `pm_pnl.equity`, BANDIT: latest `meme_pnl.equity_sol`) |
| Applies to | New entries and **adds** only |
| Never applies to | Sells, trims, closes, kill-criteria exits, time stops |
| Existing oversize positions | Grandfathered. No forced trim, but no adds while above the cap (`add_headroom = 0`) |
| Multiplier | Half-Kelly from the thesis's closed `trade_outcomes`: `clamp((kelly / 2) / 0.20, 0.25, 1.0)`. Uses **0.5 when n < 5**, 0.25 when there are no wins yet, 1.0 when there are no losses yet |
| Size | `requested × multiplier`, then capped at `add_headroom` (and at buying power / wallet cash) |

## Confidence re-scoring

`private.rescore_thesis_confidence(thesis_id)` uses a Beta prior with k = 10 pseudo-trades, centered on the thesis's **stated** confidence (`theses.stated_confidence`, i.e. the latest numeric belief update written by a steward). It then updates on wins / trades from `trade_outcomes`: `round(100 × (k·p + wins) / (k + n))`. When n ≥ 5 and summed P/L is negative, confidence is capped at 60 and a `hardening` thesis is demoted to `forming`.

- The re-score runs from a trigger after every insert on `trade_outcomes` (and on updates to realized P/L, thesis or paper flag).
- Wrapper for a nightly or manual run: `select private.rescore_all_thesis_confidence();`
- Every change is written to `belief_updates` with `meta.kind = 'outcome_rescore'`.
- A steward that writes `theses.confidence` sets its stated view. The trigger then tempers that by outcomes, so `theses.confidence` always shows the outcome-adjusted number. The desk chips read this number.

## QUANTANAMO: enforced in code

`workers/research` (`approvedCandidate` / `sizeBuyNotional`, position-decision adds / `positionCapHeadroom`) takes the thesis multiplier from `public.thesis_sizing()` (through cloud-control context) and fails closed when it's missing. The broker gateway policy rejects any buy that would take a name above 20% of total value. Sells are never capped.

## ODDSBORNE and BANDIT: guidance (not a DB guard)

Before any **buy/add**, call:

```sql
-- BANDIT: instrument = mint or symbol; unit is SOL
select * from public.steward_sizing_guidance('bandit', 'meme_4h_momentum_clip', '<mint>');
-- ODDSBORNE: instrument = pm_markets.slug or id; unit is USD
select * from public.steward_sizing_guidance('oddsborne', '<thesis_id>', '<market slug>');
```

The call returns `book_equity`, `cap_notional` (20% of book), `current_position_value`, `add_headroom`, `multiplier` (+ `multiplier_basis`, sample stats, `half_kelly_fraction`), and the thesis's `thesis_confidence` / `stated_confidence` / `thesis_status`. Size = `min(requested × multiplier, add_headroom)`. If `add_headroom = 0`, do not add. Only the worker roles (`quantanamo_worker`, `oddsborne_worker`, `bandit_worker`) and `service_role` can execute it. `public.thesis_sizing()` returns one row per thesis.

Example: with a 1.88 SOL book, BANDIT's cap is about 0.376 SOL per position, so the old 0.45 SOL standard clip is now over the cap.

The cap is **not** a DB reject guard. ODDSBORNE and BANDIT record orders after the venue accepts them, so a reject trigger would drop ledger rows for trades that really happened instead of preventing them. The audit view `public.v_sizing_cap_breaches` lists any live buy that exceeded 20% of book at the time of the order.

## Re-pricing after fill backfills

Outcome P/L can be re-run from fills. New or corrected rows in `broker_fills`, `meme_fills` (fee_sol / price / qty) and `pm_fills` re-price the affected outcome automatically. To force a full refresh:

```sql
select private.reprice_trade_outcomes('oddsborne');   -- or 'quantanamo', 'bandit', null = all
select private.rescore_all_thesis_confidence();
```

QUANTANAMO rows priced from balanced broker fills get `pnl_source = 'fills'`, and the previous numbers are kept in `meta.repriced_from`. ODDSBORNE backfill rows are only upgraded once `pm_fills` fully cover the round trip. BANDIT fees come from `meme_fills.fee_sol`. The desk fees line shows `sum(meme_fills.fee_sol)`, not `meme_pnl.fees`.
