# Ontology candidate review

Quantanamo collects `ontology_candidates`. Review decides. The phone is read-only; writes use the existing ledger-operator gate.

## What the desk shows

Theses (parchment) has a **To review** queue: pending candidates, ledger `score` then `source_count`, cap 40. Scores are not invented. Public `/api/desk` includes the same lean pending rows. `ontology_management_actions` stay off the public envelope.

Promote / reject / merge buttons render only on the **local operator desk** (`bun run web:app`). The public Worker never accepts those writes.

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
```

Each call updates `ontology_candidates.status` and inserts one `ontology_management_actions` row (`entity_type = 'candidate'`).

## Theme ↔ thesis

Promote prefers an existing thesis already bound to the proposed theme, or a thesis whose id/name matches the label. `ontology_themes.thesis_id` is unique — a concept such as `photonics` is not forced onto `semis_photonics` if that thesis is already taken. A thin `forming` thesis stub is created only for a **theme** candidate with no match (same pattern as knowledge auto-promote). Merge requires an existing thesis id.

## Public phone

Read-only. `desk-public-rest` `/bundle/public` selects pending candidates (`PUBLIC_KEYS` includes `candidates`). Worker CI deploys Cloudflare only — after a public-key change, also:

```sh
supabase functions deploy desk-public-rest --project-ref xqungxapqicdmboniezz
```

`POST /api/desk` stays 405. Anon cannot execute the review RPC.

## Live path (Quantanamo)

Applied. `desk-public-rest` **v6** includes `candidates` on `/bundle/public` (40 pending, ledger scores). Review RPC verified:

```sql
select public.review_ontology_candidate(23380, 'reject', null, 'live path verify');
-- candidate status=rejected; ontology_management_actions row action=reject

select public.review_ontology_candidate(23381, 'promote', 'neocloud_compute', 'live path verify promote');
-- term attached to neocloud_compute; linked_existing_thesis=true; no thesis stub
```

Phone Worker JS still needs the next `Deploy public desk` so `/api/desk` hydrates `ontology_candidates` instead of `[]`. Edge Function alone is not enough — same lesson as #50/#52.
