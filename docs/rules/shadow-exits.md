# Shadow (paper) exit tracking

`rule_id: shadow-exits` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2026-11-26

## Purpose (failure prevented)
Test alternative exit rules without trading them. Promote a rule only once it beats real exits.

## Mechanism
`meta.paper_<rule>` on lot rows; `v_shadow_exits`, `v_shadow_exit_scorecard` (promotable at n >= 10 and LCB of paper - real > 0).

Code paths:
- `supabase/schemas/32_shadow_exits.sql`
- `supabase/schemas/33_shadow_exits_definer.sql`

## The court

**GROWTH.** Positive: finds better exits at no cost.

**RUIN.** None.

**STATISTICS.** Same LCB bar as the stake rule; n = 4 today for bank_at_+20pct (LCB -10.5 pts).

**INCENTIVES / GAMING.** Promotion is by evidence.

## Evidence
Live scorecard.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | None. |

## Interactions
None.
