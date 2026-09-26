## What changed

## Court (required if this adds or changes a trading rule; see docs/rules/README.md)
- [ ] No trading rule changed
- [ ] Ruling file(s): `docs/rules/<rule_id>.md` (generated from `tools/court/rules_data.py`)
- [ ] Four opinions quantified (growth: P(2x), median multiple; ruin: P(DD≥50%), P(ruin); statistics; gaming)
- [ ] Verdict: uphold / amend / strike; `needs_david` respected
- [ ] Migration carries `-- court-ruling:` and the `desk_rules` upsert

## Verification
- [ ] Migration applied to prod and verified live
