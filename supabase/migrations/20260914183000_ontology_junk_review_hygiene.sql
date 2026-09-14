-- Audited deny-list reject for pending ontology junk. Same management_actions
-- path as operator reject. Re-runnable via public.reject_junk_ontology_candidates().

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
select token, 'candidate_stopword', 0, 'active', 'Non-ontology review deny-list', now(), now()
from unnest(array[
  'http','https','www','t.co','url','stock','stocks','price','results','popular'
]::text[]) token
on conflict (token, token_type) do nothing;

create or replace function private.ontology_label_is_junk(p_type text, p_label text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    v = ''
    or v ~ '(^| )(http|https|www|t\.co)( |$)'
    or v in ('http', 'https', 'www', 't.co', 'url', 'stock', 'stocks', 'price', 'results', 'popular')
    or exists (
      select 1
      from public.ontology_lexicon l
      where l.status = 'active'
        and l.token_type = 'candidate_stopword'
        and lower(l.token) = v
    )
  from (
    select lower(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g'))) as v
  ) s;
$$;

comment on function private.ontology_label_is_junk(text, text) is
  'True when a candidate label is URL/stopword junk. Keep labels in sync with ONTOLOGY_JUNK_LABELS.';

revoke all on function private.ontology_label_is_junk(text, text) from public, anon;

grant usage on schema private to authenticated, quantanamo_worker;

create or replace function private.reject_junk_ontology_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text;
  v_count integer := 0;
begin
  v_actor := coalesce((select auth.uid())::text, '');
  if v_actor <> '' then
    if not (select private.is_ledger_operator()) then
      raise exception 'not_operator' using errcode = '42501';
    end if;
  elsif session_user not in ('service_role', 'postgres', 'quantanamo_worker', 'supabase_admin') then
    raise exception 'not_operator' using errcode = '42501';
  else
    v_actor := session_user;
  end if;

  with doomed as (
    select c.id, c.candidate_key, to_jsonb(c.*) as previous
    from public.ontology_candidates c
    where c.status = 'pending'
      and private.ontology_label_is_junk(c.candidate_type, c.proposed_label)
  ),
  updated as (
    update public.ontology_candidates c
    set
      status = 'rejected',
      reviewed_at = now(),
      review_note = 'junk_deny_list'
    from doomed d
    where c.id = d.id
    returning c.id, c.candidate_key, to_jsonb(c.*) as next_state, d.previous
  ),
  written as (
    insert into public.ontology_management_actions(
      actor_id, entity_type, entity_key, action, previous_state, next_state, created_at
    )
    select v_actor, 'candidate', u.candidate_key, 'reject', u.previous, u.next_state, now()
    from updated u
    returning id
  )
  select count(*)::integer into v_count from written;

  return jsonb_build_object(
    'ok', true,
    'rejected', v_count,
    'note', 'junk_deny_list'
  );
end;
$$;

revoke all on function private.reject_junk_ontology_candidates() from public, anon;
grant execute on function private.reject_junk_ontology_candidates()
  to authenticated, service_role, quantanamo_worker;

create or replace function public.reject_junk_ontology_candidates()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.reject_junk_ontology_candidates();
$$;

comment on function public.reject_junk_ontology_candidates() is
  'Steward sweep: reject pending ontology_candidates on the documented deny-list. Writes ontology_management_actions. Re-runnable. Anon cannot call this.';

revoke all on function public.reject_junk_ontology_candidates() from public, anon;
grant execute on function public.reject_junk_ontology_candidates()
  to authenticated, service_role, quantanamo_worker;

select private.reject_junk_ontology_candidates();
