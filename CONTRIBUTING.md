# Contributing

## Trading rules need a court ruling

Any PR that adds or changes a trading rule needs a ruling in [`docs/rules/`](docs/rules/README.md), with all four opinions (growth, ruin, statistics, incentives), the evidence and a verdict. A rule without one can't merge. Trading rules are sizing, gates, entry and exit conditions, and blocks.

1. Edit `tools/court/rules_data.py` and run `python3 tools/court/build_rules.py`.
2. Quantify the change with `tools/court` (replay plus Monte Carlo) and put the numbers in the ruling.
3. In the rule migration, add `-- court-ruling: docs/rules/<rule_id>.md` and the registry upsert (`python3 tools/court/build_rules.py --sql B`).
4. `bun run test` must pass (`apps/dashboard/lib/rules-court.test.ts` checks the ruling files, the registry seed and the migration markers).
5. Don't ship a ruling marked `needs_david` until David decides.

## Other standing rules

Never invent marks or P/L. Keep the desk calm (parchment). Apply prod migrations and verify them live.
