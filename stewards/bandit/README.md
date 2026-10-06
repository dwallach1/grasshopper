# BANDIT contract

BANDIT trades Solana meme coins in SOL. The entry contract shared by all stewards is in [`../README.md`](../README.md); this file covers what's specific to BANDIT.

## Entry: `live_trade_clip.py`

- Guidance first: `steward_sizing_guidance('bandit', thesis, mint, requested_sol, invalidation_sol_per_token, pretrade_price_sol_per_token)`. Trade exactly `sized_notional`; stop if `entry_allowed = false` (including `exposure_cap`: open memes count at full cost basis against a 10%-of-book budget, so BANDIT runs about one clip at a time).
- The thesis is `meme_4h_momentum_clip`. Caps are per thesis; see `docs/sizing.md` and `docs/rules/`.
- A mint you pass on is still a decision. Log it with `log_decision("bandit", decision="skip", instrument=mint, side="long", price=price_sol, ...)`. It is scored four hours later, one token, in SOL. That does not change the clip.
- The lot carries `invalidation_price` (SOL per token). The order carries `thesis_id`, `max_stake_at_entry` and `max_stake_reason_at_entry`.
- Ledger calls go over HTTPS through `steward_rpc.py` (the box can't reach the pooler): `steward_entry_guidance`, `bandit_entry_open_order`, `bandit_entry_reject_order`, and `bandit_entry_record_fill`, which writes the filled order, the lot, `meme_fills`, `meme_pnl` and the thesis update in one transaction. Check with `.venv/bin/python steward_rpc.py bandit`.

## Marks and exits: `mark_clip.py`, `exit_clip.py`

These replace the per-symbol `_<sym>_mark_once.py` / `_<sym>_exit_once.py` clones, which used `db_connect` and time out on the box. Commands are in [`../README.md`](../README.md#exits-marks-and-pl-both-stewards).

- The rails come from `clip_common.decide`, in the clones' order: past the 4h stop → `deadline_4h_stop`; ≤ −40% → `kill_-40pct`; mark ≤ invalidation → `invalidation`; ≥ +50% → `tp50_full_bank` (FULL exit, no half-scale). Warnings fire at −25% and +40%.
- `exit_clip.py` sells min(ledger quantity, on-chain balance) and records the close in one `bandit_exit_record_fill` call. Realized P&L = (exit price − average cost) × tokens sold, plus any earlier `meta.tp50_realized_sol`. Because both fills are linked to the lot, `trade_outcomes` gets `pnl_source = 'fills'` net of fees.
- After the close, run `close_lesson.py` and `paper_bank20.py`.

## After every close: `paper_bank20.py <position_id>`

Records the shadow exit for rule `bank_at_+20pct` in `meme_positions.meta.paper_bank20`:

- The paper exit is the first 5-minute venue mark (`meme_pnl.payload.pnl_pct_vs_entry`) at or above +20% vs entry. If no mark reaches +20%, the paper exit is the real exit.
- `real_exit_pct` is the last watch mark before the exit, not the fill, so both sides use the same mark basis. The fill-based return appears next to it as `real_fill_return_pct` in `public.v_shadow_exits`.
- It doesn't trade. It's safe to re-run, because it overwrites only its own key.
- It reads marks with `bandit_shadow_exit_marks` and writes with `bandit_write_shadow_exit` over HTTPS. It now needs only the standard library and takes several position ids at once.

Any new rule goes in its own `meta.paper_<name>` key with the same fields (`rule`, `paper_exit_pct`, `real_exit_pct`, `delta_pct_pts`, `triggered`, `trigger_minute`, `source`). It then shows up in the views without a schema change.

## Promotion

Check `public.v_shadow_exit_scorecard` (steward `bandit`). A rule can replace the real exit once it has `n ≥ 10` closed clips and `promotable = true`, meaning the LCB of paper − real is above 0 percentage points.

On 2026-09-26 at ~13:30 PT, `bank_at_+20pct` had n = 4 (goon, familiars, COLLECT, YAP) and had fired on 2. The paper exit beat the real one once (goon, +38.6 pts) and lost once (familiars, −26.8 pts). Mean delta was +2.9 pts and LCB −10.5 pts. Not promotable; 6 more clips are needed.
