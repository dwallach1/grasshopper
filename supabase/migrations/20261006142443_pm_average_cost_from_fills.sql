-- Prediction-market lot cost follows its fills (2026-10-06, ODDSBORNE TEN / MIA).
--
-- The bug: pm_positions.average_cost was written once, by whatever opened the lot (the pm_enter /
-- oddsborne_entry_upsert_position fill_avg_px, or a watch script writing the limit price), and nothing
-- ever rewrote it. Buy fills recorded later, including after the lot closed (the 10/6 pm_fills_sync of
-- the 10/1 maker fills on aec-nfl-ten-bal and aec-nfl-mia-min), fired trade_outcome_capture /
-- trade_outcome_fill_changed, so realized_pnl, cost and price_at_entry were recomputed from fills, but no
-- trigger on pm_fills touched pm_positions. The lots kept the limit prices 0.146 / 0.158 while their
-- fills say 0.1475 / 0.16. Four older lots whose fills were backfilled on 9/26 carried the same drift.
--
-- The rule: when a lot has linked BUY fills, its average_cost is their volume-weighted price,
-- sum(quantity x price) / sum(quantity), rounded to 6 places (the same VWAP and filter
-- private.binary_entry_odds uses for trade_outcomes.price_at_entry). With no buy fills the existing value
-- stands. Fees are not folded in (trade_outcomes carries them). Sells never change it.
--
--   private.pm_fills_sync_average_cost()   AFTER INSERT / DELETE / UPDATE OF position_id, side, quantity,
--                                          price on pm_fills: re-derive the lot(s) the fill belongs (or
--                                          belonged) to, open or closed. Writes only when the value moves.
--   private.pm_positions_average_cost()    BEFORE UPDATE OF average_cost on pm_positions: a writer that sets
--                                          average_cost on a lot with buy fills gets the fill VWAP instead
--                                          (oddsborne_entry_upsert_position re-blends after
--                                          oddsborne_entry_record_fills already linked the new fills).
--
-- Both are SECURITY INVOKER with search_path '' and reference only public tables, so they run as the
-- writer: oddsborne_worker (SELECT on pm_fills, SELECT/UPDATE on pm_positions, RLS using true),
-- service_role or postgres. No grant, policy or existing trigger changes. Only average_cost is set, so the
-- trade_outcome_* (status, closed_at, thesis_id) and require_lot_invalidation (status,
-- invalidation_price) triggers do not fire and realized_pnl cannot move; updated_at is left alone so the
-- dashboard's updated_at ordering does not reshuffle old lots.
--
-- position_episodes (equities) is unchanged: its average_cost comes from the broker position and every
-- episode with intent-linked broker buy fills already matches their VWAP. Equity episodes can hold shares
-- bought outside a trade_intent, so the fill rule is not imposed there. v_exposure_lots reads
-- pm_positions.average_cost live and needs no change.
--
-- Backfill: every lot whose linked buy-fill VWAP differs from average_cost is set to the VWAP.

create or replace function private.pm_fills_sync_average_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lot uuid;
  v_vwap numeric;
begin
  for v_lot in
    select distinct x.id
    from unnest(array[
      case when tg_op in ('INSERT', 'UPDATE') then new.position_id end,
      case when tg_op in ('UPDATE', 'DELETE') then old.position_id end
    ]) as x(id)
    where x.id is not null
  loop
    select trim_scale(round(sum(f.quantity * f.price) / nullif(sum(f.quantity), 0), 6)) into v_vwap
    from public.pm_fills f
    where f.position_id = v_lot and f.side = 'buy' and f.quantity > 0 and f.price > 0 and f.price < 1;
    if v_vwap is not null then
      update public.pm_positions p
         set average_cost = v_vwap
       where p.id = v_lot and p.average_cost is distinct from v_vwap;
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.pm_fills_sync_average_cost() is
  'pm_fills trigger: re-derive pm_positions.average_cost as the linked buy-fill VWAP (6 dp) for the lot a fill belongs or belonged to, open or closed. No buy fills = value left as is.';

create or replace function private.pm_positions_average_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_vwap numeric;
begin
  select trim_scale(round(sum(f.quantity * f.price) / nullif(sum(f.quantity), 0), 6)) into v_vwap
  from public.pm_fills f
  where f.position_id = new.id and f.side = 'buy' and f.quantity > 0 and f.price > 0 and f.price < 1;
  if v_vwap is not null then
    new.average_cost := v_vwap;
  end if;
  return new;
end;
$$;

comment on function private.pm_positions_average_cost() is
  'pm_positions trigger: an UPDATE that sets average_cost on a lot with linked buy fills stores the fill VWAP (6 dp) instead.';

revoke all on function private.pm_fills_sync_average_cost() from public, anon, authenticated;
revoke all on function private.pm_positions_average_cost() from public, anon, authenticated;

drop trigger if exists pm_fills_average_cost on public.pm_fills;
create trigger pm_fills_average_cost
  after insert or delete or update of position_id, side, quantity, price on public.pm_fills
  for each row execute function private.pm_fills_sync_average_cost();

drop trigger if exists pm_positions_average_cost on public.pm_positions;
create trigger pm_positions_average_cost
  before update of average_cost on public.pm_positions
  for each row execute function private.pm_positions_average_cost();

comment on column public.pm_positions.average_cost is
  'Average price paid per contract (0-1). With linked buy fills: their VWAP, kept current by trigger (private.pm_fills_sync_average_cost). Without: the entry writer''s value.';

-- Backfill (the BEFORE trigger above computes the same value).
update public.pm_positions p
   set average_cost = v.vwap
  from (
    select f.position_id, trim_scale(round(sum(f.quantity * f.price) / nullif(sum(f.quantity), 0), 6)) as vwap
    from public.pm_fills f
    where f.position_id is not null and f.side = 'buy' and f.quantity > 0 and f.price > 0 and f.price < 1
    group by f.position_id
  ) v
 where v.position_id = p.id and v.vwap is not null and p.average_cost is distinct from v.vwap;
