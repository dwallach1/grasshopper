# Portfolio exposure: open risk <= 10% of book (gap-prone lots at full notional)

`rule_id: portfolio-exposure` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
Per-entry caps don't bound total or correlated exposure across open lots, and an invalidation line doesn't bound a lot that can gap straight through it.

## Mechanism
`private.open_risk_lots()` (per lot, `public.v_exposure_lots`) summed by `private.steward_open_risk` (`public.v_exposure_usage`), in the book unit, `risk_basis` per book. QUANTANAMO equities stay `to_invalidation` on the line. Until the earnings report is out, a lot's open risk is the max of that line distance and the implied-move risk (GRASSHOPPER 2026-10-19). Line distance is qty x max(mark - invalidation_price, 0) (no invalidation: qty x mark; unmarked: 0, flagged). Implied-move risk is (ATM straddle price at the nearest expiry on or after the report date / underlying price) x position market value (qty x mark). The steward stores the report date, the straddle, the underlying and the expiry it used on `public.equity_implied_moves` (Robinhood earnings calendar and option quotes; a name without weeklies keeps that later expiry, no correction). Once the report has passed (an actual EPS, or 09:30 America/New_York on an am date, 20:00 on a pm date, or the next midnight when the source gives no am/pm), open risk is the line distance only. Missing straddle or option data uses the line distance and flags the lot `implied_move_missing`. No price is fabricated. ODDSBORNE binaries and BANDIT memes `full_notional`: every open binary at price x contracts (mark, else average cost) and every meme lot at its full cost basis (qty x average cost, else qty x mark). Budget 10% of book. Guidance sizes a new entry to fit: min(requested, max_stake, cash, headroom / risk fraction), where the fraction is 1 for full_notional books and (entry - invalidation) / entry for equities (1 without p_entry_price); no headroom -> `exposure_cap`. Guidance, v_exposure_usage and the v_ledger_watchdog `exposure` summary carry `risk_basis`. A new equity entry held through a scheduled print passes `p_expected_move`, that same straddle/underlying fraction (0.094 means a 9.4% move). Risk per share is the larger of the line distance and that move, and the notional shrinks so the expected-move loss equals the starter risk the line would have taken. It does not block the trade. The size is zero only when the result is under $1 (`below_minimum`, with a plain-language note). Guidance returns `risk_distance` (`line` or `expected_move`). No expected move, or a move no wider than the line, sizes exactly as before.

Code paths:
- `supabase/schemas/41_court_decisions.sql`
- `supabase/schemas/44_exposure_gap_full_notional.sql`
- `supabase/schemas/80_equity_implied_move_risk.sql`
- `supabase/schemas/82_equity_earnings_score.sql`
- `supabase/schemas/86_equity_expected_move_sizing.sql`
- `stewards/quantanamo/earnings_implied.py`
- `stewards/quantanamo/steward_rpc.py`

## After the print

Once the report's release clock has passed, the steward records the realized move beside the priced one (`reference_close`, the first regular-session open and close, the open gap, the close-to-close move, and whether that open went through the exit). A missing bar is `score_missing_reason`. Nothing in that score changes `private.equity_lot_open_risk`: until the report is out, risk is still the max of the line and the priced move, and a later expiry stays in that max. `expiry_loose` is true when the listed expiry is more than 7 days after the report. That flag means the priced move is a loose upper bound (the nearest listed expiry was already that far out). The scorecard withholds a verdict until 5 closes are scored.

## The court

**GROWTH.** Any cap here limits concentration into the best ideas. Full notional on the gap-prone books makes BANDIT effectively one clip at a time (budget 0.180 SOL vs a 0.119 starter: one clip leaves 0.061 SOL of headroom) and lets ODDSBORNE hold about 13 of today's $2.12 tickets ($27.69 budget).

**RUIN.** Gap risk is the real tail. A Polymarket binary goes from its mark to 0 on one score, and a meme can rug in one block, so the -40% meme line and the outcome-price line on a binary bound nothing; counting them to invalidation understated BANDIT's risk per clip by 60% (0.4 x notional vs the whole notional). Equities keep to-invalidation, since a stop on a listed name usually fills near its line (gaps excepted). QUANTANAMO on 2026-09-26 (9/25 after-hours marks, lines raised at 3:08 PM PT): NBIS $80, CIFR $79, CODA $193 = $351 (6.4% of $5,501). Before the raise: NBIS $161, CIFR $186, CODA $308 = $654 (11.9%, over budget).

**STATISTICS.** Needs a correlation estimate by theme; with n this small, use theme membership as the proxy. For binaries and memes the loss distribution is bimodal (full loss or not), so the right risk unit is the notional, not a distance to a line.

**INCENTIVES / GAMING.** Without it, a steward can stack correlated starters across several theses. To-invalidation on a gap-prone lot rewards writing a tight line the venue can't honor; full notional removes that lever.

## Evidence
Open position_episodes, pm_positions and meme_positions on 2026-09-26 (v_exposure_lots); venue mechanics: a binary resolves to 0 or 1, and a meme pool can be pulled in one block. ROL starter 2026-10-19: 16 shares at $33.05, exit $31.06 (6.021% below). The straddle implied 9.4%. The line-sized starter risked $31.84 at the line and about $49.70 at the implied move. Sizing on the wider distance is 10.25 shares ($338.72), the same $31.84 if the print gaps 9.4%, which is 6.021/9.4 of the old share count. A starter with no expected move, or a move no wider than its line, keeps the old share count.

## Ruling
**AMEND.** Enact option (b) at R = 10% (migration 41; decided 2026-09-26 by the parent agent under David's delegation). Amended the same day (migration 44): ODDSBORNE binaries and BANDIT memes count at full notional, equities keep to-invalidation. After QUANTANAMO raised its lines it is at 6.4% (was 11.9%, blocked); ODDSBORNE and BANDIT have no open lots (0%).

Amendment: Open risk <= 10% of book per steward, gap-prone lots (binaries, memes) at full notional and equities to invalidation; guidance sizes down or blocks and reports `risk_basis`. A lot held through a scheduled print is sized on the wider of the line and the expected move, so that loss fits the same starter risk; under $1 returns below_minimum (2026-10-22, lesson 146).

| Growth cost | Ruin-risk reduction |
|---|---|
| Caps stacking; at a 10% invalidation distance equities still allow ~100% of book in positions. BANDIT holds about 1.5 starters at once (0.180 SOL budget), ODDSBORNE about 10% of book in open tickets. | Bounds the loss if every open lot hits its invalidation at once (equities) or goes to zero (binaries, memes) to 10% of book. |

## Interactions
cash-only-no-margin, required-invalidation, edge-max-stake, starter-stake.

## Sweep
The steward runs `python3 stewards/quantanamo/earnings_implied.py plan`, saves the Robinhood responses, then `write <payload.json> --execute`. `stewards/sync_box.sh` copies the script to `/workspace/quantanamo/earnings_implied.py`. `v_ledger_watchdog.equity_implied_move_gaps` counts open equity lots with a report still ahead and no current implied-move row.
