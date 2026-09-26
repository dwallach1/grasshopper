# Half-Kelly outcome multiplier on the requested size

`rule_id: confidence-multiplier` · status: **repealed** · verdict: **strike** · ruling 2026-09-26 · next review 2026-12-26

## Purpose (failure prevented)
Scaled requested size by a half-Kelly estimate from hit rate and avg win/loss (0.5 when n < 5, 0.25 with no edge).

## Mechanism
`sized_notional = min(requested x multiplier, max_stake, cash)`. Now `min(requested, max_stake, cash)`. The multiplier is still returned for information.

Code paths:
- `supabase/schemas/11_outcome_rescore_sizing.sql`
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/37_court_rulings.sql`

## The court

**GROWTH.** It halves an honest steward's size on every unproven thesis (n < 5 -> 0.5), on top of the starter that already exists for that.

**RUIN.** Adds nothing: max_stake already bounds every entry, with a proper lower-bound edge estimate.

**STATISTICS.** It uses raw hit rate and payoff with no shrinkage. At n = 5 a hit-rate estimate is +/- 22 points (1 sigma), so the multiplier is noise until n ~ 30, and the edge-scaled cap already handles small samples properly.

**INCENTIVES / GAMING.** Directly gameable: request 2x to get 1x. An honest steward is penalized, and a gaming one isn't.

## Evidence
Structural. BANDIT's 0.45 SOL clip x 0.5 = 0.225 was already capped by max_stake. The multiplier changed nothing for a steward requesting above the cap.

## Ruling
**STRIKE.** Strike from sizing. Keep reporting it.

Amendment: guidance: sized_notional = min(requested, max_stake, spendable cash). QUANTANAMO requested % is no longer multiplied (scheduled-run prompt). The retired workers/research mirror is left alone.

| Growth cost | Ruin-risk reduction |
|---|---|
| Raises honest sizes up to 2x (never above max_stake). | None lost (max_stake binds). |

## Interactions
edge-max-stake.
