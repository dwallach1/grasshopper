-- Read-only checks for the gate report. Raises on the first failure; writes nothing.
do $$
declare
  v numeric;
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
  assert public.decision_gate_key('oddsborne', 'Morning skips AM 2026-10-03', '{}'::jsonb) = 'morning_rollup', 'morning';
  assert public.decision_gate_key('oddsborne', 'wx pass SFO', '{"pattern":"fav_vs_forecast"}'::jsonb) = 'weather_forecast_gate', 'weather';
  assert public.decision_gate_key('oddsborne', 'fair 0.62 vs 0.60; post-fee maker -0.01', '{}'::jsonb) = 'edge_below_gate', 'edge';
  assert public.decision_gate_key('oddsborne', 'no two-way de-vig for the long side', '{}'::jsonb) = 'devig_gate', 'devig';
  assert public.decision_gate_key('oddsborne', '20261013_am pass: fair 0.5; CLEARED gate but not entered: same_game', '{}'::jsonb) = 'same_game', 'same game before edge';
  assert public.decision_gate_key('oddsborne', 'note with no gate', '{}'::jsonb) = 'unlabeled', 'unlabeled';
  assert public.decision_gate_key('quantanamo', 'x', '{}'::jsonb) = 'unlabeled', 'quantanamo unlabeled';

  assert public.gate_outcome_verdict(7, 0.03) = 'too few to tell', 'under 8';
  assert public.gate_outcome_verdict(8, 0.031) = 'costing growth', 'positive mean';
  assert public.gate_outcome_verdict(8, -0.01) = 'protecting', 'negative mean';
  assert public.gate_outcome_verdict(8, 0) = 'too few to tell', 'zero mean';
  assert public.gate_outcome_verdict(8, null) = 'too few to tell', 'null mean';

  assert public.gate_belief_due(null, 8, 'protecting'), 'first verdict';
  assert not public.gate_belief_due('protecting', 12, 'protecting'), 'same verdict is not due';
  assert public.gate_belief_due('protecting', 12, 'costing growth'), 'flip is due';
  assert not public.gate_belief_due(null, 8, 'too few to tell'), 'too few never writes';
  assert not public.gate_belief_due(null, 7, 'protecting'), 'under the bar';

  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%gate_belief_due%',
    'belief writer uses the due check';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) like '%rule_changed%',
    'belief records that the rule was not changed';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) not like '%update public.theses%',
    'belief writer does not rescore a thesis';
  assert pg_get_functiondef('private.record_gate_outcome_beliefs()'::regprocedure) not like '%desk_rules%',
    'belief writer does not touch a rule';
end;
$$;
