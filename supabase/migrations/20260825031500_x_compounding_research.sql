-- Compounding X research sessions seeded by bookmark events.
--
-- Each market-related bookmark spawns one session. The knowledge Worker walks
-- the tweet's conversation (replies), quoted/referenced tweets, and linked
-- articles, then lets the research model choose bounded follow-up hops
-- (more lookups, X searches, URL fetches) until it concludes or exhausts
-- its budget. Findings land here and in thesis_evidence.

create table public.x_research_sessions (
  id bigint generated always as identity primary key,
  bookmark_id text not null unique references public.bookmarks(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending','running','concluded','exhausted','failed')
  ),
  step_count integer not null default 0,
  x_reads_used integer not null default 0,
  article_fetches_used integer not null default 0,
  pending_actions jsonb,
  findings jsonb not null default '[]'::jsonb,
  model text not null,
  prompt_version text not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluded_at timestamptz
);

create index idx_x_research_sessions_status
  on public.x_research_sessions (status, updated_at desc);

create table public.x_research_steps (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.x_research_sessions(id) on delete cascade,
  step_number integer not null,
  executed_actions jsonb not null default '[]'::jsonb,
  observations jsonb not null default '[]'::jsonb,
  ai_output jsonb,
  created_at timestamptz not null default now()
);

create index idx_x_research_steps_session
  on public.x_research_steps (session_id, step_number);

-- Tweets discovered while researching a session (replies, quotes, searches).
create table public.x_research_tweets (
  session_id bigint not null references public.x_research_sessions(id) on delete cascade,
  tweet_id text not null,
  relation text not null check (
    relation in ('reply','referenced','lookup','search','included')
  ),
  author_id text,
  author_username text,
  created_at timestamptz,
  text text,
  like_count integer,
  raw_json jsonb,
  fetched_at timestamptz not null default now(),
  primary key (session_id, tweet_id)
);

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'x_research_sessions','x_research_steps','x_research_tweets'
  ]
  loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all on table public.%I from anon, authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to thesisforge_worker',
      target_table
    );
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
    execute format(
      'create policy thesisforge_worker_delete on public.%I for delete to thesisforge_worker using (true)',
      target_table
    );
    sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
    if sequence_name is not null then
      execute format('grant usage, select on sequence %s to service_role', sequence_name);
      execute format('grant usage, select, update on sequence %s to thesisforge_worker', sequence_name);
    end if;
  end loop;
end $$;
