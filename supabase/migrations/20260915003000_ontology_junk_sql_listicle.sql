-- Widen the ontology deny-list for SQL/schema tokens and listicle headers.
-- Same audited reject path as 20260914183000. Re-runnable via
-- public.reject_junk_ontology_candidates(). Keep labels in sync with
-- ONTOLOGY_JUNK_LABELS / isJunkOntologyLabel.

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
select token, 'candidate_stopword', 0, 'active', 'Non-ontology review deny-list', now(), now()
from unnest(array[
  'http','https','www','t.co','url','stock','stocks','price','results','popular',
  'by','in','from','where','select','order',
  'bigint','smallint','integer','int','varchar',
  'timestamp','timestamptz','date','double','float','numeric',
  'boolean','bool','json','jsonb','uuid','null','true','false',
  'create','drop','alter','insert','update','delete',
  'table','column','schema','sql','postgres',
  'limit','offset','group','having','values','join',
  'arr','pt','cpu','mw','llc',
  'another','files','github',
  'latest','trending','featured','related','headlines',
  'overview','introduction','conclusion','contents'
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
    or v in (
      'http', 'https', 'www', 't.co', 'url',
      'stock', 'stocks', 'price', 'results', 'popular',
      'by', 'in', 'from', 'where', 'select', 'order',
      'bigint', 'smallint', 'integer', 'int', 'varchar',
      'timestamp', 'timestamptz', 'date', 'double', 'float', 'numeric',
      'boolean', 'bool', 'json', 'jsonb', 'uuid', 'null', 'true', 'false',
      'create', 'drop', 'alter', 'insert', 'update', 'delete',
      'table', 'column', 'schema', 'sql', 'postgres',
      'limit', 'offset', 'group', 'having', 'values', 'join',
      'arr', 'pt', 'cpu', 'mw', 'llc',
      'another', 'files', 'github',
      'latest', 'trending', 'featured', 'related', 'headlines',
      'overview', 'introduction', 'conclusion', 'contents'
    )
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
  'True when a candidate label is URL/SQL/listicle/stopword junk. Keep labels in sync with ONTOLOGY_JUNK_LABELS.';

revoke all on function private.ontology_label_is_junk(text, text) from public, anon;

select private.reject_junk_ontology_candidates();
