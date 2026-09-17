# Lesson incorporate

Daily `research_lessons` stay open until an operator writes them into the playbook stewards already load. The phone is read-only; writes use the existing ledger-operator gate.

## What the desk shows

Theses (parchment) has a **Lessons** list: open rows first, then in-playbook, newest within each group, cap 40. Each card is the lesson once — thesis name, `lesson_type`, regime, summary. The Theses mast shows a quiet **learning pulse** counted from the same `/api/desk` arrays (To-review queue, open vs incorporated lessons, playbook beliefs in force, tagged open books). Queue headers do not repeat those counts. Book CLOSED still shows the clip-linked lesson on the lot; it does not repeat this queue.

Incorporate renders only on the **local operator desk** (`bun run web:app`). The public Worker never accepts those writes.

## Write path

Signed-in operator → `POST /api/lessons/incorporate` → `public.incorporate_research_lesson` (INVOKER) → `private.incorporate_research_lesson` (DEFINER).

```ts
{ "lesson_id": 37 }
```

```sql
select public.incorporate_research_lesson(37);
```

Each call:

1. Sets `research_lessons.incorporated = true`
2. Inserts `belief_updates` with `meta.kind = 'playbook_rule'` when no playbook row already cites this lesson
3. Returns the existing belief when one already exists (`replayed: true`)

`meta.rules` is the ledger `lesson_type` slug (`structure`, `missed_swing`, …). Rationale is the lesson summary. Prior/new confidence stay null. `meta.source = 'operator_incorporate'` plus `actor_id` is the audit — same playbook table as #50, not a second actions ledger.

`active_playbook_rules` then surfaces the newest playbook row per thesis + domain. Stewards load that before size.

## Public phone

Read-only. `desk-public-rest` `/bundle/public` already selects `lessons` (`PUBLIC_KEYS` includes `lessons`). The pulse also needs `beliefs`, `candidates`, `positions`, and the nested pm/meme position bags — those keys are already on `/bundle/public`. Worker deploy ≠ Edge Function deploy. This change does not need a function redeploy unless those keys are missing on a stale function.

`POST /api/desk` stays 405. Anon cannot execute the incorporate RPC.

## Live path (Quantanamo)

Applied. `public.incorporate_research_lesson` is INVOKER over `private.incorporate_research_lesson` (DEFINER). Unique index `belief_updates_playbook_lesson_idx` keeps one playbook row per lesson. Anon execute is revoked. Missing lesson raises `lesson_not_found`. Do not incorporate from the phone.
