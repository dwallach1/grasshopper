# The rules court

Every trading rule (sizing, gates, entry and exit conditions, blocks) must have a ruling here before it can merge. The goal is to grow the books meaningfully (2x, 10x) while avoiding ruin. A rule has to earn its place on both counts.

- One file per rule: `docs/rules/<rule_id>.md`.
- The registry is `public.desk_rules`. It has one row per rule with its status (`in_force`, `repealed` or `proposed`), verdict, ruling summary, growth cost, ruin-risk reduction, gaming analysis, interactions, `needs_david`, `ruling_date` and `next_review_date`.
- The source for both is `tools/court/rules_data.py`. `python3 tools/court/build_rules.py` rewrites the files, and `--sql B` prints the registry upsert for a migration.

## Ruling standard

Four justices argue every rule. Each opinion has to be specific and, where possible, quantified.

1. **GROWTH.** Does the rule let a proven edge compound to 2x or 10x? What is the opportunity cost, in median terminal multiple and P(2x) over a year at the steward's real trade pace?
2. **RUIN.** What catastrophic loss does it actually prevent (probability x size)? Measure it as P(drawdown ≥ 50%) and P(book < 20% of start).
3. **STATISTICS.** Is it calibrated to real sample sizes and noise? Does it treat noise as signal? Does it slow learning? Learning speed is trade count, not size.
4. **INCENTIVES / GAMING.** How could a steward game it, or be pushed into worse behavior? How does it interact with the other rules?

**Quantify** with `tools/court`:
- `replay.py` replays the real ledger sequence under the rule and its alternatives.
- `sim.py` / `grid*.py` run a Monte Carlo of book growth vs drawdown and ruin, bootstrapped from each steward's real `trade_outcomes` returns and re-centred to a range of true edges.

Assumptions are in [SIMULATION.md](SIMULATION.md).

**Verdict:** uphold, amend (with the exact amendment) or strike. The majority wins, but **GROWTH can't be ignored**: a rule that caps growth needs a quantified ruin case that outweighs it. A rule that's a genuine risk-budget tradeoff (a bigger starter, the QUANTANAMO 80 gate, a portfolio budget) is set `needs_david = true` and isn't shipped until David decides.

## Process for a PR that adds or changes a trading rule

1. Add or edit the rule in `tools/court/rules_data.py`, with all four opinions, the evidence and the verdict. Then run `python3 tools/court/build_rules.py`.
2. Put the registry change in the same migration as the rule change: the full upsert (`build_rules.py --sql B`) or, when only statuses move, `build_rules.py --status-updates`.
   Check the live registry against the source afterwards: `python3 tools/court/build_rules.py --checksum B` must equal
   `select md5(string_agg(rule_id||'|'||status||'|'||verdict||'|'||ruling_summary||'|'||mechanism||'|'||array_to_string(owner_paths, ',')||E'\n', '' order by rule_id collate "C")) from public.desk_rules;`
3. Any migration numbered ≥ 35 that defines one of the rule functions (`tools/court/rule_functions.txt`) must carry a `-- court-ruling: docs/rules/<rule_id>.md` line naming an existing ruling. `bun run test` fails otherwise (`apps/dashboard/lib/rules-court.test.ts`).
4. Fill in the court section of the PR template.

Registry migrations so far: 35 (table), 36 (seed as argued), 37 (rulings enacted: statuses), 38 (null-thesis fix), 39 (path sync).

Enforcement today is the test suite plus the PR checklist. For a hard merge block, move `docs/rules/court-ci.yml` to `.github/workflows/` (this needs a token with `workflow` scope) and make it a required status check.

## Current rulebook (2026-09-26)

| Rule | Verdict | Status | Key number |
|---|---|---|---|
| [edge-max-stake](edge-max-stake.md) | amend | in force | half-Kelly on 1σ LCB kept; 2σ would cut BANDIT median growth at Sharpe 0.2 from 28x to 10x |
| [starter-stake](starter-stake.md) | amend (share of book); level → David | in force | fixed-$ starter: ODDSBORNE ruin 10.1% vs 0.1% book-scaled (zero edge) |
| [loss-streak-halving](loss-streak-halving.md) | strike | repealed | P(loss \| loss) 0.53 vs P(loss) 0.51; drawdown scaling beats it on growth and drawdown |
| [drawdown-scaling](drawdown-scaling.md) | enact | in force | BANDIT P(DD50) 35.9% → 9.3% at zero edge |
| [new-thesis-escape](new-thesis-escape.md) | resolved structurally | repealed | #97's fix cut QUANTANAMO themes $250 → $62.50 with no ruin case |
| [confidence-multiplier](confidence-multiplier.md) | strike from sizing | repealed | gameable (request 2x → 1x); hit-rate noise ±22 pts at n = 5 |
| [outcome-rescore-confidence](outcome-rescore-confidence.md) | amend → David | in force | demotes 41% of true Sharpe-0.1 theses after 5 trades |
| [quantanamo-80-gate](quantanamo-80-gate.md) | uphold → David | in force | 2 of 12 theses pass; at n = 0 it reads self-stated confidence |
| [required-invalidation](required-invalidation.md) | uphold | in force | zero growth cost |
| [regular-session-invalidation](regular-session-invalidation.md) | uphold | in force | — |
| [stale-book-6h](stale-book-6h.md) | uphold | in force | — |
| [thesis-status-blocks](thesis-status-blocks.md) | uphold | in force | — |
| [cash-only-no-margin](cash-only-no-margin.md) | uphold | in force | removes negative-equity paths |
| [listed-equity-registry](listed-equity-registry.md) | uphold | in force | — |
| [entry-cap-snapshot](entry-cap-snapshot.md) | uphold | in force | — |
| [backtest-evidence-credit](backtest-evidence-credit.md) | enact | in force | proven in 7 vs 13 trades at Sharpe 0.2; overfit case P(DD50) +0.4 pt |
| [portfolio-exposure](portfolio-exposure.md) | proposed → David | proposed | QUANTANAMO holds 82% of its book in 3 lots (36% in one theme) |
| [shadow-exits](shadow-exits.md) | uphold | in force | — |
