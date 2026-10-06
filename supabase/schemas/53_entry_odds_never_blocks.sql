-- Follow-up to 52 (scorecard binary calibration): the entry-odds trigger on trade_outcomes swallows its own
-- errors, like the other outcome capture triggers, so deriving price_at_entry / probability_at_entry can never
-- block an outcome write. On error the row keeps whatever values it carried and a warning is raised.

create or replace function private.trade_outcome_entry_odds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if new.venue = 'prediction' and new.source_table = 'pm_positions'
     and new.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    begin
      select * into v from private.binary_entry_odds(new.source_id::uuid);
      new.price_at_entry := coalesce(v.price, new.price_at_entry);
      new.probability_at_entry := coalesce(v.probability, new.probability_at_entry);
    exception when others then
      raise warning 'trade_outcome_entry_odds(%): %', new.source_id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function private.trade_outcome_entry_odds() from public, anon, authenticated;
