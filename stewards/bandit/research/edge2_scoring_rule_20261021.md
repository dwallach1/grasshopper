# edge2 (meme_pullback_reclaim): scoring rule for the 20-pass decision

Recorded: 2026-10-21 08:57 EDT (GRASSHOPPER-approved). This was recorded when 6 edge2 passes had been scored, before a 7th was.

The 20-pass promotion decision in research/edge2_promotion_bar.md is scored on the **path exit**. It is not scored
on the ledger's plain 4h mark (supabase/schemas/58_decision_marks.sql). The exit is computed exactly as in
`edge2_path_score.py`:

- Entry is the open of the first GeckoTerminal 5m USD bar that starts at or after decided_at, on the coin's
  top-reserve pool.
- Sell all at +50% (high >= 1.5x entry).
- Kill at -40% (low <= 0.6x entry). If both happen in the same bar, the kill counts.
- Otherwise exit at the close of the 48th bar (4h).
- Net = gross - 2.0 points (house cost: 1% round trip + 1% assumed impact).
- A pass with a missing entry bar or an incomplete window is unscored and never filled in.

This applies to **every** edge2 pass, including the 6 already scored. The bar is unchanged: n >= 20 and mean net
with the top 2 winners removed > 0.

The ledger `theses` row was **not** updated: the bandit_worker role has no UPDATE on public.theses and no RPC that
writes it. The theses table has no rules/notes/meta column (only summary, falsifier and results_basis), so this
file is the record of the rule.
