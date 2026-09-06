-- Mirror grant_pm_select_for_desk_publish so desk:publish can see BANDIT Coins.
--
-- Live `meme_ledger_v1` GRANTed SELECT on meme_* to quantanamo_worker but did
-- not add policy quantanamo_worker_select. With RLS on, GRANT alone yields
-- empty result sets (no error) — phone COINS showed "BANDIT book not in ledger"
-- while Bandit had real ZDOG fills. pm_* already had this publisher policy.
--
-- Every new domain lane needs publisher SELECT RLS for quantanamo_worker,
-- not just GRANTs. Idempotent: drop policy if exists, then recreate.

grant select on public.meme_tokens, public.meme_orders, public.meme_positions, public.meme_fills, public.meme_pnl, public.meme_notes to quantanamo_worker;

do $$
declare t text;
begin
  foreach t in array array['meme_tokens','meme_orders','meme_positions','meme_fills','meme_pnl','meme_notes']
  loop
    execute format('drop policy if exists quantanamo_worker_select on public.%I', t);
    execute format(
      'create policy quantanamo_worker_select on public.%I for select to quantanamo_worker using (true)',
      t
    );
  end loop;
end $$;
