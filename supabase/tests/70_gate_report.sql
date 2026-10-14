-- Read-only checks for the gate report. Raises on the first failure; writes nothing.
do $$
declare
  v numeric;
  v_doc jsonb;
begin
  -- Long share: +3.1 points on 100 is +3.1%.
  v := public.decision_outcome_pct('equity', 'long', 100, 103.1, null, '{}'::jsonb);
  assert v = 0.031, format('long pct %s', v);

  -- Short share: a higher mark is a loss.
  v := public.decision_outcome_pct('equity', 'short', 100, 103, null, '{}'::jsonb);
  assert v = -0.03, format('short pct %s', v);

  -- Per-token SOL: the raw difference is tiny; the percent is not.
  v := public.decision_outcome_pct('meme', 'long', 0.00001, 0.000012, null, '{}'::jsonb);
  assert v = 0.2, format('sol pct %s', v);
  v := public.decision_outcome_pct('meme', 'short', 0.00001, 0.000012, null, '{}'::jsonb);
  assert v = -0.2, format('sol short pct %s', v);

  -- NO in the side's own price. Win pays (1 - 0.25) / 0.25. Loss is -100%.
  v := public.decision_outcome_pct('prediction', 'no', 0.25, null, 'no', '{"price_terms":"side"}'::jsonb);
  assert v = 3, format('no side win %s', v);
  v := public.decision_outcome_pct('prediction', 'no', 0.25, null, 'yes', '{"price_terms":"side"}'::jsonb);
  assert v = -1, format('no side loss %s', v);

  -- NO logged in YES terms: book 0.80 is the YES price, so the NO cost is 0.20.
  v := public.decision_outcome_pct('prediction', 'no', 0.8, null, 'no', '{"price_terms":"yes"}'::jsonb);
  assert abs(v - 4) < 0.0000001, format('no yes-terms win %s', v);
  v := public.decision_outcome_pct('prediction', 'no', 0.8, null, 'yes', '{"price_terms":"yes"}'::jsonb);
  assert v = -1, format('no yes-terms loss %s', v);

  -- No stored mark, no percent.
  assert public.decision_outcome_pct('equity', 'long', 100, null, null, '{}'::jsonb) is null, 'missing mark';
  assert public.decision_outcome_pct('prediction', 'yes', 0.4, null, null, '{}'::jsonb) is null, 'unresolved';

  assert public.decision_gate_key('bandit', 'x', '{"blocked_by":"1h_cap_30"}'::jsonb) = '1h_cap_30', 'kept blocked_by';
  assert public.decision_gate_key('oddsborne', 'Morning skips AM 2026-10-03', '{}'::jsonb) = 'unlabeled', 'morning title is not a gate';
  assert public.decision_gate_key('oddsborne', 'Morning skips AM 2026-10-03', '{"blocked_by":"morning_rollup"}'::jsonb) = 'unlabeled', 'morning label ignored';
  assert public.decision_gate_key('oddsborne', 'Afternoon sports 2026-10-03', '{"blocked_by":"afternoon_rollup"}'::jsonb) = 'unlabeled', 'afternoon label ignored';
  assert public.decision_gate_key('oddsborne', 'Morning skips AM 2026-10-03', '{"blocked_by":"edge_below_gate"}'::jsonb) = 'edge_below_gate', 'written gate wins';
  assert public.decision_gate_key('oddsborne', 'wx pass SFO', '{"pattern":"fav_vs_forecast"}'::jsonb) = 'weather_forecast_gate', 'weather';
  assert public.decision_gate_key('oddsborne', 'fair 0.62 vs 0.60; post-fee maker -0.01', '{}'::jsonb) = 'edge_below_gate', 'edge';
  assert public.decision_gate_key('oddsborne', 'no two-way de-vig for the long side', '{}'::jsonb) = 'devig_gate', 'devig';
  assert public.decision_gate_key('oddsborne', '20261013_am pass: fair 0.5; CLEARED gate but not entered: same_game', '{}'::jsonb) = 'same_game', 'same game before edge';
  assert public.decision_gate_key('oddsborne', 'note with no gate', '{}'::jsonb) = 'unlabeled', 'unlabeled';
  assert public.decision_gate_key('quantanamo', 'x', '{}'::jsonb) = 'unlabeled', 'quantanamo unlabeled';

  v_doc := public.oddsborne_note_blocking_gate(
    'aec-nfl-gb-tb-2026-10-04 post-fee maker -0.027289',
    '{"comps_top":[{"market":"aec-nfl-gb-tb-2026-10-04","post_fee_maker":-0.027289}]}'::jsonb,
    'aec-nfl-gb-tb-2026-10-04'
  );
  assert v_doc->>'gate' = 'edge_below_gate', format('gb-tb %s', v_doc);
  assert abs((v_doc->>'edge')::numeric - (-0.027289)) < 0.0000001, 'gb-tb edge';

  v_doc := public.oddsborne_note_blocking_gate(
    'aec-nfl-tb-dal-2026-10-05 SKIP forced (pm_enter DB timeout)',
    '{"candidates":[{"slug":"aec-nfl-tb-dal-2026-10-05","maker":0.011879}]}'::jsonb,
    'aec-nfl-tb-dal-2026-10-05'
  );
  assert v_doc->>'gate' = 'not_placed', format('tb-dal %s', v_doc);
  assert abs((v_doc->>'edge')::numeric - 0.011879) < 0.0000001, 'tb-dal edge';

  v_doc := public.oddsborne_note_blocking_gate(
    'aec-nfl-hou-ten-2026-10-06 not a real positive edge',
    '{"comps_top":[{"market":"aec-nfl-hou-ten-2026-10-06","post_fee_maker":0.000612}]}'::jsonb,
    'aec-nfl-hou-ten-2026-10-06'
  );
  assert v_doc->>'gate' = 'edge_below_gate', format('hou-ten phrase %s', v_doc);

  v_doc := public.oddsborne_note_blocking_gate('LAA Edge under 8c bar', '{}'::jsonb, 'aec-mlb-laa');
  assert v_doc->>'gate' = 'edge_below_gate', format('8c bar %s', v_doc);

  v_doc := public.oddsborne_note_blocking_gate(
    'SFO aligned — no edge. TEASE then SKIP. mushy forecast.',
    '{}'::jsonb,
    'tc-temp-sfohigh-2026-09-14-gte74lt75f'
  );
  assert v_doc->>'gate' = 'unlabeled', format('weather rollup %s', v_doc);

  v_doc := public.oddsborne_note_blocking_gate(
    E'cpic-uscpi-august-yoy-2026-09-11-gt3pt4pct BBO 0.26/0.27 mid 0.265.\nCleveland Fed thin after-spread edge, skip.',
    '{}'::jsonb,
    'cpic-uscpi-august-yoy-2026-09-11-gt3pt4pct'
  );
  assert v_doc->>'gate' = 'edge_below_gate', format('phrase on the next line %s', v_doc);

  v_doc := public.oddsborne_note_blocking_gate(
    'NYC aligned — no edge',
    '{"comps_top":[{"market":"aec-nfl-gb-tb-2026-10-04","post_fee_maker":-0.027289}]}'::jsonb,
    'aec-nfl-gb-tb-2026-10-04'
  );
  assert v_doc->>'gate' = 'edge_below_gate', format('edge from the table %s', v_doc);
  assert v_doc->>'why' like '%under the minimum%', format('did not quote another market %s', v_doc);

  v_doc := public.oddsborne_note_blocking_gate(
    E'other-market thin edge\naec-nfl-tb-dal-2026-10-05 SKIP forced (pm_enter DB timeout)',
    '{"candidates":[{"slug":"aec-nfl-tb-dal-2026-10-05","maker":0.011879}]}'::jsonb,
    'aec-nfl-tb-dal-2026-10-05'
  );
  assert v_doc->>'gate' = 'not_placed', format('did not steal a line %s', v_doc);

  assert abs(public.student_t_crit_95(9) - 2.2622) < 0.00005, 't df 9';
  assert abs(public.student_t_crit_95(6) - 2.4469) < 0.00005, 't df 6';
  assert abs(public.student_t_crit_95(30) - 2.0423) < 0.00005, 't df 30';
  assert abs(public.student_t_crit_95(120) - 1.9799) < 0.0002, 't df 120';

  -- Binary: ten wide outcomes, mean +75%, interval still includes a scratch.
  assert public.gate_outcome_verdict(10, 0.7536, 1.7277) = 'too few to tell', 'wide binary mean';
  -- Continuous: eight tight gains clear. Eight noisy +3.1% gains do not (the old bar would have).
  assert public.gate_outcome_verdict(8, 0.02, 0.002) = 'costing growth', 'tight positive mean';
  assert public.gate_outcome_verdict(8, 0.031, 0.2) = 'too few to tell', 'noisy +3.1% is not evidence';
  assert public.gate_outcome_verdict(8, 0.005, 0.04) = 'too few to tell', 'small noisy mean';
  assert public.gate_outcome_verdict(12, -1, 0) = 'protecting', 'identical losses';
  assert public.gate_outcome_verdict(30, -0.02, 0.01) = 'protecting', 'tight share loss';
  assert public.gate_outcome_verdict(1, 0.5, null) = 'too few to tell', 'one score';
  assert public.gate_outcome_verdict(247, -0.0127, 1.0881) = 'too few to tell', 'edge gate scratch';
  assert public.gate_outcome_verdict(5, 0.0006, 0.0576) = 'too few to tell', 'equity scratch';

  v := public.gate_more_needed(10, 0.7536, 1.7277);
  assert v between 10 and 40, format('more needed %s', v);
  assert public.gate_more_needed(247, -0.0127, 1.0881) is null, 'scratch names no count';
  assert public.gate_more_needed(12, -1, 0) = 0, 'already settled';

  assert public.gate_belief_due(null, 8, 'protecting'), 'first verdict';
  assert not public.gate_belief_due('protecting', 12, 'protecting'), 'same verdict is not due';
  assert public.gate_belief_due('protecting', 12, 'costing growth'), 'flip is due';
  assert not public.gate_belief_due(null, 8, 'too few to tell'), 'too few does not open a belief';
  assert not public.gate_belief_due('too few to tell', 30, 'too few to tell'), 'same too-few is not due';
  assert public.gate_belief_due('protecting', 30, 'too few to tell'), 'taking a lesson back is due';
  assert not public.gate_belief_due('superseded', 10, 'too few to tell'), 'superseded stays history';
  assert not public.gate_belief_due('superseded', 10, 'protecting'), 'superseded is not rewritten';

  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%gate_belief_due%',
    'belief writer uses the due check';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%rule_changed%',
    'belief records that the rule was not changed';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%supersedes%',
    'belief points at the row it replaces';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%student_t_95%',
    'belief names the interval';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) not like '%update public.theses%',
    'belief writer does not rescore a thesis';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) not like '%desk_rules%',
    'belief writer does not touch a rule';
  assert pg_get_functiondef('private.account_snapshot_gate_belief()'::regprocedure) like '%record_gate_outcome_beliefs%',
    'snapshot schedule calls the writer';
  assert exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'account_snapshots'
      and t.tgname = 'account_snapshot_gate_belief'
      and not t.tgisinternal
  ), 'account snapshot trigger is installed';
end;
$$;
