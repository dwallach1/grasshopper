alter table public.bookmarks
  add column classification_model text,
  add column classification_prompt_version text,
  add column classification_output jsonb,
  add column classified_at timestamptz;

alter table public.bookmarks
  add constraint bookmarks_classification_complete_check
  check (
    (classification_model is null and classification_prompt_version is null and classification_output is null and classified_at is null)
    or
    (classification_model is not null and classification_prompt_version is not null and classification_output is not null and classified_at is not null)
  );

alter table public.ontology_evidence
  drop constraint ontology_evidence_match_method_check;

alter table public.ontology_evidence
  add constraint ontology_evidence_match_method_check
  check (match_method in ('term', 'symbol', 'cooccurrence', 'manual', 'historical', 'llm'));
