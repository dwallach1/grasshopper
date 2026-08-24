alter table public.research_documents
  add column if not exists storage_provider text not null default 'supabase';

alter table public.research_documents
  drop constraint if exists research_documents_storage_provider_check;

alter table public.research_documents
  add constraint research_documents_storage_provider_check
  check (storage_provider in ('supabase','r2'));

comment on column public.research_documents.storage_provider is
  'Immutable object backend: legacy Supabase Storage or Cloudflare R2.';
