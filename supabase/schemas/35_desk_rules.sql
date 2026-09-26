-- The rules court (2026-09-26, David: "We should have a Supreme Court pass each one taking into
-- account all derivative effects"). public.desk_rules is the registry of trading rules: one row per
-- rule with its status, verdict and the four opinions' summary. The ruling text is
-- docs/rules/<rule_id>.md; both are generated from tools/court/rules_data.py. Read-only for
-- everyone but service_role / migrations.
-- court-ruling: docs/rules/README.md

create table if not exists public.desk_rules (
  rule_id text primary key check (rule_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null,
  purpose text not null,
  mechanism text not null,
  owner_paths text[] not null default '{}',
  status text not null check (status in ('in_force', 'repealed', 'proposed')),
  verdict text not null check (verdict in ('uphold', 'amend', 'strike')),
  ruling_summary text not null,
  growth_cost text,
  ruin_risk_reduction text,
  statistics_note text,
  gaming_analysis text,
  interactions text,
  needs_david boolean not null default false,
  ruling_file text not null check (ruling_file ~ '^docs/rules/[a-z0-9-]+\.md$'),
  ruling_date date not null,
  next_review_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.desk_rules is
  'Rules court registry: every trading rule with status (in_force | repealed | proposed), verdict and ruling (docs/rules/<rule_id>.md). Generated from tools/court/rules_data.py.';

alter table public.desk_rules enable row level security;
grant select on public.desk_rules to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
grant select, insert, update, delete on public.desk_rules to service_role;

drop policy if exists desk_rules_read on public.desk_rules;
create policy desk_rules_read on public.desk_rules
  for select to desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker
  using (true);
drop policy if exists ledger_operator_select on public.desk_rules;
create policy ledger_operator_select on public.desk_rules
  for select to authenticated using ((select public.is_ledger_operator()));
