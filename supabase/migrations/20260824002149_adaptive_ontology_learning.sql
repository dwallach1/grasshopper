create table public.ontology_themes (
  id text primary key,
  thesis_id text unique references public.theses(id) on delete set null,
  kind text not null default 'theme' check (kind in ('theme', 'concept')),
  name text not null,
  description text not null default '',
  status text not null default 'candidate' check (status in ('candidate', 'active', 'merged', 'retired')),
  parent_theme_id text references public.ontology_themes(id) on delete set null,
  merged_into_theme_id text references public.ontology_themes(id) on delete set null,
  match_threshold smallint not null default 35 check (match_threshold between 0 and 100),
  auto_promote_sources smallint not null default 3 check (auto_promote_sources >= 2),
  created_by text not null default 'learning',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (id <> parent_theme_id),
  check (id <> merged_into_theme_id)
);
create index idx_ontology_themes_status_kind on public.ontology_themes(status, kind);
create index idx_ontology_themes_parent on public.ontology_themes(parent_theme_id) where parent_theme_id is not null;
create index idx_ontology_themes_merged_into on public.ontology_themes(merged_into_theme_id) where merged_into_theme_id is not null;

create table public.ontology_terms (
  id bigint generated always as identity primary key,
  theme_id text not null references public.ontology_themes(id) on delete cascade,
  term text not null,
  normalized_term text not null,
  term_type text not null default 'keyword' check (term_type in ('keyword', 'alias', 'phrase', 'entity', 'negative')),
  weight smallint not null default 50 check (weight between 1 and 100),
  status text not null default 'candidate' check (status in ('candidate', 'active', 'rejected')),
  evidence_count bigint not null default 0 check (evidence_count >= 0),
  source_count bigint not null default 0 check (source_count >= 0),
  created_by text not null default 'learning',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (theme_id, normalized_term)
);
create index idx_ontology_terms_normalized_active on public.ontology_terms(normalized_term) where status = 'active';
create index idx_ontology_terms_theme_status on public.ontology_terms(theme_id, status);

create table public.ontology_lexicon (
  token text not null,
  token_type text not null check (token_type in ('ignored_symbol', 'market_keyword', 'market_context', 'candidate_stopword')),
  weight smallint not null default 0 check (weight between 0 and 100),
  status text not null default 'active' check (status in ('active', 'retired')),
  reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (token, token_type)
);
create index idx_ontology_lexicon_type_status on public.ontology_lexicon(token_type, status);

create table public.symbol_theme_memberships (
  symbol text not null references public.symbols(symbol) on delete cascade,
  theme_id text not null references public.ontology_themes(id) on delete cascade,
  relationship text not null default 'member' check (relationship in ('member', 'beneficiary', 'supplier', 'customer', 'competitor', 'proxy')),
  confidence smallint not null default 40 check (confidence between 0 and 100),
  evidence_count bigint not null default 0 check (evidence_count >= 0),
  source_count bigint not null default 0 check (source_count >= 0),
  status text not null default 'candidate' check (status in ('candidate', 'active', 'rejected')),
  learned_by text not null default 'cooccurrence',
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (symbol, theme_id)
);
create index idx_symbol_theme_memberships_theme_status on public.symbol_theme_memberships(theme_id, status, confidence desc);

create table public.ontology_observations (
  source_type text not null,
  source_key text not null,
  feature_type text not null check (feature_type in ('term', 'symbol', 'hashtag')),
  feature_value text not null,
  occurrences smallint not null default 1 check (occurrences > 0),
  observed_at timestamptz not null,
  primary key (source_type, source_key, feature_type, feature_value)
);
create index idx_ontology_observations_feature on public.ontology_observations(feature_type, feature_value, observed_at desc);

create table public.ontology_evidence (
  id bigint generated always as identity primary key,
  source_type text not null,
  source_key text not null,
  theme_id text not null references public.ontology_themes(id) on delete cascade,
  feature_type text not null,
  feature_value text not null,
  match_method text not null check (match_method in ('term', 'symbol', 'cooccurrence', 'manual', 'historical')),
  score smallint not null check (score between 0 and 100),
  observed_at timestamptz not null,
  unique (source_type, source_key, theme_id, feature_type, feature_value, match_method)
);
create index idx_ontology_evidence_theme_date on public.ontology_evidence(theme_id, observed_at desc);
create index idx_ontology_evidence_source on public.ontology_evidence(source_type, source_key);

create table public.ontology_candidates (
  id bigint generated always as identity primary key,
  candidate_type text not null check (candidate_type in ('theme', 'term', 'membership')),
  candidate_key text not null,
  proposed_theme_id text references public.ontology_themes(id) on delete cascade,
  proposed_label text not null,
  proposed_description text not null default '',
  score smallint not null default 0 check (score between 0 and 100),
  evidence_count bigint not null default 0 check (evidence_count >= 0),
  source_count bigint not null default 0 check (source_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'promoted', 'rejected')),
  sample_context jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  reviewed_at timestamptz,
  review_note text,
  unique (candidate_type, candidate_key)
);
create index idx_ontology_candidates_status_score on public.ontology_candidates(status, score desc, source_count desc);
create index idx_ontology_candidates_theme_status on public.ontology_candidates(proposed_theme_id, status) where proposed_theme_id is not null;

create table public.ontology_candidate_evidence (
  candidate_id bigint not null references public.ontology_candidates(id) on delete cascade,
  source_type text not null,
  source_key text not null,
  evidence_score smallint not null check (evidence_score between 0 and 100),
  context jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  primary key (candidate_id, source_type, source_key)
);
create index idx_ontology_candidate_evidence_source on public.ontology_candidate_evidence(source_type, source_key);

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'ontology_themes','ontology_terms','ontology_lexicon','symbol_theme_memberships',
    'ontology_observations','ontology_evidence','ontology_candidates','ontology_candidate_evidence'
  ]
  loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all on table public.%I from anon, authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
    execute format('grant select, insert, update on table public.%I to thesisforge_worker', target_table);
    execute format(
      'create policy thesisforge_worker_select on public.%I for select to thesisforge_worker using (true)',
      target_table
    );
    execute format(
      'create policy thesisforge_worker_insert on public.%I for insert to thesisforge_worker with check (true)',
      target_table
    );
    execute format(
      'create policy thesisforge_worker_update on public.%I for update to thesisforge_worker using (true) with check (true)',
      target_table
    );

    if exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=target_table and column_name='id'
    ) then
      sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
      if sequence_name is not null then
        execute format('grant usage, select, update on sequence %s to thesisforge_worker', sequence_name);
      end if;
    end if;
  end loop;
end $$;
