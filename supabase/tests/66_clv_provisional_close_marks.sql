-- Checks for migration 66 (CLV leaves out provisional close marks and counts them).
-- Raises on the first failure; writes nothing (the upsert check runs in a subtransaction that is rolled back).
do $$
declare
  v_fn text;
  v_all int;
  v_prov int;
  v_clv int;
  v_sum_n int;
  v_sum_prov int;
begin
  -- The rule: the flag (JSON true or the string), else more than 60 minutes before a known start.
  assert public.decision_close_mark_provisional_reason('{"provisional":true}', now(), null) = 'flagged', 'JSON true flag';
  assert public.decision_close_mark_provisional_reason('{"provisional":"true"}', now(), now() + interval '5 minutes') = 'flagged', 'string flag';
  assert public.decision_close_mark_provisional_reason('{}', now(), null) is null, 'null start without the flag is a closing price';
  assert public.decision_close_mark_provisional_reason('{"provisional":false}', now(), null) is null, 'provisional=false';
  assert public.decision_close_mark_provisional_reason('{}', now(), now() + interval '61 minutes') = 'early', '61 minutes out';
  assert public.decision_close_mark_provisional_reason('{"provisional":false}', now(), now() + interval '7 hours') = 'early',
    'an early mark is provisional even when the flag says false';
  assert public.decision_close_mark_provisional_reason('{}', now(), now() + interval '60 minutes') is null, 'exactly 60 minutes counts';
  assert public.decision_close_mark_provisional_reason('{}', now(), now() + interval '12 minutes') is null, '12 minutes out';

  -- Views: v_decision_clv is v_decision_clv_all minus provisional; the summary counts both.
  select count(*), count(*) filter (where provisional) into v_all, v_prov from public.v_decision_clv_all;
  select count(*) into v_clv from public.v_decision_clv;
  assert v_clv = v_all - v_prov, format('v_decision_clv %s <> all %s - provisional %s', v_clv, v_all, v_prov);
  assert not exists (
    select 1 from public.v_decision_clv v join public.decision_marks m on m.decision_id = v.decision_id and m.mark_kind = 'close'
    where lower(coalesce(m.meta->>'provisional', '')) = 'true'
       or (m.event_start_at is not null and m.event_start_at - m.observed_at > interval '60 minutes')
  ), 'a provisional close mark reached v_decision_clv';
  select coalesce(sum(n), 0), coalesce(sum(provisional_excluded), 0) into v_sum_n, v_sum_prov from public.v_decision_clv_summary;
  assert v_sum_n = v_clv, format('summary n %s <> v_decision_clv %s', v_sum_n, v_clv);
  assert v_sum_prov = v_prov, format('summary provisional_excluded %s <> %s', v_sum_prov, v_prov);
  assert not exists (
    select 1 from public.v_decision_clv_all a join public.decision_marks m on m.id = a.mark_id where m.mark_kind <> 'close'
  ), 'a horizon mark reached the CLV views';

  -- The upsert replaces meta (a merge would keep provisional = true after the pre-game mark).
  v_fn := pg_get_functiondef('public.steward_record_decision_mark(jsonb)'::regprocedure);
  assert v_fn like '%meta = excluded.meta,%', 'close-mark upsert no longer replaces meta';
  assert v_fn not like '%meta || excluded.meta%' and v_fn not like '%meta = public.decision_marks.meta ||%',
    'close-mark upsert merges meta';

  -- Behaviour, rolled back: an early provisional mark, then the pre-game mark that replaces it.
  declare
    v_decision uuid;
    v_start timestamptz := date_trunc('second', now()) + interval '30 minutes';
    v_meta jsonb;
  begin
    v_decision := (public.steward_log_decision(jsonb_build_object(
      'steward', 'oddsborne', 'decision', 'skip', 'instrument', 'test-66-clv-provisional-zz',
      'side', 'no', 'price', 0.40, 'probability', 0.42, 'decided_at', now() - interval '8 hours',
      'source_id', 'test-66-clv-provisional', 'reason', 'test 66 (rolled back)'))->>'id')::uuid;

    perform public.steward_record_decision_mark(jsonb_build_object(
      'steward', 'oddsborne', 'kind', 'close', 'decision_id', v_decision, 'price', 0.45,
      'observed_at', v_start - interval '7 hours', 'event_start_at', v_start, 'source', 'test',
      'meta', jsonb_build_object('provisional', true, 'minutes_before_start', 420)));
    assert not exists (select 1 from public.v_decision_clv where decision_id = v_decision), 'provisional mark in v_decision_clv';
    assert (select provisional_reason from public.v_decision_clv_all where decision_id = v_decision) = 'flagged', 'flagged reason';
    assert (select provisional_excluded from public.v_decision_clv_summary where steward = 'oddsborne' and decision = 'skip')
           = v_sum_prov + 1, 'summary did not count the provisional mark';

    -- An earlier observation does not replace the stored one.
    perform public.steward_record_decision_mark(jsonb_build_object(
      'steward', 'oddsborne', 'kind', 'close', 'decision_id', v_decision, 'price', 0.30,
      'observed_at', v_start - interval '7 hours 30 minutes', 'event_start_at', v_start, 'source', 'test',
      'meta', jsonb_build_object('provisional', false)));
    assert (select price from public.decision_marks where decision_id = v_decision and mark_kind = 'close') = 0.45,
      'an earlier observation replaced the stored mark';

    -- Unflagged but 2 hours out: still provisional, by time.
    perform public.steward_record_decision_mark(jsonb_build_object(
      'steward', 'oddsborne', 'kind', 'close', 'decision_id', v_decision, 'price', 0.46,
      'observed_at', v_start - interval '2 hours', 'event_start_at', v_start, 'source', 'test', 'meta', '{}'::jsonb));
    assert (select provisional_reason from public.v_decision_clv_all where decision_id = v_decision) = 'early', 'early reason';
    assert not exists (select 1 from public.v_decision_clv where decision_id = v_decision), 'early mark in v_decision_clv';

    -- The pre-game mark: its meta replaces the old one, and the row is a closing price.
    perform public.steward_record_decision_mark(jsonb_build_object(
      'steward', 'oddsborne', 'kind', 'close', 'decision_id', v_decision, 'price', 0.47,
      'observed_at', v_start - interval '34 minutes', 'event_start_at', v_start, 'source', 'test',
      'meta', jsonb_build_object('provisional', false, 'minutes_before_start', 34)));
    select meta into v_meta from public.decision_marks where decision_id = v_decision and mark_kind = 'close';
    assert v_meta = '{"provisional": false, "minutes_before_start": 34}'::jsonb, format('meta not replaced: %s', v_meta);
    assert (select clv from public.v_decision_clv where decision_id = v_decision) = 0.47 - 0.40, 'closing mark missing from v_decision_clv';

    -- A pre-game mark with no meta at all clears the flag too.
    perform public.steward_record_decision_mark(jsonb_build_object(
      'steward', 'oddsborne', 'kind', 'close', 'decision_id', v_decision, 'price', 0.48,
      'observed_at', v_start - interval '31 minutes', 'event_start_at', v_start, 'source', 'test'));
    select meta into v_meta from public.decision_marks where decision_id = v_decision and mark_kind = 'close';
    assert v_meta = '{}'::jsonb, format('meta not cleared: %s', v_meta);

    raise exception using errcode = 'P0066', message = 'test 66: roll back';
  exception when sqlstate 'P0066' then
    null;
  end;
  assert not exists (select 1 from public.decision_candidates where source_id = 'test-66-clv-provisional'), 'test row leaked';
end;
$$;
