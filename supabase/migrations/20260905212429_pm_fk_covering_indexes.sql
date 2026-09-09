-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Covering indexes for pm_* foreign keys (advisor unindexed_foreign_keys)
create index if not exists pm_fills_position_id_idx on public.pm_fills (position_id);
create index if not exists pm_markets_thesis_id_idx on public.pm_markets (thesis_id);
create index if not exists pm_notes_thesis_id_idx on public.pm_notes (thesis_id);
create index if not exists pm_orders_thesis_id_idx on public.pm_orders (thesis_id);
create index if not exists pm_positions_market_id_idx on public.pm_positions (market_id);
create index if not exists pm_positions_thesis_id_idx on public.pm_positions (thesis_id);
