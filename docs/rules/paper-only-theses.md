# Paper-only theses: no real-money entries

`rule_id: paper-only-theses` · status: **in_force** · verdict: **uphold** · ruling 2026-10-17 · next review 2027-01-17

## Purpose (failure prevented)
Forward-paper rules (BANDIT edge2-edge6) need theses rows for attribution and scoring, but must not move money until they earn promotion on forward paper trades. Before this, a forming row was enough for steward_sizing_guidance to hand BANDIT the starter on an untested rule; paper-only lived only in scan code.

## Mechanism
`public.theses.paper_only` (default false). When true: `steward_sizing_guidance` returns entry_allowed false, entry_blocked_reason `paper_only`, sized_notional 0 and max_stake 0 (reason `paper_only`); `thesis_max_stakes()` / `v_thesis_max_stake` (the dashboard and phone view) show max_stake 0, reason `paper_only`; `steward_log_decision` refuses an enter (`refusal:paper_only`) while skips log and score exactly as before; a `meme_orders` buy on the thesis is refused (trigger `refuse_paper_only_meme_buy`) and sells always pass. Only postgres / service_role (the captain) may set or clear the flag: trigger `theses_paper_only_guard` refuses any other role, including quantanamo_worker, oddsborne_worker, bandit_worker and authenticated (ledger operators). Flagged on 2026-10-17: meme_pullback_reclaim, meme_range_breakout, meme_grad_pullback, meme_liq_accum, meme_flush_rebound. Promotion: the captain clears the flag once the rule's forward bar is met (n >= 20 forward paper trades, mean - SE > 0, mean > 0 with the top 2 winners removed).

Code paths:
- `supabase/schemas/76_theses_paper_only.sql`
- `supabase/schemas/77_theses_paper_only_lockdown.sql`

## The court

**GROWTH.** None. It blocks only rules with no forward evidence; a proven rule loses nothing because the promotion path is explicit: the captain clears the flag once n >= 20 forward paper trades show mean - SE > 0 and mean > 0 with the top 2 winners removed, and normal starter / edge-max-stake sizing applies from the next entry. Paper passes keep accruing at full pace, so learning speed (trade count) is unchanged.

**RUIN.** Reduces it. Without the flag, any forming thesis row gave BANDIT a starter entry (0.1104 SOL on 2026-10-17, about 6.4% of book) on an untested rule, guarded only by scan code. Now the database refuses the sizing, the enter log and the buy order, and the phone view shows no stake that can't be used.

**STATISTICS.** Forward paper trades are the only evidence these rules count (their preregs: backtests and OOS checks never count toward the 20). Keeping live money off them keeps the forward sample clean and the promotion test the one that was preregistered.

**INCENTIVES / GAMING.** A steward can't promote its own rule: workers and authenticated callers can neither clear nor set the flag, only the captain can. Tagging a paper rule's trade with an unknown id is refused (thesis-status-blocks); tagging it with the live clip's thesis would be misattribution visible in the ledger. Skips stay scoreable, so paper logging is not discouraged.

## Evidence
Structural. Checks on 2026-10-17: guidance for the five paper theses returns entry_allowed false, paper_only, max_stake 0; meme_4h_momentum_clip unchanged (entry_allowed true, 0.1104 SOL). Rollback test: a paper skip is stored awaiting_mark and scoreable; a paper enter and a paper buy are refused; sells and live-clip buys pass.

## Ruling
**UPHOLD.** Uphold (captain decision 2026-10-17). Not a risk-budget tradeoff, so not for David.

Amendment: None (new rule).

| Growth cost | Ruin-risk reduction |
|---|---|
| None: blocks only untested rules; promotion = the captain clears the flag once the forward bar is met. | Removes real-money entries on unproven paper rules (starter 0.1104 SOL each on 2026-10-17). |

## Interactions
thesis-status-blocks (same blocking path in guidance), starter-stake and edge-max-stake (paper theses show max_stake 0), entry-cap-snapshot (a paper buy is refused before the snapshot), portfolio-exposure. Sells are always allowed so open lots can close; skips stay scoreable.
