-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Safe defaults so writers omitting created_at/updated_at do not fail NOT NULL
ALTER TABLE public.thesis_evidence
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE public.catalysts
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE public.research_events
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.theses
  ALTER COLUMN created_at SET DEFAULT now();
