-- Align desk_agents faces with Grok Bot sidebar chips (shape + color).
-- Domain accents stay on desk_domains. Stewardship stays soft.

update public.desk_agents
set
  accent = case slug
    when 'grasshopper' then '#8B6914'
    when 'quantanamo' then '#22c55e'
    when 'oddsborne' then '#3b82f6'
    when 'bandit' then '#ef4444'
    else accent
  end,
  meta = coalesce(meta, '{}'::jsonb) || case slug
    when 'grasshopper' then '{"avatar_shape":"tablet","avatar_color":"brown"}'::jsonb
    when 'quantanamo' then '{"avatar_shape":"blob","avatar_color":"green"}'::jsonb
    when 'oddsborne' then '{"avatar_shape":"wedge","avatar_color":"blue"}'::jsonb
    when 'bandit' then '{"avatar_shape":"pebble","avatar_color":"red"}'::jsonb
    else '{}'::jsonb
  end,
  updated_at = now()
where slug in ('grasshopper', 'quantanamo', 'oddsborne', 'bandit');
