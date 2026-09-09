-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Covering indexes for advisor-flagged unindexed FKs (INFO). Safe, additive only.
CREATE INDEX IF NOT EXISTS belief_updates_agent_id_idx ON public.belief_updates (agent_id);
CREATE INDEX IF NOT EXISTS belief_updates_domain_id_idx ON public.belief_updates (domain_id);
CREATE INDEX IF NOT EXISTS belief_updates_event_id_idx ON public.belief_updates (event_id);
CREATE INDEX IF NOT EXISTS desk_accounts_domain_id_idx ON public.desk_accounts (domain_id);
CREATE INDEX IF NOT EXISTS desk_domain_stewards_agent_id_idx ON public.desk_domain_stewards (agent_id);
CREATE INDEX IF NOT EXISTS meme_fills_position_id_idx ON public.meme_fills (position_id);
CREATE INDEX IF NOT EXISTS meme_notes_thesis_id_idx ON public.meme_notes (thesis_id);
CREATE INDEX IF NOT EXISTS meme_orders_thesis_id_idx ON public.meme_orders (thesis_id);
CREATE INDEX IF NOT EXISTS meme_positions_thesis_id_idx ON public.meme_positions (thesis_id);
CREATE INDEX IF NOT EXISTS meme_positions_token_id_idx ON public.meme_positions (token_id);
CREATE INDEX IF NOT EXISTS meme_tokens_thesis_id_idx ON public.meme_tokens (thesis_id);
CREATE INDEX IF NOT EXISTS thesis_domains_domain_id_idx ON public.thesis_domains (domain_id);
