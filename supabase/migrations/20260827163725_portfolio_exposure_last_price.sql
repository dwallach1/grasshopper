-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Applied out of band; SQL is the hosted statements, not invented.

ALTER TABLE public.portfolio_exposure
  ADD COLUMN IF NOT EXISTS last_price numeric;

COMMENT ON COLUMN public.portfolio_exposure.last_price IS
  'Broker last mark at observed_at. Nullable; desk must not invent P/L when null.';
