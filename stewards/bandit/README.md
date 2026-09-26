# BANDIT contract

BANDIT trades Solana meme coins in SOL. The entry contract shared by all stewards is in [`../README.md`](../README.md); this file covers what's specific to BANDIT.

## Entry: `live_trade_clip.py`

- Guidance first: `steward_sizing_guidance('bandit', thesis, mint, requested_sol, invalidation_sol_per_token)`. Trade exactly `sized_notional`; stop if `entry_allowed = false`.
- The thesis is `meme_4h_momentum_clip`. A new BANDIT thesis starts at no more than BANDIT's steward-wide cap (0.025 SOL on 2026-09-26, after 3 straight losses), not the 0.10 SOL starter. See `docs/sizing.md`.
- The lot carries `invalidation_price` (SOL per token). The order carries `thesis_id`, `max_stake_at_entry` and `max_stake_reason_at_entry`.

## After every close: `paper_bank20.py <position_id>`

Records the shadow exit for rule `bank_at_+20pct` in `meme_positions.meta.paper_bank20`:

- The paper exit is the first 5-minute venue mark (`meme_pnl.payload.pnl_pct_vs_entry`) at or above +20% vs entry. If no mark reaches +20%, the paper exit is the real exit.
- `real_exit_pct` is the last watch mark before the exit, not the fill, so both sides use the same mark basis. The fill-based return appears next to it as `real_fill_return_pct` in `public.v_shadow_exits`.
- It doesn't trade. It's safe to re-run, because it overwrites only its own key.

Any new rule goes in its own `meta.paper_<name>` key with the same fields (`rule`, `paper_exit_pct`, `real_exit_pct`, `delta_pct_pts`, `triggered`, `trigger_minute`, `source`). It then shows up in the views without a schema change.

## Promotion

Check `public.v_shadow_exit_scorecard` (steward `bandit`). A rule can replace the real exit once it has `n ≥ 10` closed clips and `promotable = true`, meaning the LCB of paper − real is above 0 percentage points.

On 2026-09-26 at ~13:30 PT, `bank_at_+20pct` had n = 4 (goon, familiars, COLLECT, YAP) and had fired on 2. The paper exit beat the real one once (goon, +38.6 pts) and lost once (familiars, −26.8 pts). Mean delta was +2.9 pts and LCB −10.5 pts. Not promotable; 6 more clips are needed.
