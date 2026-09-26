-- PR 3 data: ODDSBORNE pm_fills backfill cleanup, pm_positions venue-truth fixes,
-- re-price all ODDSBORNE outcomes from fills / settlement, re-score theses.
do $$
declare
  v_ph public.pm_fills%rowtype;
  v_dup_q numeric;
  v_dup_fee numeric;
  v_real_buy numeric;
begin
  select * into v_ph from public.pm_fills
  where id = '51b3e5f5-ad9a-4050-8461-8a7fb91d8a12'
    and venue_fill_id = 'CAZ0AXSWRQ46-partial-128.41';
  if found then
    -- The placeholder duplicates the first 7 real CAZ0AXSWRQ46 executions.
    select sum(quantity), sum(fee) into v_dup_q, v_dup_fee
    from (
      select quantity, fee from public.pm_fills
      where venue_order_id = 'CAZ0AXSWRQ46' and id <> v_ph.id and side = 'buy'
        and executed_at < v_ph.executed_at
    ) s;
    select sum(quantity) into v_real_buy
    from public.pm_fills
    where position_id = v_ph.position_id and side = 'buy' and id <> v_ph.id;
    if v_dup_q is distinct from v_ph.quantity or v_dup_fee is distinct from v_ph.fee or v_real_buy <> 166 then
      raise exception 'placeholder check failed: dup_q=% dup_fee=% real_buy=%', v_dup_q, v_dup_fee, v_real_buy;
    end if;
    -- Keep an exact copy on the outcome it distorted.
    update public.trade_outcomes
    set meta = meta || jsonb_build_object('removed_placeholder_fill', to_jsonb(v_ph) || jsonb_build_object(
      'removed_at', now(),
      'reason', 'aggregated partial duplicated the first 7 venue fills (128.41 qty, 1.93 fee); real buys 166')),
        updated_at = now()
    where source_table = 'pm_positions' and source_id = v_ph.position_id::text;
    delete from public.pm_fills where id = v_ph.id;
  end if;
end;
$$;

-- pm_positions venue-truth fixes. Only quantity / average_cost / meta change, so the
-- outcome close trigger (status, closed_at) does not fire; the ODDSBORNE heartbeat
-- trigger is paused so an admin fix does not read as agent activity.
alter table public.pm_positions disable trigger pm_positions_touch_oddsborne;

update public.pm_positions
set quantity = 200, average_cost = 0.12,
    meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('venue_truth_fix', jsonb_build_object(
      'at', now(), 'source', 'pm_fills (7 fills, order CFHGT06W6TMM)',
      'bought', 200, 'sold', 0, 'avg_px', 0.12,
      'previous', jsonb_build_object('quantity', quantity, 'average_cost', average_cost)))
where id = 'b4f4a00b-d820-474c-a41a-31de1cfdc819' and quantity = 0;

update public.pm_positions
set quantity = 50.1, average_cost = 0.35,
    meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('venue_truth_fix', jsonb_build_object(
      'at', now(), 'source', 'pm_fills (42 buys CET22D0AJTN2/CET3J5PEYTMQ, 1 sell CF1VYSRR6TMP)',
      'bought', 100.1, 'sold', 50, 'held_to_settlement', 50.1, 'avg_px', 0.35,
      'previous', jsonb_build_object('quantity', quantity, 'average_cost', average_cost)))
where id = 'e4b54577-782d-41a0-bb55-5b1b31a7ae41' and quantity = 50;

alter table public.pm_positions enable trigger pm_positions_touch_oddsborne;

select private.reprice_trade_outcomes('oddsborne');
select private.rescore_all_thesis_confidence();
