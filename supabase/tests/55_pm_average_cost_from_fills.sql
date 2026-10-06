-- Read-only checks for migration 55 (prediction-market lot cost follows its fills). Run against a database
-- with 55 applied, e.g. `psql "$DATABASE_URL" -f supabase/tests/55_pm_average_cost_from_fills.sql` or paste
-- into the Supabase SQL editor. Raises on the first failure; writes nothing.
do $$
declare
  r record;
  v_n integer;
begin
  -- Both trigger functions are SECURITY INVOKER with an empty search_path, closed to public/anon/authenticated.
  for r in
    select p.proname, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('pm_fills_sync_average_cost', 'pm_positions_average_cost')
  loop
    assert not r.prosecdef, format('%s must be security invoker', r.proname);
    assert r.proconfig @> array['search_path=""'], format('%s must pin search_path to empty', r.proname);
    assert not r.anon_x and not r.auth_x, format('%s is executable by anon/authenticated', r.proname);
  end loop;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname in ('pm_fills_sync_average_cost', 'pm_positions_average_cost');
  assert v_n = 2, format('expected 2 trigger functions, found %s', v_n);

  -- Triggers are wired: pm_fills insert/delete/update of the cost columns, pm_positions before update of average_cost.
  assert exists (select 1 from pg_trigger t where t.tgrelid = 'public.pm_fills'::regclass
                   and t.tgname = 'pm_fills_average_cost' and t.tgenabled = 'O'
                   and pg_get_triggerdef(t.oid) like 'CREATE TRIGGER pm_fills_average_cost AFTER INSERT OR DELETE OR UPDATE OF position_id, side, quantity, price ON public.pm_fills FOR EACH ROW %'),
    'pm_fills_average_cost trigger missing or changed';
  assert exists (select 1 from pg_trigger t where t.tgrelid = 'public.pm_positions'::regclass
                   and t.tgname = 'pm_positions_average_cost' and t.tgenabled = 'O'
                   and pg_get_triggerdef(t.oid) like 'CREATE TRIGGER pm_positions_average_cost BEFORE UPDATE OF average_cost ON public.pm_positions FOR EACH ROW %'),
    'pm_positions_average_cost trigger missing or changed';

  -- The existing fill / close / invalidation triggers are untouched.
  for r in select * from (values
      ('public.pm_fills', 'trade_outcome_on_fill'), ('public.pm_fills', 'trade_outcome_on_fill_update'),
      ('public.pm_fills', 'order_thesis_from_fill'), ('public.pm_fills', 'pm_fills_touch_oddsborne'),
      ('public.pm_positions', 'trade_outcome_on_close_ins'), ('public.pm_positions', 'trade_outcome_on_close_upd'),
      ('public.pm_positions', 'require_lot_invalidation'), ('public.pm_positions', 'trade_outcome_thesis_sync'),
      ('public.pm_positions', 'pm_positions_touch_oddsborne')) v(tbl, tg)
  loop
    assert exists (select 1 from pg_trigger t where t.tgrelid = r.tbl::regclass and t.tgname = r.tg),
      format('trigger %s on %s is gone', r.tg, r.tbl);
  end loop;

  -- Every role that can write pm_fills can read them and set pm_positions.average_cost (invoker triggers run as it).
  for r in select rolname from pg_roles
           where rolname !~ '^pg_'  -- predefined pg_write_all_data etc. are not ledger writers
             and (has_table_privilege(rolname, 'public.pm_fills', 'INSERT') or has_table_privilege(rolname, 'public.pm_fills', 'UPDATE'))
  loop
    assert has_table_privilege(r.rolname, 'public.pm_fills', 'SELECT'), format('%s writes pm_fills but cannot read them', r.rolname);
    assert has_column_privilege(r.rolname, 'public.pm_positions', 'average_cost', 'UPDATE')
       and has_table_privilege(r.rolname, 'public.pm_positions', 'SELECT'),
      format('%s writes pm_fills but cannot update pm_positions.average_cost', r.rolname);
  end loop;

  -- Invariant: a lot with linked buy fills carries their VWAP (6 dp), open or closed.
  for r in
    select p.id, p.average_cost,
           trim_scale(round(sum(f.quantity * f.price) / nullif(sum(f.quantity), 0), 6)) as vwap
    from public.pm_positions p
    join public.pm_fills f on f.position_id = p.id and f.side = 'buy' and f.quantity > 0 and f.price > 0 and f.price < 1
    group by p.id, p.average_cost
  loop
    assert r.average_cost = r.vwap, format('pm lot %s average_cost %s vs buy-fill VWAP %s', r.id, r.average_cost, r.vwap);
  end loop;

  -- ... and it agrees with the scorecard's entry price for the same lot.
  for r in
    select p.id, p.average_cost, o.price_at_entry
    from public.pm_positions p
    join public.trade_outcomes o on o.source_table = 'pm_positions' and o.source_id = p.id::text
    where exists (select 1 from public.pm_fills f where f.position_id = p.id and f.side = 'buy')
  loop
    assert r.average_cost = r.price_at_entry, format('pm lot %s average_cost %s vs price_at_entry %s', r.id, r.average_cost, r.price_at_entry);
  end loop;

  -- The 10/6 lots (ODDSBORNE TEN / MIA YES), corrected from the limit prices 0.146 / 0.158; P&L as before.
  -- Plus the four 9/26-backfilled lots that carried the same drift.
  for r in select * from (values
      ('015e943b-382b-4816-8656-addcd56d2330'::uuid, 0.1475, -0.960),
      ('dc85d297-c523-4147-86f4-95209bb2c6eb'::uuid, 0.16, -1.145),
      ('0c925f7b-94d1-4ec6-b632-5b87d1e18b6c'::uuid, 0.51, 53.65),
      ('1590fe42-1604-4194-a7aa-333eb93c5d5c'::uuid, 0.259684, -49.05),
      ('306fe937-741d-4fee-8260-22ae187429fd'::uuid, 0.19, 52.76),
      ('e4b54577-782d-41a0-bb55-5b1b31a7ae41'::uuid, 0.35005, 63.66)) v(id, avg_cost, pnl)
  loop
    assert exists (
      select 1 from public.pm_positions p
      join public.trade_outcomes o on o.source_table = 'pm_positions' and o.source_id = p.id::text
      where p.id = r.id and p.average_cost = r.avg_cost and o.realized_pnl = r.pnl),
      format('pm lot %s: want average_cost %s and unchanged realized_pnl %s', r.id, r.avg_cost, r.pnl);
  end loop;

  -- position_episodes keep the broker's cost; where intent-linked broker fills cover a balanced round trip
  -- the stored cost already equals their buy VWAP.
  for r in
    select e.id, e.symbol, e.average_cost,
           round(sum(fl.quantity * fl.price) filter (where i.side = 'buy') / nullif(sum(fl.quantity) filter (where i.side = 'buy'), 0), 6) as vwap,
           coalesce(sum(fl.quantity) filter (where i.side = 'buy'), 0) as bq,
           coalesce(sum(fl.quantity) filter (where i.side = 'sell'), 0) as sq
    from public.position_episodes e
    join public.trade_intents i on i.position_episode_id = e.id
    join public.broker_fills fl on fl.trade_intent_id = i.id
    group by e.id, e.symbol, e.average_cost
  loop
    if r.bq > 0 and abs(r.bq - r.sq) <= greatest(r.bq, 1) * 0.000001 then
      assert r.average_cost = r.vwap, format('episode %s %s average_cost %s vs buy VWAP %s', r.id, r.symbol, r.average_cost, r.vwap);
    end if;
  end loop;
end;
$$;
