-- Read-only PostgREST role for the public phone Worker (grasshopper-desk).
-- SELECT only. No INSERT/UPDATE/DELETE. Not service_role. anon stays revoked.
-- The Worker holds a JWT with role=desk_public_reader plus the publishable/anon
-- key as Kong apikey. The public SPA never sees these credentials.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'desk_public_reader') then
    create role desk_public_reader nologin noinherit;
  end if;
end $$;

grant usage on schema public to desk_public_reader;
grant desk_public_reader to authenticator;

-- Core desk tables the public assembler reads. Optional domain lanes (pm_*,
-- meme_*, desk_*) are granted only when the relation exists so local ledgers
-- without those migrations still apply this file.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'theses','thesis_symbols','thesis_evidence','thesis_scores','thesis_relations','runs',
    'cloud_runs','cloud_tasks','codex_automations','catalysts','research_queue','research_lessons',
    'postmortems','research_cycles','strategy_tests','test_scenarios','backtest_artifacts','agent_runs',
    'account_snapshots','position_episodes','portfolio_exposure','trade_intents','trade_proposals',
    'broker_fills','insights','predictions','risk_controls','ontology_themes','symbols',
    'ontology_candidates','ontology_management_actions',
    'pm_markets','pm_positions','pm_orders','pm_fills','pm_pnl','pm_notes',
    'meme_tokens','meme_positions','meme_orders','meme_fills','meme_pnl','meme_notes',
    'desk_agents','desk_domains','desk_domain_stewards','desk_accounts'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      continue;
    end if;
    execute format('grant select on table public.%I to desk_public_reader', target_table);
    execute format('revoke insert, update, delete, truncate on table public.%I from desk_public_reader', target_table);
    execute format('drop policy if exists desk_public_reader_select on public.%I', target_table);
    execute format(
      'create policy desk_public_reader_select on public.%I for select to desk_public_reader using (true)',
      target_table
    );
  end loop;
end $$;

-- Snapshot table stays publisher/service-role only. Live read does not use it.
revoke all on table public.dashboard_snapshots from desk_public_reader;
