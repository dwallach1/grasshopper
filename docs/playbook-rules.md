# Playbook rules — load before size

Desk autopsies already write high-quality `belief_updates` with `meta.kind = 'playbook_rule'`. Those rows are the rules in force. Stewards must read them **before** sizing a new clip. The phone Book shows up to three of those rules on a holding; Theses shows the confidence trail. This file is the write + read contract. Do not invent marks, P/L, or close rows.

## Open with thesis_id

New `position_episodes`, `pm_positions`, and `meme_positions` rows **must** carry `thesis_id` or an explicit `meta.untagged` reason. Beliefs and rules bind by thesis — an untagged lot shows a quiet “untagged” chip and no rules in force. The ontology cannot learn from that money.

```sql
-- Gate (also a CHECK on the three position tables)
select public.position_has_thesis_or_untagged('earnings_gap_structure', '{}'::jsonb);
select public.position_has_thesis_or_untagged(null, '{"untagged":"paper_lot"}'::jsonb);
```

```sql
insert into public.position_episodes (
  account_key, symbol, status, quantity, average_cost, opened_at, thesis_id, meta
) values (
  'agentic-7638',
  'CODA',
  'open',
  250,
  10.10,
  now(),
  'earnings_gap_structure',
  '{}'::jsonb
);

insert into public.pm_positions (
  market_id, account_key, thesis_id, outcome, status, quantity, average_cost, meta
) values (
  $market_id,
  'polymarket-us-primary',
  'weather_same_day_high',
  'yes',
  'open',
  200,
  0.12,
  '{}'::jsonb
);
```

If the clip is intentionally off-thesis, write the reason — do not leave `thesis_id` null:

```sql
meta = jsonb_build_object('untagged', 'paper_lot')
-- or 'sync_missing_thesis' from QUANTANAMO broker sync when no single thesis matches
```

Book LIVE/CLOSED rows show a thesis chip when `thesis_id` is set, and a quiet “untagged” when it is not. Do not infer a thesis from `thesis_symbols` on the Book. QUANTANAMO `sync_position_episodes` keeps an existing `thesis_id`; a brand-new episode without one stamps `meta.untagged = 'sync_missing_thesis'`. Pass `thesis_id` when exactly one thesis lists the symbol.

Conservative backfill (do not extend): `CODA` → `earnings_gap_structure`; `tc-temp-laxhigh-*` PM lots → `weather_same_day_high`. Fed hike, Chicago weather, multi-thesis names (NBIS/CIFR/IREN), and all meme lots stayed untagged. `desk-public-rest` **v7** selects `position_episodes.thesis_id` — that ships with the Edge Function job, not the Worker.

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

## Close with belief / lesson

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

## Incorporate an open lesson

Theses shows open `research_lessons` first. The mast learning pulse counts playbook beliefs in force from the same `beliefs[]` the Book uses. The local operator desk (`bun run web:app`) can mark one incorporated. That path is the same ledger-operator gate as ontology review: `POST /api/lessons/incorporate` → `public.incorporate_research_lesson` (INVOKER) → `private.incorporate_research_lesson` (DEFINER). The public phone is read-only.

```ts
{ "lesson_id": 37 }
```

```sql
select public.incorporate_research_lesson(37);
```

The RPC sets `research_lessons.incorporated = true` and writes one `belief_updates` row with `meta.kind = 'playbook_rule'`, `meta.research_lesson_id`, `meta.source = 'operator_incorporate'`, and `meta.rules = [lesson_type]`. Rationale is the lesson summary. Confidence is left null — do not invent a move. Re-runnable: a second call returns the existing belief (`replayed: true`) and does not insert another. See [`docs/lesson-incorporate.md`](lesson-incorporate.md).
