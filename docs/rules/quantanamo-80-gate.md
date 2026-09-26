# QUANTANAMO autonomous-entry gate: hardening thesis at confidence >= 80

`rule_id: quantanamo-80-gate` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review David decision · **needs David**

## Purpose (failure prevented)
David approves anything below 80; autonomy only for strong theses.

## Mechanism
`steward_sizing_guidance`: QUANTANAMO entry_allowed needs status = hardening and confidence >= 80.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `docs/scheduled-run-prompt.md`

## The court

**GROWTH.** Today 2 of 12 live theses pass (neocloud_compute 85, semis_photonics 85). Because confidence is a hit-rate posterior, asymmetric-payoff theses can't reach 80 from results (see outcome-rescore-confidence).

**RUIN.** Keeps autonomy away from theses with little conviction. The size risk is already bounded by max_stake.

**STATISTICS.** At n = 0 the gate reads the steward's self-stated number: 80 is a claim, not a measurement.

**INCENTIVES / GAMING.** A steward can state 85 on a brand-new thesis and pass. A steward can't earn its way to 80 with an asymmetric winner.

## Evidence
Live theses 2026-09-26.

## Ruling
**UPHOLD.** Uphold (David's call). Flag two fixes for David: gate on evidence (re-score on expectancy), and at n = 0 require David's approval or backtest credit, not self-stated confidence.

Amendment: None shipped.

| Growth cost | Ruin-risk reduction |
|---|---|
| High for asymmetric theses. | Low-moderate (size already bounded). |

## Interactions
outcome-rescore-confidence, new-thesis-escape.
