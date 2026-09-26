# New-thesis escape from a loss-reduced cap

`rule_id: new-thesis-escape` · status: **repealed** · verdict: **strike** · ruling 2026-09-26 · next review 2026-10-26 · **needs David**

## Purpose (failure prevented)
The problem: per-thesis halving could be escaped by registering a new thesis. The first fix (steward-wide cap on every unproven thesis, #97) pinned QUANTANAMO themes at $62.50 and was reverted (#98).

## Mechanism
Resolved structurally. Loss halving is struck, and the only loss response is steward-wide drawdown scaling, which applies to every thesis, new or old. A new thesis gets the starter x the steward's drawdown scale, the same as any unproven thesis.

Code paths:
- `supabase/schemas/34_revert_steward_wide_starter.sql`
- `supabase/schemas/37_court_rulings.sql`

## The court

**GROWTH.** #97's rule cut QUANTANAMO's unproven themes 75% ($250 -> $62.50) because of 3 losses on another thesis. That's a large growth cost with no ruin case: loss streaks don't predict (see loss-streak-halving). The structural fix costs nothing.

**RUIN.** Covered by drawdown scaling at the book level.

**STATISTICS.** Punishing unrelated theses for one thesis's streak treats noise as signal.

**INCENTIVES / GAMING.** Remaining gap (David): for QUANTANAMO, a new thesis's confidence starts at the steward's own stated number, so a new thesis stated at >= 80 passes the autonomous gate with zero evidence. See quantanamo-80-gate.

## Evidence
#97 live numbers: every unproven QUANTANAMO theme at $62.50; reverted by #98 (migration 34).

## Ruling
**STRIKE.** Strike the problem at its root (no per-thesis punishment exists to escape). No separate rule needed.

Amendment: None beyond loss-streak-halving and drawdown-scaling.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | Via drawdown-scaling. |

## Interactions
loss-streak-halving, drawdown-scaling, quantanamo-80-gate.
