# Ontology candidate review

Quantanamo collects `ontology_candidates`. Review decides. The phone is read-only; writes use the existing ledger-operator gate.

## What the desk shows

Theses (parchment) has a **To review** queue: pending candidates, **membership** (and theme rows already bound to a theme id) before raw `term` noise, then ledger `score` then `source_count`, cap 40. Scores are not invented. Deny-list junk is omitted even if it is still `pending`. Public `/api/desk` ranks the same way. `ontology_management_actions` stay off the public envelope.

Promote / reject / merge buttons render only on the **local operator desk** (`bun run web:app`). The public Worker never accepts those writes.

Memberships on unlinked concept themes (`photonics`, `neocloud`, `nuclear`, `ai_power`, …) get a calm parchment hint when they already fit a live thesis. Promote still uses `review_ontology_candidate` rules — it does not invent a thesis for junk.

## Deny-list (safe auto-reject)

Obvious non-ontology labels are rejected through the same audited path as a manual reject: `ontology_candidates.status = rejected` plus one `ontology_management_actions` row (`action = reject`, `review_note = junk_deny_list`).

Normalized label (lowercase, collapsed space) is junk when:

- it is empty
- it contains a URL token: `http`, `https`, `www`, `t.co` (so `https t.co` matches)
- it is one of: `url`, `stock`, `stocks`, `price`, `results`, `popular`
- it is an active `ontology_lexicon.candidate_stopword` as the **whole** label (`about`, `this`, …)

This is **not** a new score. `power`, `demand`, `energy`, `photonics` stay for a human — they are ontology vocabulary, just ranked below memberships.

Steward sweep (operator JWT, `service_role`, `postgres`, or `quantanamo_worker`):

```sql
select public.reject_junk_ontology_candidates();
-- { ok: true, rejected: N, note: 'junk_deny_list' }
```

Re-runnable. Idempotent. The migration applies it once. GRASSHOPPER can call the same RPC after ingest.

## Write path

Signed-in operator → `POST /api/ontology/review` → `public.review_ontology_candidate` (INVOKER) → `private.review_ontology_candidate` (DEFINER).

```ts
// body
{ "candidate_id": 4667, "action": "promote" | "reject" | "merge", "thesis_id": "semis_photonics" }
```

SQL (service role or a ledger operator JWT):

```sql
select public.review_ontology_candidate(4667, 'promote', 'semis_photonics', null);
select public.review_ontology_candidate(1947, 'reject', null, 'noise cluster');
select public.review_ontology_candidate(1931, 'merge', 'semis_photonics', null);
select public.reject_junk_ontology_candidates();
```

Each review call updates `ontology_candidates.status` and inserts one `ontology_management_actions` row (`entity_type = 'candidate'`). The junk sweep does the same in bulk.

## Theme ↔ thesis

Promote prefers an existing thesis already bound to the proposed theme, or a thesis whose id/name matches the label. Unlinked concepts also nudge toward a live thesis whose id contains the concept (`photonics` → `semis_photonics`, `neocloud` → `neocloud_compute`) or whose name contains the concept name. `ontology_themes.thesis_id` is unique — a concept such as `photonics` is not forced onto `semis_photonics` if that thesis is already taken. A thin `forming` thesis stub is created only for a **theme** candidate with no match (same pattern as knowledge auto-promote). Merge requires an existing thesis id. Do not invent theses for junk clusters (`Another`, `Files`, `Github`).

## Public phone

Read-only. `desk-public-rest` `/bundle/public` selects pending candidates (`PUBLIC_KEYS` includes `candidates`, fetch 200 then rank to 40). Worker deploy ≠ Edge Function deploy. CI deploys `desk-public-rest` when `supabase/functions/desk-public-rest/**` changes (or `workflow_dispatch`), with `verify_jwt=false`. Manual fallback:

```sh
supabase functions deploy desk-public-rest --project-ref xqungxapqicdmboniezz --no-verify-jwt
```

`POST /api/desk` stays 405. Anon cannot execute the review RPC or the junk sweep.

## Live path (Quantanamo)

Applied. `desk-public-rest` **v6** includes `candidates` on `/bundle/public`. This change keeps `candidates` and only widens the pending fetch to 200 so ranking can put real memberships first — **redeploy the Edge Function**. Review RPC verified in #53. Junk sweep:

```sql
select public.reject_junk_ontology_candidates();
```
