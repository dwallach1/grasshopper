-- Widen the ontology deny-list for discourse fillers and IT/acronym
-- false-ticker memberships (sso, cuda, saml, …). Same audited reject path
-- as 20260914183000 / 20260915003000 / 20260918184500.
-- Re-runnable via public.reject_junk_ontology_candidates().
-- Keep labels in sync with ONTOLOGY_JUNK_LABELS / isJunkOntologyLabel.
-- Ticker mashup regex is the same as TS ONTOLOGY_TICKER_MASHUP_RE:
-- two or more 2–5 letter tokens separated by spaces (`avgo cien`).
-- Not a score. Keepers such as inference, scarcity, neocloud, NVDA stay.

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
select token, 'candidate_stopword', 0, 'active', 'Non-ontology review deny-list', now(), now()
from unnest(array[
  'further','directly','phase','value','moves','collapse','chain','think',
  'right','philip','models','model','earnings','infrastructure','customers',
  'bottle','captcha','saml','sso','scim','php','js','sla','sq','rpm','cof',
  'mcc','msa','blue','mktp','cpto','rag','jdbc','odbc','olap','etl','ast',
  'tpc','adbc','bi','kb','mt','gt','mvcc','cwi','gqa','sota','zdr','ptq',
  'cuda','skhy'
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
    or v ~ '^[a-z]{2,5}( [a-z]{2,5})+$'
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
      'overview', 'introduction', 'conclusion', 'contents',
      'since', 'literally', 'called', 'ultimately', 'next week',
      'names', 'invest', 'leader', 'rallied', 'fastest', 'gonna',
      'provide', 'hours', 'online', 'performers', 'clusters', 'crowded',
      'awaited', 'awaited quarters', 'logo link', 'confirmed', 'exploring',
      'extract', 'brand', 'breaking', 'bucket', 'department', 'cities',
      'further', 'directly', 'phase', 'value', 'moves', 'collapse', 'chain',
      'think', 'right', 'philip', 'models', 'model', 'earnings', 'infrastructure',
      'customers', 'bottle', 'captcha', 'saml', 'sso', 'scim', 'php', 'js',
      'sla', 'sq', 'rpm', 'cof', 'mcc', 'msa', 'blue', 'mktp', 'cpto', 'rag',
      'jdbc', 'odbc', 'olap', 'etl', 'ast', 'tpc', 'adbc', 'bi', 'kb', 'mt',
      'gt', 'mvcc', 'cwi', 'gqa', 'sota', 'zdr', 'ptq', 'cuda', 'skhy'
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
  'True when a candidate label is URL/SQL/listicle/discourse/IT-acronym/ticker-mashup/stopword junk. Keep labels in sync with ONTOLOGY_JUNK_LABELS / isJunkOntologyLabel.';

revoke all on function private.ontology_label_is_junk(text, text) from public, anon;

select private.reject_junk_ontology_candidates();
