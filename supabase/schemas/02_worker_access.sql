-- Least-privilege role used by trusted local and scheduled Quantanamo jobs.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quantanamo_worker') then
    create role quantanamo_worker nologin noinherit;
  end if;
end $$;

-- Bookmark reclassification replaces only Worker-owned derived evidence. Keep
-- DELETE limited to the exact tables used by that transaction.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'bookmark_symbols','claims','ontology_evidence','ontology_observations',
    'ontology_candidate_evidence','thesis_evidence'
  ]
  loop
    execute format(
      'grant delete on table public.%I to quantanamo_worker',
      target_table
    );
    execute format(
      'create policy quantanamo_worker_delete on public.%I for delete to quantanamo_worker using (true)',
      target_table
    );
  end loop;
end $$;

-- Cloudflare Workflows publish a complete dashboard snapshot through one
-- narrowly authorized RPC. The Worker never receives a database password or
-- service-role key, and all source reads plus the final upsert happen inside a
-- single Postgres transaction.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.dashboard_run_detail(
  p_notes text,
  p_run_type text,
  p_complete boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  detail jsonb;
begin
  if p_notes is not null and pg_input_is_valid(p_notes, 'jsonb') then
    detail := p_notes::jsonb;
  end if;
  if detail is null or jsonb_typeof(detail) <> 'object' then
    detail := jsonb_build_object(
      'headline', initcap(replace(p_run_type, '_', ' ')),
      'summary', coalesce(p_notes, '')
    );
  end if;
  return jsonb_build_object(
    'status', coalesce(detail->>'status', case when p_complete then 'complete' else 'running' end),
    'headline', coalesce(detail->>'headline', initcap(replace(p_run_type, '_', ' '))),
    'summary', coalesce(detail->>'summary', coalesce(p_notes, '')),
    'insights', coalesce(detail->'insights', '[]'::jsonb),
    'learnings', coalesce(detail->'learnings', '[]'::jsonb),
    'actions', coalesce(detail->'actions', '[]'::jsonb),
    'metrics', coalesce(detail->'metrics', '{}'::jsonb)
  );
end;
$$;
revoke all on function private.dashboard_run_detail(text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function private.dashboard_run_detail(text, text, boolean)
  to service_role;

create or replace function private.compact_jsonb(p_value jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(string_agg(
        to_jsonb(e.key)::text || ':' || private.compact_jsonb(e.value),
        ',' order by e.ordinality
      ), '') || '}'
      from jsonb_each(p_value) with ordinality e(key, value, ordinality)
    )
    when 'array' then (
      select '[' || coalesce(string_agg(
        private.compact_jsonb(e.value),
        ',' order by e.ordinality
      ), '') || ']'
      from jsonb_array_elements(p_value) with ordinality e(value, ordinality)
    )
    else p_value::text
  end;
$$;
revoke all on function private.compact_jsonb(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.compact_jsonb(jsonb) to service_role;

create or replace function private.normalize_dashboard_jsonb(p_value jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select coalesce(
        jsonb_object_agg(e.key, private.normalize_dashboard_jsonb(e.value)),
        '{}'::jsonb
      )
      from jsonb_each(p_value) e
    )
    when 'array' then (
      select coalesce(
        jsonb_agg(
          private.normalize_dashboard_jsonb(e.value)
          order by e.ordinality
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(p_value) with ordinality e(value, ordinality)
    )
    when 'string' then to_jsonb(
      regexp_replace(
        regexp_replace(
          replace(p_value #>> '{}', '+00:00', 'Z'),
          E'\\.([0-9]*[1-9])0+Z$',
          E'.\\1Z',
          'g'
        ),
        E'\\.0+Z$',
        'Z',
        'g'
      )
    )
    when 'number' then to_jsonb(trim_scale((p_value #>> '{}')::numeric))
    else p_value
  end;
$$;
revoke all on function private.normalize_dashboard_jsonb(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.normalize_dashboard_jsonb(jsonb) to service_role;

create or replace function private.dashboard_payload_digest(p_value jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      private.normalize_dashboard_jsonb(p_value)::text,
      'sha256'
    ),
    'hex'
  );
$$;
revoke all on function private.dashboard_payload_digest(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.dashboard_payload_digest(jsonb) to service_role;

create or replace function private.build_dashboard_snapshot(
  p_trade_policy jsonb,
  p_generated_at timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', p_generated_at,
    'trade_policy', p_trade_policy,
    'run_reports', coalesce((
      select jsonb_agg(
        (to_jsonb(r) - 'notes') ||
        private.dashboard_run_detail(r.notes, r.run_type, r.completed_at is not null)
        order by r.started_at desc, r.id desc
      )
      from (
        select id, run_type, started_at, completed_at, notes
        from public.runs
        order by started_at desc, id desc
        limit 24
      ) r
    ), '[]'::jsonb),
    'automations', coalesce((
      select jsonb_agg(to_jsonb(a) order by
        case a.status when 'ACTIVE' then 0 else 1 end,
        a.next_run_at,
        a.name
      )
      from (
        select a.id, a.name, a.prompt, a.kind, a.status, a.rrule, a.model,
               a.reasoning_effort, a.next_run_at, a.last_run_at, a.indexed_at,
               count(r.thread_id) as run_count,
               count(r.thread_id) filter (where r.outcome='passed') as passed_count,
               count(r.thread_id) filter (where r.outcome='failed') as failed_count
        from public.codex_automations a
        left join public.codex_automation_runs r on r.automation_id=a.id
        group by a.id
      ) a
    ), '[]'::jsonb),
    'automation_runs', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.started_at desc)
      from (
        select r.thread_id, r.automation_id, a.name as automation_name,
               r.status, r.outcome, r.started_at, r.completed_at, r.duration_ms,
               r.title, r.summary, r.final_output, r.findings, r.learnings,
               r.explored, r.actions, r.timeline, r.error_text, r.tokens_used
        from public.codex_automation_runs r
        join public.codex_automations a on a.id=r.automation_id
        order by r.started_at desc
        limit 200
      ) r
    ), '[]'::jsonb),
    'theses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id, 'name', t.name, 'summary', t.summary, 'status', t.status,
          'confidence', t.confidence, 'time_horizon', t.time_horizon,
          'stance', t.stance, 'variant_perception', t.variant_perception,
          'falsifier', t.falsifier,
          'symbols', coalesce((
            select jsonb_agg(x.symbol order by x.weight_hint desc, x.symbol)
            from (
              select ts.symbol, ts.weight_hint
              from public.thesis_symbols ts
              where ts.thesis_id=t.id
              order by ts.weight_hint desc, ts.symbol
              limit 8
            ) x
          ), '[]'::jsonb),
          'recent_investigations', coalesce((
            select jsonb_agg(inv.packet order by inv.investigated_at desc)
            from (
              select b.investigation_output || jsonb_build_object(
                'bookmark_id', b.id,
                'investigated_at', b.investigated_at,
                'investigation_model', b.investigation_model
              ) as packet,
              b.investigated_at
              from public.thesis_evidence te
              join public.bookmarks b on b.id=te.bookmark_id
              where te.thesis_id=t.id
                and te.evidence_type='x_claim_investigation'
                and b.investigation_output is not null
              order by b.investigated_at desc nulls last
              limit 6
            ) inv
          ), '[]'::jsonb)
        )
        order by t.confidence desc, t.name
      )
      from public.theses t
    ), '[]'::jsonb),
    'claim_investigations', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.investigated_at desc)
      from (
        select b.id as bookmark_id, b.investigated_at, b.investigation_model,
               b.investigation_prompt_version, b.investigation_output,
               b.market_score, coalesce((
                 select jsonb_agg(bs.symbol order by bs.symbol)
                 from public.bookmark_symbols bs where bs.bookmark_id=b.id
               ), '[]'::jsonb) as symbols
        from public.bookmarks b
        where b.investigation_output is not null
        order by b.investigated_at desc nulls last
        limit 40
      ) i
    ), '[]'::jsonb),
    'predictions', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.target_date, p.probability desc)
      from (
        select id, external_key, thesis_id, statement, target_date, probability,
               status, resolution_notes
        from public.predictions
      ) p
    ), '[]'::jsonb),
    'insights', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id, 'slug', i.slug, 'title', i.title, 'summary', i.summary,
          'insight_type', i.insight_type, 'novelty', i.novelty,
          'confidence', i.confidence,
          'links', coalesce((
            select jsonb_agg(il.node_id order by il.node_id)
            from public.insight_links il where il.insight_id=i.id
          ), '[]'::jsonb)
        )
        order by i.novelty desc, i.confidence desc
      )
      from public.insights i where i.status='active'
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.strength desc)
      from (
        select src_thesis_id, dst_thesis_id, relation_type, strength, rationale
        from public.thesis_relations
      ) r
    ), '[]'::jsonb),
    'ontology_themes', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.status, t.kind, t.name)
      from (
        select t.id, t.thesis_id, t.kind, t.name, t.description, t.status,
               t.match_threshold, t.auto_promote_sources,
               (select count(*) from public.ontology_terms x
                where x.theme_id=t.id and x.status='active') as term_count,
               (select count(*) from public.symbol_theme_memberships m
                where m.theme_id=t.id and m.status='active') as symbol_count
        from public.ontology_themes t
      ) t
    ), '[]'::jsonb),
    'ontology_candidates', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.status, c.source_count desc, c.score desc)
      from (
        select id, candidate_type, candidate_key, proposed_theme_id,
               proposed_label, proposed_description, score, evidence_count,
               source_count, status, first_seen_at, last_seen_at, review_note
        from public.ontology_candidates c
        where source_count >= 2
          and (
            (candidate_type='membership' and exists (
              select 1 from public.symbols s where s.symbol=c.proposed_label
                and s.status in ('known', 'verified', 'active', 'public_comp')
            ))
            or (candidate_type='term' and lower(proposed_label)
                !~ '(^| )(http|https|www|t[.]co)( |$)')
            or (candidate_type='theme' and (
              position(' ' in proposed_label) > 0
              or sample_context->>'feature_type'='hashtag'
            ))
          )
        order by status, source_count desc, score desc
        limit 100
      ) c
    ), '[]'::jsonb),
    'ontology_symbols', coalesce((
      select jsonb_agg(to_jsonb(s) order by
        case s.status when 'blacklisted' then 0 when 'candidate' then 1 else 2 end,
        s.source_count desc, s.mention_count desc, s.symbol
      )
      from (
        select symbol, status, mention_count, source_count, first_seen_at, last_seen_at
        from public.symbols
        order by case status when 'blacklisted' then 0 when 'candidate' then 1 else 2 end,
                 source_count desc, mention_count desc, symbol
        limit 300
      ) s
    ), '[]'::jsonb),
    'ontology_actions', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc, a.id desc)
      from (
        select id, actor_id, entity_type, entity_key, action, created_at
        from public.ontology_management_actions
        order by created_at desc, id desc
        limit 100
      ) a
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by coalesce(e.event_date, '9999-12-31'), e.id)
      from (
        select e.id, e.event_type, e.label, e.event_date, e.status,
               e.source_url, e.summary, coalesce(d.decision, 'watch') as decision,
               d.rationale, d.participation_trigger
        from public.research_events e
        left join public.event_decisions d on d.event_id=e.id
      ) e
    ), '[]'::jsonb),
    'cycles', coalesce((
      select jsonb_agg(to_jsonb(c) - 'updated_at' order by
        case c.stage when 'live' then 1 when 'backtest' then 2
          when 'research' then 3 when 'postmortem' then 4 else 5 end,
        c.updated_at desc
      )
      from (
        select c.id, c.external_key, c.thesis_id, t.name as thesis_name,
               c.hypothesis, c.preregistered_outcome, c.preregistered_at,
               c.stage, c.status, c.iteration, c.market_regime, c.updated_at
        from public.research_cycles c
        join public.theses t on t.id=c.thesis_id
      ) c
    ), '[]'::jsonb),
    'tests', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.tested_at desc, s.id desc)
      from (
        select s.id, s.external_key, s.cycle_id, c.external_key as cycle_key,
               c.thesis_id, s.variant_label, s.status, s.total_return,
               s.max_drawdown, s.deflated_sharpe, s.cost_multiplier,
               s.stress_regime, s.failure_reason, s.autopsy, s.tested_at
        from public.strategy_tests s
        join public.research_cycles c on c.id=s.cycle_id
      ) s
    ), '[]'::jsonb),
    'test_scenarios', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.test_id, x.id)
      from (
        select x.id, x.test_id, s.external_key as test_key, x.scenario_key,
               x.market_regime, x.cost_multiplier, x.outcome, x.metric_value,
               x.breach_type
        from public.test_scenarios x
        join public.strategy_tests s on s.id=x.test_id
      ) x
    ), '[]'::jsonb),
    'agent_runs', coalesce((
      select jsonb_agg(
        (to_jsonb(a) - 'price_blinded') ||
        jsonb_build_object('price_blinded', case when a.price_blinded then 1 else 0 end)
        order by a.id desc
      )
      from (
        select a.id, a.cycle_id, c.external_key as cycle_key, a.agent_role,
               a.independence_group, a.price_blinded, a.status, a.summary,
               a.created_at
        from public.agent_runs a
        join public.research_cycles c on c.id=a.cycle_id
      ) a
    ), '[]'::jsonb),
    'lessons', coalesce((
      select jsonb_agg(
        (to_jsonb(l) - 'incorporated') ||
        jsonb_build_object('incorporated', case when l.incorporated then 1 else 0 end)
        order by l.incorporated, l.id desc
      )
      from (
        select id, cycle_id, test_id, thesis_id, lesson_type, summary,
               market_regime, incorporated, created_at
        from public.research_lessons
      ) l
    ), '[]'::jsonb),
    'risk_controls', coalesce((
      select jsonb_agg(
        (to_jsonb(r) - 'threshold_json') ||
        jsonb_build_object('threshold_json', private.compact_jsonb(r.threshold_json))
        order by r.scope, r.control_key
      )
      from (
        select id, control_key, scope, control_type, threshold_json,
               enforcement_level, status, updated_at
        from public.risk_controls where status='active'
      ) r
    ), '[]'::jsonb),
    'account_state', (
      select to_jsonb(a)
      from (
        select observed_at, account_label, total_value, equity_value, cash,
               buying_power, source
        from public.account_snapshots
        order by observed_at desc, id desc
        limit 1
      ) a
    ),
    'trade_proposals', coalesce((
      select jsonb_agg(
        case when p.broker_alerts is null then to_jsonb(p)
          else (to_jsonb(p) - 'broker_alerts') ||
               jsonb_build_object('broker_alerts', private.compact_jsonb(p.broker_alerts))
        end
        order by p.created_at desc, p.id desc
      )
      from (
        select id, thesis_id, symbol, side, notional, order_type, status,
               rationale, created_at, reviewed_at, broker_alerts
        from public.trade_proposals
      ) p
    ), '[]'::jsonb),
    'graph', jsonb_build_object(
      'nodes', coalesce((
        select jsonb_agg(
          (to_jsonb(n) - 'properties_json') ||
          jsonb_build_object('properties_json', private.compact_jsonb(n.properties_json))
          order by n.node_type, n.label
        )
        from (
          select id, node_type, label, properties_json
          from public.graph_nodes
          where node_type in ('thesis','concept','symbol','event')
        ) n
      ), '[]'::jsonb),
      'edges', coalesce((
        select jsonb_agg(to_jsonb(e) order by e.weight desc)
        from (
          select src_id, dst_id, edge_type, weight, evidence_count
          from public.graph_edges
          where weight >= 1.5
          order by weight desc
          limit 120
        ) e
      ), '[]'::jsonb)
    ),
    'financial_data', jsonb_build_object(
      'network_requests', (select count(*) from public.financial_api_requests),
      'cache_hits', (select count(*) from public.financial_access_log where access_type='cache'),
      'records', (select count(*) from public.financial_records),
      'tickers', (select count(distinct ticker) from public.financial_records where ticker is not null),
      'datasets', (select count(distinct dataset) from public.financial_records)
    ),
    'counts', jsonb_build_object(
      'sources', (select count(*) from public.graph_nodes where node_type='source'),
      'symbols', (select count(*) from public.symbols),
      'open_research', (select count(*) from public.research_queue where status='open'),
      'tests_killed', (select count(*) from public.strategy_tests where status='killed'),
      'tests_survived', (select count(*) from public.strategy_tests where status='survived'),
      'scenario_cells', (select count(*) from public.test_scenarios)
    )
  );
$$;
revoke all on function private.build_dashboard_snapshot(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.build_dashboard_snapshot(jsonb, timestamptz)
  to service_role;

create or replace function private.reap_stale_automation_runs(
  p_run_max_age interval default interval '2 hours',
  p_task_max_age interval default interval '2 hours'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reaped_runs integer := 0;
  reaped_tasks integer := 0;
  now_ts timestamptz := clock_timestamp();
begin
  with updated as (
    update public.cloud_tasks as t
    set
      status = 'failed',
      error_text = coalesce(nullif(t.error_text, ''), 'stale_task_reaped'),
      completed_at = coalesce(t.completed_at, now_ts),
      updated_at = now_ts
    where t.status in ('queued', 'running')
      and coalesce(t.started_at, t.queued_at) < now_ts - p_task_max_age
    returning t.id
  )
  select count(*)::integer into reaped_tasks from updated;

  with updated as (
    update public.cloud_runs as r
    set
      status = 'failed',
      error_text = coalesce(nullif(r.error_text, ''), 'stale_run_reaped'),
      completed_at = coalesce(r.completed_at, now_ts),
      updated_at = now_ts,
      summary = coalesce(r.summary, '{}'::jsonb) || jsonb_build_object(
        'reaped_at', now_ts,
        'reap_reason', 'stale_nonterminal_run'
      )
    where r.status in ('queued', 'running')
      and coalesce(r.started_at, r.created_at) < now_ts - p_run_max_age
    returning r.id
  )
  select count(*)::integer into reaped_runs from updated;

  return jsonb_build_object(
    'reaped_runs', reaped_runs,
    'reaped_tasks', reaped_tasks,
    'reaped_at', now_ts
  );
end;
$$;
revoke all on function private.reap_stale_automation_runs(interval, interval)
  from public, anon, authenticated;
grant execute on function private.reap_stale_automation_runs(interval, interval)
  to service_role;

create or replace function public.reap_stale_automation_runs(
  p_run_max_age interval default interval '2 hours',
  p_task_max_age interval default interval '2 hours'
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.reap_stale_automation_runs(p_run_max_age, p_task_max_age);
$$;
revoke all on function public.reap_stale_automation_runs(interval, interval)
  from public, anon, authenticated;
grant execute on function public.reap_stale_automation_runs(interval, interval)
  to service_role;

create or replace function public.publish_dashboard_snapshot(
  p_trade_policy jsonb,
  p_publish_current boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  supplied_token text;
  generated_at timestamptz := clock_timestamp();
  target_id text := case when p_publish_current then 'current' else 'cloudflare-shadow' end;
  next_payload jsonb;
  current_payload jsonb;
  normalized_digest text;
  current_digest text;
  changed_keys jsonb;
  reap_result jsonb;
begin
  supplied_token := coalesce(
    current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-publication-token',
    ''
  );
  if encode(extensions.digest(supplied_token, 'sha256'), 'hex') not in (
    '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c',
    -- local-publication-token-do-not-use-in-prod
    'f70394889d68639604c5e41c25080393f7544bf5e96b276c7ac8eefa7e6f562e'
  ) then
    raise insufficient_privilege using message = 'Dashboard publication authorization required';
  end if;
  if p_trade_policy is null or jsonb_typeof(p_trade_policy) <> 'object' then
    raise check_violation using message = 'Trade policy must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('quantanamo-dashboard-publication', 0));
  reap_result := private.reap_stale_automation_runs();
  select payload into current_payload
  from public.dashboard_snapshots
  where id='current';

  next_payload := private.build_dashboard_snapshot(p_trade_policy, generated_at);
  insert into public.dashboard_snapshots(id, generated_at, payload)
  values (target_id, generated_at, next_payload)
  on conflict(id) do update
  set generated_at=excluded.generated_at, payload=excluded.payload;

  normalized_digest := private.dashboard_payload_digest(next_payload - 'generated_at');
  current_digest := case when current_payload is null then null
    else private.dashboard_payload_digest(current_payload - 'generated_at') end;
  select coalesce(jsonb_agg(k.key order by k.key), '[]'::jsonb)
  into changed_keys
  from jsonb_object_keys(next_payload - 'generated_at') as k(key)
  where current_payload is null
     or private.dashboard_payload_digest((next_payload - 'generated_at')->k.key)
        is distinct from private.dashboard_payload_digest(
          (current_payload - 'generated_at')->k.key
        );

  return jsonb_build_object(
    'target_id', target_id,
    'generated_at', generated_at,
    'normalized_sha256', normalized_digest,
    'current_normalized_sha256', current_digest,
    'matches_current', normalized_digest = current_digest,
    'changed_keys', changed_keys,
    'thesis_count', jsonb_array_length(next_payload->'theses'),
    'trading_enabled', false,
    'reaped_stale_automations', reap_result
  );
end;
$$;
revoke all on function public.publish_dashboard_snapshot(jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_dashboard_snapshot(jsonb, boolean)
  to service_role;

-- Public phone desk reads a Worker-served KV snapshot, not PostgREST.
-- Keep dashboard_snapshots private: service_role / QUANTANAMO_DATABASE_URL only.
revoke all on table public.dashboard_snapshots from anon, authenticated;

create or replace function public.is_quantanamo_dashboard_reader()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select false
$$;
revoke all on function public.is_quantanamo_dashboard_reader()
  from public, anon, authenticated, service_role;

drop policy if exists quantanamo_site_snapshot_select on public.dashboard_snapshots;
drop policy if exists thesisforge_site_snapshot_select on public.dashboard_snapshots;

create or replace function public.is_quantanamo_site_manager()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-dashboard-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
      'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9',
      -- local-dashboard-token-do-not-use-in-prod
      '329669fba60b385cfa668bb781897f56cdbecf54101b96b1d642c05473fd311b'
    )
    and encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '644fbeec6d5153114d1d24d36d95dbefbbb08c9a37d7386c7664def738078696',
      '9022c6a63dd1d8d166337c64103cfb27ec879a7e390d4241ca1df3bc5908f92b',
      -- local-manager-token-do-not-use-in-prod
      '48e4a4f0f7d26f4c8f0764dffb572280e62ec090f2ae0e483f64f2a1ab9b7a44'
    )
    and (
      coalesce(
        (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-user-id'),
        ''
      ) = 'dc4218ec-f17c-4159-9d61-5ed54354ac50'
      or encode(
        extensions.digest(
          lower(
            coalesce(
              (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-user-id'),
              ''
            )
          ),
          'sha256'
        ),
        'hex'
      ) in (
        '68c1ad308ad4b806b9c0d4b2652c4899f2e44523fa5f6fb5d094559f59950e26',
        -- local@quantanamo.dev
        'c4cfc998df44884a2061a4ef3cc8b01d6e98c2c45c84273b0a91de79c4c50078'
      )
    );
$$;
revoke all on function public.is_quantanamo_site_manager() from public, authenticated, service_role;
grant execute on function public.is_quantanamo_site_manager() to anon;

grant select on table public.ontology_themes to anon;
grant select on table public.symbols to anon;
grant select on table public.ontology_candidates to anon;
grant select on table public.ontology_management_actions to anon;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'ontology_themes','symbols','ontology_candidates','ontology_management_actions'
  ]
  loop
    execute format('drop policy if exists quantanamo_site_manager_select on public.%I', target_table);
    execute format(
      'create policy quantanamo_site_manager_select on public.%I for select to anon using ((select public.is_quantanamo_site_manager()))',
      target_table
    );
  end loop;
end $$;

drop policy if exists quantanamo_site_manager_theme_update on public.ontology_themes;
drop policy if exists quantanamo_site_manager_symbol_update on public.symbols;
drop policy if exists quantanamo_site_manager_candidate_update on public.ontology_candidates;
drop policy if exists quantanamo_site_manager_action_insert on public.ontology_management_actions;

-- Retired Sites-era write RPC. Desk is read-only; QUANTANAMO writes ontology.
drop function if exists public.manage_ontology_entity(text, text, text);

create or replace function private.attach_worker_observability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.payload := new.payload || jsonb_build_object(
    'automations', jsonb_build_array(
      jsonb_build_object(
        'id','research-orchestrator','name','Research orchestrator',
        'prompt','Scheduled thesis research, position review, and trade-intent coordination.',
        'kind','cloudflare_worker','status','ACTIVE',
        'rrule','RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10,15;BYMINUTE=05',
        'model','Workers AI','reasoning_effort',null,'next_run_at',null,
        'last_run_at',(select max(started_at) from public.cloud_runs),
        'indexed_at',clock_timestamp(),
        'run_count',(select count(*) from public.cloud_runs),
        'passed_count',(select count(*) from public.cloud_runs where status='complete'),
        'failed_count',(select count(*) from public.cloud_runs where status='failed')
      ),
      jsonb_build_object(
        'id','knowledge-pipeline','name','Knowledge pipeline',
        'prompt','X bookmark sync, document archive, ontology learning, and dashboard projection.',
        'kind','cloudflare_worker','status','ACTIVE',
        'rrule','RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,14;BYMINUTE=35',
        'model',null,'reasoning_effort',null,'next_run_at',null,
        'last_run_at',(select max(started_at) from public.runs where run_type='bookmark_ingest'),
        'indexed_at',clock_timestamp(),
        'run_count',(select count(*) from public.runs where run_type='bookmark_ingest'),
        'passed_count',(select count(*) from public.runs where run_type='bookmark_ingest' and completed_at is not null
          and coalesce((case when notes ~ '^\s*\{' then notes::jsonb->>'outcome' end), 'passed') = 'passed'),
        'failed_count',(select count(*) from public.runs where run_type='bookmark_ingest'
          and coalesce((case when notes ~ '^\s*\{' then notes::jsonb->>'outcome' end), '') = 'failed')
      )
    ),
    'automation_runs', coalesce((
      select jsonb_agg(row_value order by started_at desc)
      from (
        select c.started_at,
          jsonb_build_object(
            'thread_id',c.id::text,'automation_id','research-orchestrator',
            'automation_name','Research orchestrator','status',c.status,
            'outcome',case when c.status='complete' then 'passed' when c.status='failed' then 'failed' when c.status in ('queued','running') then 'running' else 'unknown' end,
            'started_at',c.started_at,'completed_at',c.completed_at,
            'duration_ms',case when c.completed_at is null or c.started_at is null then null else extract(epoch from (c.completed_at-c.started_at))*1000 end,
            'title',coalesce(c.market_slot,'Scheduled research run'),
            'summary',coalesce(c.summary->>'summary',c.summary::text),
            'final_output',null,
            'findings',coalesce(
              case when jsonb_typeof(c.summary->'findings')='array' then c.summary->'findings' end,
              (
                select coalesce(jsonb_agg(finding order by ord), '[]'::jsonb)
                from (
                  select trim(both from concat_ws(' · ',
                    nullif(t.entity_key, ''),
                    nullif(t.output->>'symbol', ''),
                    nullif(t.output->>'claim_status', ''),
                    left(coalesce(t.output->>'summary', ''), 240)
                  )) as finding,
                  row_number() over (order by t.completed_at nulls last, t.queued_at) as ord
                  from public.cloud_tasks t
                  where t.run_id=c.id
                    and t.status='complete'
                    and coalesce(t.output->>'summary', '') <> ''
                  limit 40
                ) findings
              ),
              '[]'::jsonb
            ),
            'learnings',coalesce(
              case when jsonb_typeof(c.summary->'learnings')='array' then c.summary->'learnings' end,
              (
                select coalesce(jsonb_agg(risk order by ord), '[]'::jsonb)
                from (
                  select risk, row_number() over (order by t.completed_at nulls last, t.queued_at, ordinality) as ord
                  from public.cloud_tasks t
                  cross join lateral jsonb_array_elements_text(coalesce(t.output->'risks', '[]'::jsonb))
                    with ordinality as risk(risk, ordinality)
                  where t.run_id=c.id and t.status='complete'
                  limit 40
                ) risks
              ),
              '[]'::jsonb
            ),
            'explored',coalesce(
              case when jsonb_typeof(c.summary->'explored')='array' then c.summary->'explored' end,
              (
                select coalesce(jsonb_agg(label order by label), '[]'::jsonb)
                from (
                  select distinct coalesce(nullif(t.output->>'symbol', ''), t.entity_key) as label
                  from public.cloud_tasks t
                  where t.run_id=c.id
                    and coalesce(nullif(t.output->>'symbol', ''), t.entity_key) is not null
                  limit 40
                ) explored
              ),
              '[]'::jsonb
            ),
            'actions',coalesce(
              case when jsonb_typeof(c.summary->'actions')='array' then c.summary->'actions' end,
              (
                select coalesce(jsonb_agg(action order by ord), '[]'::jsonb)
                from (
                  select action, row_number() over (order by t.completed_at nulls last, t.queued_at, ordinality) as ord
                  from public.cloud_tasks t
                  cross join lateral jsonb_array_elements_text(coalesce(t.output->'actions', '[]'::jsonb))
                    with ordinality as action(action, ordinality)
                  where t.run_id=c.id and t.status='complete'
                  limit 40
                ) actions
              ),
              '[]'::jsonb
            ),
            'timeline','[]'::jsonb,'error_text',c.error_text,'tokens_used',null
          ) as row_value
        from public.cloud_runs c
        union all
        select r.started_at,
          jsonb_build_object(
            'thread_id','knowledge-' || r.id::text,'automation_id','knowledge-pipeline',
            'automation_name','Knowledge pipeline',
            'status',case when r.completed_at is null then 'running' else 'complete' end,
            'outcome',case
              when r.completed_at is null then 'running'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'failed' then 'failed'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'skipped' then 'cancelled'
              else 'passed'
            end,
            'started_at',r.started_at,'completed_at',r.completed_at,
            'duration_ms',case when r.completed_at is null then null else extract(epoch from (r.completed_at-r.started_at))*1000 end,
            'title',case
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'failed' then 'Bookmark ingest failed'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'skipped' then 'Bookmark ingest skipped'
              else 'Bookmark ingestion'
            end,
            'summary',r.notes,
            'final_output',null,'findings','[]'::jsonb,'learnings','[]'::jsonb,
            'explored','[]'::jsonb,'actions','[]'::jsonb,'timeline','[]'::jsonb,
            'error_text',case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'error' else null end,
            'tokens_used',null
          )
        from public.runs r where r.run_type='bookmark_ingest'
        order by started_at desc limit 200
      ) x
    ), '[]'::jsonb)
  );
  return new;
end;
$$;
revoke all on function private.attach_worker_observability() from public, anon, authenticated;
grant execute on function private.attach_worker_observability() to service_role;

drop trigger if exists dashboard_snapshots_worker_observability on public.dashboard_snapshots;
create trigger dashboard_snapshots_worker_observability
before insert or update of payload on public.dashboard_snapshots
for each row execute function private.attach_worker_observability();


grant connect on database postgres to quantanamo_worker;
grant usage on schema public to quantanamo_worker;

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'runs','codex_automations','codex_automation_runs','bookmarks','bookmark_urls','symbols','bookmark_symbols','claims','theses',
    'ontology_themes','ontology_terms','ontology_lexicon','symbol_theme_memberships',
    'ontology_observations','ontology_evidence','ontology_candidates','ontology_candidate_evidence','ontology_management_actions',
    'thesis_symbols','thesis_evidence','thesis_scores','catalysts','portfolio_exposure',
    'account_snapshots','trade_proposals','postmortems','articles','research_documents',
    'research_document_sources','research_document_annotations','graph_nodes','graph_edges',
    'research_events','research_queue','predictions','insights','insight_links','thesis_relations',
    'event_decisions','research_cycles','strategy_tests','test_scenarios','backtest_artifacts','agent_runs',
    'cloud_runs','cloud_tasks','position_episodes','position_monitor_events',
    'trade_intents','broker_execution_attempts','broker_fills',
    'research_lessons','risk_controls','financial_api_requests','financial_request_cache',
    'financial_access_log','financial_records','dashboard_snapshots'
  ]
  loop
    execute format(
      'grant select, insert, update on table public.%I to quantanamo_worker',
      target_table
    );
    execute format(
      'create policy quantanamo_worker_select on public.%I for select to quantanamo_worker using (true)',
      target_table
    );
    execute format(
      'create policy quantanamo_worker_insert on public.%I for insert to quantanamo_worker with check (true)',
      target_table
    );
    execute format(
      'create policy quantanamo_worker_update on public.%I for update to quantanamo_worker using (true) with check (true)',
      target_table
    );

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and information_schema.columns.table_name = target_table
        and column_name = 'id'
    ) then
      sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
      if sequence_name is not null then
        execute format(
          'grant usage, select, update on sequence %s to quantanamo_worker',
          sequence_name
        );
      end if;
    end if;
  end loop;
end $$;
