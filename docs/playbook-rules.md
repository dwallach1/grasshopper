# Playbook rules — load before size

Desk autopsies already write high-quality `belief_updates` with `meta.kind = 'playbook_rule'`. Those rows are the rules in force. Stewards must read them **before** sizing a new clip. The phone Book shows up to three of those rules on a holding; Theses shows the confidence trail. This file is the write + read contract. Do not invent marks, P/L, or close rows.

## Read before size

Newest playbook rule per thesis + domain:

```sql
select thesis_id, domain_slug, steward, rules, prior_confidence, new_confidence, observed_at
from public.active_playbook_rules;
```

One thesis or domain (slug or uuid):

```sql
select * from public.active_playbook_rules('earnings_gap_structure');
select * from public.active_playbook_rules('prediction');
```

Same filter as an RPC: `POST /rest/v1/rpc/active_playbook_rules` with `{ "p_domain_or_thesis": "earnings_gap_structure" }`.

Documented select if the view is not applied yet:

```sql
select distinct on (thesis_id, domain_id)
  id, thesis_id, domain_id, prior_confidence, new_confidence, rationale, observed_at,
  meta->'rules' as rules, meta->>'steward' as steward
from public.belief_updates
where meta->>'kind' = 'playbook_rule'
order by thesis_id, domain_id, observed_at desc, created_at desc, id desc;
```

`/api/desk` includes a lean `beliefs[]` (id, thesis, domain, confidences, rationale, observed_at, kind, rules, steward). Newest-first, cap 80. Public snapshot keeps this field. Do not size from BIDNESS chat.

## Write on close

When an equity episode, `pm_positions`, or `meme_positions` row goes closed / settled / resolved, the steward **must** write one of:

1. `belief_updates` with `meta.kind = 'playbook_rule'` (preferred when the clip changes a rule), or
2. `research_lessons` linked by `thesis_id`.

The desk will show a linked lesson, else the newest belief, else a quiet “no lesson on close”. This PR does not invent those rows.

```sql
insert into public.belief_updates (
  thesis_id, domain_id, agent_id, prior_confidence, new_confidence, rationale, meta
) values (
  'weather_same_day_high',
  (select id from public.desk_domains where slug = 'prediction'),
  (select id from public.desk_agents where slug = 'oddsborne'),
  72,
  78,
  'Kill into a no-bid close. Ledger the residual immediately.',
  jsonb_build_object(
    'kind', 'playbook_rule',
    'steward', 'oddsborne',
    'rules', jsonb_build_array('kill_into_no_bid_close_ledger_immediately'),
    'ticket', 'tc-temp-laxhigh-2026-09-10-gte87lt88f'
  )
);
```

`meta.rules` is a jsonb string array of ledger slugs (snake_case). Optional `research_lesson_id` links a close to an existing lesson. QUANTANAMO, ODDSBORNE, and BANDIT worker roles may INSERT. `desk_public_reader` is SELECT only.
