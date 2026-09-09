-- Claim investigation packets from Grok (X/web discovery) attached to bookmarks.

alter table public.bookmarks
  add column if not exists investigation_model text,
  add column if not exists investigation_prompt_version text,
  add column if not exists investigation_output jsonb,
  add column if not exists investigated_at timestamptz;

alter table public.bookmarks
  drop constraint if exists bookmarks_investigation_complete_check;

alter table public.bookmarks
  add constraint bookmarks_investigation_complete_check check (
    (investigation_model is null and investigation_prompt_version is null and investigation_output is null and investigated_at is null)
    or
    (investigation_model is not null and investigation_prompt_version is not null and investigation_output is not null and investigated_at is not null)
  );

create index if not exists idx_bookmarks_investigation_pending
  on public.bookmarks (classified_at desc nulls last)
  where is_market_related
    and classification_output is not null
    and investigation_output is null;

-- Publish investigation packets into the dashboard read model.
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
  from public;
grant execute on function private.build_dashboard_snapshot(jsonb, timestamptz)
  to postgres, service_role, thesisforge_worker;
