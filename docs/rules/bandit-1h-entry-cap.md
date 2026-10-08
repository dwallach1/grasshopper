# BANDIT entry gate: skip a coin up more than +30% in the hour before entry (provisional trial)

`rule_id: bandit-1h-entry-cap` · status: **in_force** · verdict: **amend** · ruling 2026-10-07 · next review after 10 blocked passes (blocked_by 1h_cap_30) or 10 new clips, whichever comes first

## Purpose (failure prevented)
Stops BANDIT buying a meme coin right after its vertical candle. All three closed clips entered above +30% 1h (goon, Agency, SHARTCOIN) lost money and sat 14-28% under entry at the 4h mark.

## Mechanism
`meme_4h_momentum_clip` entry gate: the 1h price-change ceiling drops from +200% to +30%, so a coin up more than +30% over the hour before entry is skipped. Every other gate is unchanged (liquidity >= $100k, age < 14d, 1h >= +5%, 6h >= +10%, 1h volume >= $25k, buy share >= 52%, 5m > -8%, 24h > -40%, quote impact < 1%), and so is sizing (`steward_sizing_guidance`, results-driven). The gate is applied in BANDIT's runtime scan on the box (`/workspace/bandit/_scan_https_once.py`, fail text `1h_cap_30 trial`); it isn't in versioned repo code or SQL. Every coin the cap blocks is logged as a pass with `steward_log_decision` (decision `skip`, `blocked_by = '1h_cap_30'`), so `pass_marks.py` scores it at its 4h mark like any other pass. Sunset check: `decision_candidates` where steward = 'bandit' and `meta->>'blocked_by' = '1h_cap_30'` (first pass per mint; 4h return = counterfactual_pnl / book_price) against `trade_outcomes` for thesis `meme_4h_momentum_clip` opened after this rule's `desk_rules.created_at` (realized_pnl / cost; SHARTCOIN, opened 2026-10-07 16:29 PT, is the last clip before the cap).

Code paths:
- `supabase/schemas/64_bandit_1h_entry_cap.sql`
- `stewards/bandit/README.md`

## The court

**GROWTH.** The cap blocks about 20% of entries (3 of 15 closed clips), and historically all three were losers: -0.1156 SOL combined, -21.0% mean realized and -20.8% mean 4h-mark return. No winner had a 1h move above +11.3% at entry (familiars), so the upside cost in the record is nil. Applied to history, the 15 clips go from +0.0700 SOL to +0.1856 SOL. The cost to watch is pace: learning speed is trade count, and of the four clips that pass every current gate with data (SHARTCOIN, Agency, GTA6, X7), two would now be blocked, so under today's gates the cap could remove more than 20% of entries. The sunset check measures that cost directly.

**RUIN.** A filter can only remove entries. It can't raise the size of any clip or the loss on one. Sizing, the 10% exposure budget (memes at full notional, about one clip at a time) and drawdown scaling are untouched, so P(DD50) and P(book < 20%) can't rise; at worst they're unchanged. It doesn't address the tail that actually hurt: the two -100% rugs (ACAT, 1h +3.8%; GTA6, 1h ~+10%) entered well under the cap.

**STATISTICS.** Three clips decide it. If 3 of the 15 clips were dropped at random, the chance all three are losers (9 losers of 15) is C(9,3)/C(15,3) = 84/455 = 0.185, so this is weak evidence for a rule with a clear mechanism, not a proven edge. Two of the three (Agency, SHARTCOIN) are the two latest losses, the ones the rule was written after. The 1h values for goon and Agency were rebuilt from GeckoTerminal 5m candles, not read from a scan; on the five clips that have both, the rebuild was within about 0.4-6 points of the scan value. Any cap between about +12% and +52% sorts history the same way; +30% is a round number inside that gap, not tuned to its edge. Regimes changed during the sample (old half-at-+50% exits on GROK and JEANPHIL; QUEEF and TIGRINO sold hours after their 4h stop), and 11 of 15 clips would fail at least one of today's gates anyway, so history says little about the current gate set. Hence a trial with a preset sunset, not a permanent rule.

**INCENTIVES / GAMING.** Preregistered: the rule was written down in BANDIT's study before the next coin and checked against all 15 closed clips, not only the last loss. Blocked coins must be logged as passes (`steward_log_decision`, `blocked_by = '1h_cap_30'`), at least every coin that cleared every other gate, so BANDIT's 4h pass marks score them and the cap is judged on what it gave up as well as what it avoided. A steward that skipped the logging could make the cap look free; unlogged blocks make the trial unreadable. Waiting for the 1h move to cool and re-scanning later is allowed; that's a new decision, scored on its own. Interacts with nothing in sizing; it only changes which coins reach `steward_sizing_guidance`.

## Evidence
BANDIT's entry-filter study (`/workspace/bandit/research/entry_filter_study.md` and `.csv` on the box, built by `build_study.py` / `evaluate_rules.py` from ledger reads; 2026-10-07). 15 closed clips. Entered above +30% 1h: goon +52.4% (-0.0564 SOL, -12.5%), Agency +63.0% (-0.0313 SOL, -26.3%), SHARTCOIN +59.5% (-0.0278 SOL, -24.2%); all three lost, -0.1156 SOL combined, about -21% at the 4h mark. At or under +30%: 11 clips, +0.4616 SOL, 6 winners (JEANPHIL, QUEEF, GROK, familiars, TIGRINO, FEELSGOOD), none with a 1h move above +11.3%. X7 (-0.2760 SOL) has no usable entry-time 1h value and counts as kept. All 15: +0.0700 SOL; with the cap: +0.1856 SOL. Rejected runner-up, 'at most half of the 6h move came in the last hour' (ln(1+1h)/ln(1+6h) <= 0.5): it would drop familiars (+0.264 SOL, banked at +50%) and keep goon (a loser), costing +0.205 SOL net, and it is undefined for 4 of 15 clips where the 6h change was <= 0. Also rejected: 5m > 0 (drops TIGRINO, JEANPHIL and QUEEF), buy share >= 55% (data on 5 clips, signal looks inverted), max age 7d (n = 1), liquidity >= $150k (no separation).

## Ruling
**AMEND.** Uphold as a provisional trial, amended from the +200% ceiling to +30%. Sizing stays results-driven. Not a risk-budget tradeoff, so not for David. Sunset: review after 10 blocked passes (blocked_by '1h_cap_30') or 10 new clips, whichever comes first. Compare the blocked coins' mean 4h return against the taken clips' mean realized return over the same period. If the blocked coins beat the taken clips, strike the cap.

Amendment: BANDIT's 1h price-change ceiling: +200% -> +30% (skip a coin whose 1h change at scan time is above +30%). Every blocked coin is logged as a pass with blocked_by '1h_cap_30'. All other gates and sizing unchanged.

| Growth cost | Ruin-risk reduction |
|---|---|
| About 20% of historical entries blocked, all losers (-0.1156 SOL); zero historical winners lost. Clip pace may fall more than 20% under today's gates (2 of 4 clips that pass every current gate would be blocked). | None claimed: a filter can't raise loss, and it doesn't catch the -100% rugs (ACAT, GTA6). Removes the -21% average post-vertical-candle entry. |

## Interactions
portfolio-exposure (one clip at a time, so a blocked coin frees the slot for the next candidate), starter-stake, drawdown-scaling, shadow-exits (exit rules are separate; goon touched +25.9% before bleeding).
