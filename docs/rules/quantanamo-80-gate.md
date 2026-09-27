# QUANTANAMO autonomous-entry gate: hardening thesis with results score >= 80

`rule_id: quantanamo-80-gate` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
David approves anything below 80; autonomy only for strong theses.

## Mechanism
`steward_sizing_guidance`: QUANTANAMO entry_allowed needs status = hardening and theses.results_confidence >= 80 (reason `quantanamo_unscored` when unscored, else `quantanamo_confidence_gate`). Backtests alone can never open it: a thesis is unscored until it has 3 live trades, and backtest credit is then at most min(5, live / 2) effective trades (migration 47, backtest-evidence-credit).

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/41_court_decisions.sql`
- `docs/scheduled-run-prompt.md`

## The court

**GROWTH.** Today 2 of 12 live theses pass (neocloud_compute 85, semis_photonics 85). Because confidence is a hit-rate posterior, asymmetric-payoff theses can't reach 80 from results (see outcome-rescore-confidence).

**RUIN.** Keeps autonomy away from theses with little conviction. The size risk is already bounded by max_stake.

**STATISTICS.** Before 41, at n = 0 the gate read the steward's self-stated number (80 was a claim, not a measurement). Now 80 means P(expected return per trade > 0) >= 0.8 on at least 3 effective trades (z >= 0.84, close to the 1-sigma LCB > 0 that proves an edge for sizing).

**INCENTIVES / GAMING.** Before 41 a steward could state 85 on a brand-new thesis and pass, and couldn't earn 80 with an asymmetric winner. Now stated numbers can't open the gate, the results columns are write-protected (only the re-score writes them), and an asymmetric winner earns its score from expectancy.

## Evidence
Live theses 2026-09-26.

## Ruling
**AMEND.** Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David's delegation): the 80 threshold stays, but it reads the results score only. On 2026-09-26 no thesis passes: neocloud_compute (1 trade) and semis_photonics (0) are unscored, earnings_gap_structure scores 56; every QUANTANAMO entry needs David until a thesis earns >= 80 or gets qualifying backtest credit.

Amendment: Gate on results_confidence >= 80; unscored (< 3 live trades) fails and asks David; stated confidence is display only.

| Growth cost | Ruin-risk reduction |
|---|---|
| Autonomy now waits for evidence (David approves meanwhile). | Closes the self-stated-85 path to autonomy. |

## Interactions
outcome-rescore-confidence, new-thesis-escape, backtest-evidence-credit.
