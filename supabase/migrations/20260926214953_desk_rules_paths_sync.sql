-- Rules-court registry sync: the court-rulings migration landed as 37 (plus the 38 null-thesis fix)
-- after the seed (36) was written with "36". Brings owner_paths / ruling_summary in line with
-- tools/court/rules_data.py; check with `python3 tools/court/build_rules.py --checksum B`.
update public.desk_rules
   set owner_paths = array_replace(owner_paths, 'supabase/schemas/36_court_rulings.sql', 'supabase/schemas/37_court_rulings.sql'),
       ruling_summary = replace(ruling_summary, '(migration 36)', '(migration 37)'),
       updated_at = now()
 where 'supabase/schemas/36_court_rulings.sql' = any(owner_paths) or ruling_summary like '%(migration 36)%';

update public.desk_rules
   set owner_paths = owner_paths || 'supabase/schemas/38_edge_max_stake_null_thesis.sql'::text,
       updated_at = now()
 where rule_id in ('edge-max-stake', 'backtest-evidence-credit')
   and not ('supabase/schemas/38_edge_max_stake_null_thesis.sql' = any(owner_paths));
