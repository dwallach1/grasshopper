# Ontology candidate review

Quantanamo collects `ontology_candidates`. Review decides. The phone is read-only; writes use the existing ledger-operator gate.

## What the desk shows

Theses (parchment) has a **To review** queue: pending candidates, **membership** (and theme rows already bound to a theme id) before raw `term` noise, then ledger `score` then `source_count`, cap 40. Scores are not invented. Deny-list junk is omitted even if it is still `pending`. Fetch is pending (public) with membership-first SQL order and **no** `source_count >= 2` gate — most live memberships are `source_count=1` and would never enter a 200-row score window otherwise. Ranking + the junk deny-list still quality-filter. Public `/api/desk` ranks the same way. `ontology_management_actions` stay off the public envelope.

Promote / reject / merge buttons render only on the **local operator desk** (`bun run web:app`). The public Worker never accepts those writes.

Memberships on unlinked concept themes (`photonics`, `neocloud`, `nuclear`, `ai_power`, …) get a calm parchment hint when the stable alias map already points at a live thesis. Promote still uses `review_ontology_candidate` rules — it does not invent a thesis for junk.

## Deny-list (safe auto-reject)

Obvious non-ontology labels are rejected through the same audited path as a manual reject: `ontology_candidates.status = rejected` plus one `ontology_management_actions` row (`action = reject`, `review_note = junk_deny_list`).

Normalized label (lowercase, collapsed space) is junk when:

- it is empty
- it contains a URL token: `http`, `https`, `www`, `t.co` (so `https t.co` matches)
- it is one of: `url`, `stock`, `stocks`, `price`, `results`, `popular`
- it is a SQL/schema token as the **whole** label: `select`, `bigint`, `varchar`, `timestamp`, `in`, `by`, `order`, `pt`, `arr`, `cpu`, `mw`, `llc`, …
- it is a listicle/section header as the **whole** label: `another`, `files`, `github`, `latest`, `contents`, …
- it is a discourse filler / non-vocab phrase as the **whole** label: `since`, `literally`, `next week`, `logo link`, `awaited quarters`, …
- it is two or more 2–5 letter tokens separated by spaces (`avgo cien`, `iren mrvl`) — ticker mashups, same regex as TS `isJunkOntologyLabel`. Not a score.
- it is an active `ontology_lexicon.candidate_stopword` as the **whole** label (`about`, `this`, …)

This is **not** a new score. `power`, `demand`, `energy`, `photonics`, `nuclear`, `inference`, `scarcity`, `neocloud` stay for a human — they are ontology vocabulary (and valid theme names), just ranked below memberships. Whole-label SQL/listicle/discourse stopwords still reject even when grind proposed them as memberships.

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

Promote prefers an existing thesis already bound to the proposed theme (`ontology_themes.thesis_id`), then a thesis whose id/name matches the label. Unlinked concept themes resolve through a **stable alias map** (`private.ontology_theme_thesis_alias`, same pairs as the parchment hint / operator promote suggestion):

| Concept theme | Live thesis |
| --- | --- |
| `neocloud` | `neocloud_compute` |
| `nuclear` | `ai_power_nuclear` |
| `ai_power` | `ai_power_nuclear` |
| `photonics` | `semis_photonics` |
| `crypto_ai` | `crypto` |
| `earnings_events` | `earnings_gap_structure` |
| `ipo_events` | *(none — skip / leave for a human)* |

`thesis_id` is unique on themes, so the concept is **not** bound to the sibling thesis. A promote of `neocloud:SNDK` still writes membership on `neocloud` and returns `thesis_id = neocloud_compute` when that thesis exists. A thin `forming` thesis stub is created only for a **theme** candidate with no match (same pattern as knowledge auto-promote). Merge requires an existing thesis id. Do not invent theses for junk clusters (`Another`, `Files`, `Github`).

## Public phone

Read-only. `desk-public-rest` `/bundle/public` selects pending candidates (`PUBLIC_KEYS` includes `candidates`, fetch 200 ordered `candidate_type.asc,score.desc,source_count.desc,id.desc`, then rank to 40). No `source_count=gte.2` on that fetch. Worker deploy ≠ Edge Function deploy. CI deploys `desk-public-rest` when `supabase/functions/desk-public-rest/**` changes (or `workflow_dispatch`), with `verify_jwt=false`. Manual fallback:

```sh
supabase functions deploy desk-public-rest --project-ref xqungxapqicdmboniezz --no-verify-jwt
```

`POST /api/desk` stays 405. Anon cannot execute the review RPC or the junk sweep.

## Live path (Quantanamo)

Applied. `desk-public-rest` **v11** (2026-09-15) fetches pending candidates without `source_count=gte.2`, ordered membership-first. **v6** first included `candidates` on `/bundle/public`. Review RPC verified in #53. SQL/listicle deny-list (`ontology_junk_sql_listicle`, 2026-09-15) is on Quantanamo `xqungxapqicdmboniezz`. Discourse-filler + ticker-mashup deny-list (`ontology_junk_discourse`, 2026-09-18) is applied: first mashup sweep rejected **35** pending rows (`avgo cien`, `iren mrvl`, `cien amba`, and other 2–5 letter space-joined pairs). Re-run is idempotent (`rejected: 0`). Pending keepers still include `NVDA` / `DOCN` memberships and `power` / `demand` / `energy` / `photonics` / `inference` / `scarcity` / `neocloud` terms. `nuclear` is not on the deny-list (theme name stays valid); grind already rejected lone `nuclear` / `NUCLEAR` memberships.

```sql
select public.reject_junk_ontology_candidates();
-- { ok: true, rejected: 0, note: 'junk_deny_list' }
```
