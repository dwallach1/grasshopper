# Listed-equity registry exempts real tickers from the ontology junk filter

`rule_id: listed-equity-registry` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Real tickers (TXN, GFS, MP) aren't discarded as junk words.

## Mechanism
`public.listed_equities`, checked by `private.ontology_label_is_junk` / `isJunkOntologyLabel`.

Code paths:
- `supabase/schemas/26_listed_equities.sql`

## The court

**GROWTH.** Unblocked 35 tickers and 58 candidates.

**RUIN.** None.

**STATISTICS.** n/a.

**INCENTIVES / GAMING.** Only verified listings are added.

## Evidence
2026-09-26 sweep: 35 tickers, 58 candidates restored.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| Negative (helps). | None. |

## Interactions
None.
