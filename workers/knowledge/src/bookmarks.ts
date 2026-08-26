import { z } from 'zod';

import type { Database } from './database';
import {
  INVESTIGATION_AI_MODEL,
  INVESTIGATION_PROMPT_VERSION,
  type InvestigatedBookmark,
} from './claim-investigation';
import {
  MAX_ONTOLOGY_BOOKMARKS_PER_SYNC,
  ONTOLOGY_AI_MODEL,
  ONTOLOGY_PROMPT_VERSION,
  type ClassifiedBookmark,
} from './ontology-analysis';
import { normalizePhrase, slugify, type OntologyCatalog, type ThemeMatch } from './ontology';
import type { JsonObject } from '@thesisforge/shared/json';

const XNamedRefSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

export const XContextAnnotationSchema = z.object({
  domain: XNamedRefSchema.optional(),
  entity: XNamedRefSchema.optional(),
}).passthrough();

const XUrlEntitySchema = z.object({
  url: z.string().optional(),
  expanded_url: z.string().optional(),
  display_url: z.string().optional(),
}).passthrough();

/** Subset of an X tweet payload used for bookmark ingestion. */
export const XApiTweetSchema = z.object({
  id: z.string().min(1),
  author_id: z.string().optional(),
  created_at: z.string().optional(),
  text: z.string().optional(),
  entities: z.object({
    urls: z.array(XUrlEntitySchema).optional(),
  }).passthrough().optional(),
  context_annotations: z.array(XContextAnnotationSchema).optional(),
}).passthrough();

export const XBookmarkSchema = XApiTweetSchema.extend({
  raw_json: z.string().optional(),
});

export const XBookmarkPayloadSchema = z.object({
  fetchedAt: z.string().min(1),
  user: z.object({ id: z.string().min(1) }),
  bookmarks: z.array(XBookmarkSchema),
});

export type XContextAnnotation = z.infer<typeof XContextAnnotationSchema>;
export type XBookmark = z.infer<typeof XBookmarkSchema>;
export type XBookmarkPayload = z.infer<typeof XBookmarkPayloadSchema>;

export function bookmarkRawJson(bookmark: XBookmark): unknown {
  if (!bookmark.raw_json) return bookmark;
  try {
    return JSON.parse(bookmark.raw_json) as unknown;
  } catch {
    return bookmark;
  }
}

export function bookmarkFromUnknown(value: unknown): XBookmark | null {
  const parsed = XApiTweetSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    raw_json: JSON.stringify(value),
  };
}

type CandidateInput = {
  candidate_type: string;
  candidate_key: string;
  proposed_theme_id: string | null;
  proposed_label: string;
  description: string;
  score: number;
  context: JsonObject;
  source_type: string;
  source_key: string;
  observed_at: string;
};

export async function bookmarksNeedingAi(
  database: Database,
  payload: XBookmarkPayload,
): Promise<XBookmark[]> {
  const unique = new Map<string, XBookmark>();
  for (const bookmark of payload.bookmarks) {
    if (bookmark.id.length > 0) unique.set(bookmark.id, bookmark);
  }
  const rows = [...unique.values()].map((bookmark, ordinal) => ({
    id: bookmark.id,
    text: bookmark.text?.slice(0, 2_000) ?? '',
    ordinal,
  }));
  if (!rows.length) return [];
  const pending = await database.query<{ id: string }>(`
    select incoming.id
    from jsonb_to_recordset($1::jsonb) as incoming(id text, text text, ordinal integer)
    left join bookmarks b on b.id=incoming.id
    where b.id is null
       or b.text<>incoming.text
       or b.classification_prompt_version is distinct from $2
       or b.classification_model is distinct from $3
    order by incoming.ordinal
    limit $4
  `, [JSON.stringify(rows), ONTOLOGY_PROMPT_VERSION, ONTOLOGY_AI_MODEL, MAX_ONTOLOGY_BOOKMARKS_PER_SYNC]);
  return pending.flatMap((row) => {
    const bookmark = unique.get(row.id);
    return bookmark ? [bookmark] : [];
  });
}

/** Rebuild classified rows that still need a claim investigation packet. */
export async function classifiedNeedingInvestigation(
  database: Database,
  limit = 8,
): Promise<ClassifiedBookmark[]> {
  const rows = await database.query<{
    id: string;
    text: string;
    created_at: string | null;
    fetched_at: string;
    raw_json: unknown;
    market_score: number;
    classification_output: unknown;
  }>(`
    select b.id, b.text, b.created_at::text, b.fetched_at::text, b.raw_json,
           b.market_score, b.classification_output
    from bookmarks b
    where b.is_market_related
      and b.classification_output is not null
      and b.classification_prompt_version = $1
      and (
        b.investigation_prompt_version is distinct from $2
        or b.investigation_model is distinct from $3
        or b.investigation_output is null
      )
      and coalesce((b.classification_output->>'claim_type'), 'none') <> 'none'
      and coalesce((b.classification_output->>'claim_confidence')::integer, 0) >= 50
    order by b.classified_at desc nulls last, b.fetched_at desc
    limit $4
  `, [ONTOLOGY_PROMPT_VERSION, INVESTIGATION_PROMPT_VERSION, INVESTIGATION_AI_MODEL, limit]);

  return rows.flatMap((row) => {
    const analysis = row.classification_output;
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return [];
    const record = analysis as Record<string, unknown>;
    const claimType = typeof record.claim_type === 'string' ? record.claim_type : 'none';
    if (claimType === 'none') return [];
    const claimConfidence = Number(record.claim_confidence);
    if (!Number.isFinite(claimConfidence) || claimConfidence < 50) return [];
    const symbols = Array.isArray(record.symbols)
      ? record.symbols.filter((value): value is string => typeof value === 'string')
      : [];
    const bookmark = bookmarkFromUnknown(row.raw_json) ?? {
      id: row.id,
      text: row.text,
    };
    return [{
      bookmark,
      createdAt: row.created_at ?? row.fetched_at,
      text: row.text,
      symbols,
      marketScore: Number(row.market_score),
      claim: {
        type: claimType,
        summary: typeof record.claim_summary === 'string' ? record.claim_summary : '',
        confidence: claimConfidence,
        evidenceExcerpt: typeof record.claim_evidence_excerpt === 'string'
          ? record.claim_evidence_excerpt
          : '',
      },
      matches: [],
      candidates: [],
      classificationOutput: analysis as ClassifiedBookmark['classificationOutput'],
    }];
  });
}

async function syncThemeTheses(database: Database): Promise<void> {
  await database.execute(`
    insert into theses(id, name, summary, status, confidence, time_horizon, created_at, updated_at)
    select coalesce(thesis_id, id), name, description, 'forming', 40, 'days_to_weeks', now(), now()
    from ontology_themes
    where status='active' and kind='theme'
    on conflict(id) do nothing
  `);
  await database.execute(`
    update ontology_themes set thesis_id=id, updated_at=now()
    where status='active' and kind='theme' and thesis_id is null
  `);
}

async function clearPriorAiClassification(database: Database, classified: ClassifiedBookmark[]): Promise<string[]> {
  const bookmarkIds = classified.map((item) => item.bookmark.id);
  if (!bookmarkIds.length) return [];
  const oldSymbols = await database.query<{ symbol: string }>(
    'delete from bookmark_symbols where bookmark_id=any($1::text[]) returning symbol',
    [bookmarkIds],
  );
  await database.execute("delete from claims where bookmark_id=any($1::text[])", [bookmarkIds]);
  await database.execute("delete from ontology_evidence where source_type='bookmark' and source_key=any($1::text[]) and match_method='llm'", [bookmarkIds]);
  await database.execute("delete from ontology_observations where source_type='bookmark' and source_key=any($1::text[])", [bookmarkIds]);
  await database.execute(`
    delete from ontology_candidate_evidence
    where source_type='bookmark' and source_key=any($1::text[])
  `, [bookmarkIds]);
  await database.execute(`
    delete from thesis_evidence
    where bookmark_id=any($1::text[]) and evidence_type in ('x_bookmark_llm', 'x_claim_investigation')
  `, [bookmarkIds]);
  return oldSymbols.map((row) => row.symbol);
}

async function recountSymbols(database: Database, symbols: string[]): Promise<void> {
  const unique = [...new Set(symbols)];
  if (!unique.length) return;
  await database.execute(`
    update symbols s set
      mention_count=(select count(*) from bookmark_symbols bs where bs.symbol=s.symbol),
      source_count=(select count(*) from bookmark_symbols bs where bs.symbol=s.symbol)
    where s.symbol=any($1::text[])
  `, [unique]);
}

/** Coerce AI / JS numerics into a Postgres smallint-safe integer (0–100). */
export function asSmallint(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`Invalid smallint ${field}: ${String(value)}`);
  }
  return n;
}

/** Claim rows for jsonb_to_recordset insert — confidence always a finite int. */
export function claimRowsForPersist(classified: ClassifiedBookmark[]): Array<{
  bookmark_id: string;
  claim_text: string;
  claim_type: string;
  confidence: number;
}> {
  return classified
    .filter((item) => item.marketScore >= 35 && item.claim)
    .map((item) => ({
      bookmark_id: item.bookmark.id,
      claim_text: item.claim!.summary,
      claim_type: item.claim!.type,
      confidence: asSmallint(item.claim!.confidence, 'claim.confidence'),
    }));
}

async function persistCoreRows(
  database: Database,
  payload: XBookmarkPayload,
  classified: ClassifiedBookmark[],
  investigations: Map<string, InvestigatedBookmark>,
): Promise<number> {
  const run = await database.query<{ id: string }>(
    "insert into runs(run_type, started_at, notes) values ('bookmark_ingest', now(), null) returning id",
  );
  const bookmarkRows = classified.map((item) => {
    const investigated = investigations.get(item.bookmark.id);
    return {
      id: item.bookmark.id,
      author_id: item.bookmark.author_id ?? null,
      created_at: item.createdAt,
      fetched_at: payload.fetchedAt,
      text: item.text,
      raw_json: bookmarkRawJson(item.bookmark),
      market_score: asSmallint(item.marketScore, 'market_score'),
      is_market_related: item.marketScore >= 35,
      classification_model: ONTOLOGY_AI_MODEL,
      classification_prompt_version: ONTOLOGY_PROMPT_VERSION,
      classification_output: item.classificationOutput,
      classified_at: payload.fetchedAt,
      investigation_model: investigated?.model ?? null,
      investigation_prompt_version: investigated?.promptVersion ?? null,
      investigation_output: investigated?.investigation ?? null,
      investigated_at: investigated ? payload.fetchedAt : null,
    };
  });
  await database.execute(`
    insert into bookmarks(
      id, author_id, created_at, fetched_at, text, raw_json, market_score, is_market_related,
      classification_model, classification_prompt_version, classification_output, classified_at,
      investigation_model, investigation_prompt_version, investigation_output, investigated_at
    )
    select id, author_id, created_at, fetched_at, text, raw_json, market_score::smallint, is_market_related,
           classification_model, classification_prompt_version, classification_output, classified_at,
           investigation_model, investigation_prompt_version, investigation_output, investigated_at
    from jsonb_to_recordset($1::jsonb) as x(
      id text, author_id text, created_at timestamptz, fetched_at timestamptz,
      text text, raw_json jsonb, market_score text, is_market_related boolean,
      classification_model text, classification_prompt_version text,
      classification_output jsonb, classified_at timestamptz,
      investigation_model text, investigation_prompt_version text,
      investigation_output jsonb, investigated_at timestamptz
    )
    on conflict(id) do update set
      fetched_at=excluded.fetched_at, text=excluded.text, raw_json=excluded.raw_json,
      market_score=excluded.market_score, is_market_related=excluded.is_market_related,
      classification_model=excluded.classification_model,
      classification_prompt_version=excluded.classification_prompt_version,
      classification_output=excluded.classification_output,
      classified_at=excluded.classified_at,
      investigation_model=excluded.investigation_model,
      investigation_prompt_version=excluded.investigation_prompt_version,
      investigation_output=excluded.investigation_output,
      investigated_at=excluded.investigated_at
  `, [JSON.stringify(bookmarkRows)]);

  const urlMap = new Map<string, { bookmark_id: string; url: string; expanded_url: string | null; display_url: string | null }>();
  for (const item of classified) for (const url of item.bookmark.entities?.urls || []) {
    if (!url.url) continue;
    const row = {
      bookmark_id: item.bookmark.id,
      url: url.url,
      expanded_url: url.expanded_url ?? null,
      display_url: url.display_url ?? null,
    };
    urlMap.set(`${row.bookmark_id}\u0000${row.url}`, row);
  }
  const urls = [...urlMap.values()];
  if (urls.length > 0) {
    await database.execute(`
      insert into bookmark_urls(bookmark_id, url, expanded_url, display_url)
      select bookmark_id, url, expanded_url, display_url
      from jsonb_to_recordset($1::jsonb) as x(bookmark_id text, url text, expanded_url text, display_url text)
      on conflict(bookmark_id, url) do update set
        expanded_url=excluded.expanded_url, display_url=excluded.display_url
    `, [JSON.stringify(urls)]);
  }

  const symbolRows = classified.flatMap((item) => item.symbols.map((symbol) => ({
    bookmark_id: item.bookmark.id,
    symbol,
    seen_at: item.createdAt,
  })));
  if (symbolRows.length > 0) {
    await database.execute(`
      insert into symbols(symbol, first_seen_at, last_seen_at, mention_count, source_count, status)
      select symbol, min(seen_at), max(seen_at), 0, 0, 'candidate'
      from jsonb_to_recordset($1::jsonb) as x(bookmark_id text, symbol text, seen_at timestamptz)
      group by symbol
      on conflict(symbol) do update set last_seen_at=greatest(symbols.last_seen_at, excluded.last_seen_at)
    `, [JSON.stringify(symbolRows)]);
    await database.execute(`
      with incoming as (
        select * from jsonb_to_recordset($1::jsonb)
          as x(bookmark_id text, symbol text, seen_at timestamptz)
      )
        insert into bookmark_symbols(bookmark_id, symbol, source)
        select bookmark_id, symbol, 'llm_semantic' from incoming
        on conflict(bookmark_id, symbol) do nothing
    `, [JSON.stringify(symbolRows)]);
  }

  const claims = claimRowsForPersist(classified);
  if (claims.length > 0) {
    await database.execute(`
      insert into claims(bookmark_id, claim_text, claim_type, created_at, confidence)
      select x.bookmark_id, x.claim_text, x.claim_type, now(), x.confidence::smallint
      from jsonb_to_recordset($1::jsonb)
        as x(bookmark_id text, claim_text text, claim_type text, confidence text)
      where not exists (
        select 1 from claims c where c.bookmark_id=x.bookmark_id and c.claim_type=x.claim_type
      )
    `, [JSON.stringify(claims)]);
  }
  return Number(run[0].id);
}

async function persistOntologyEvidence(
  database: Database,
  classified: ClassifiedBookmark[],
  catalog: OntologyCatalog,
): Promise<void> {
  const observations = classified.flatMap((item) => [
    ...item.symbols.map((symbol) => ({ source_type: 'bookmark', source_key: item.bookmark.id, feature_type: 'symbol', feature_value: symbol, observed_at: item.createdAt })),
    ...item.candidates
      .filter((candidate) => candidate.candidateType === 'term' || candidate.candidateType === 'theme')
      .map((candidate) => ({
        source_type: 'bookmark', source_key: item.bookmark.id, feature_type: 'term',
        feature_value: normalizePhrase(candidate.label), observed_at: item.createdAt,
      })),
  ]);
  if (observations.length > 0) {
    await database.execute(`
      insert into ontology_observations(source_type, source_key, feature_type, feature_value, occurrences, observed_at)
      select source_type, source_key, feature_type, feature_value, 1, observed_at
      from jsonb_to_recordset($1::jsonb)
        as x(source_type text, source_key text, feature_type text, feature_value text, observed_at timestamptz)
      on conflict(source_type, source_key, feature_type, feature_value) do update set
        occurrences=greatest(ontology_observations.occurrences, excluded.occurrences),
        observed_at=excluded.observed_at
    `, [JSON.stringify(observations)]);
  }

  const evidence = classified.flatMap((item) => item.matches.map((match) => ({
    source_type: 'bookmark',
    source_key: item.bookmark.id,
    theme_id: match.theme.id,
    feature_type: 'llm_evidence',
    feature_value: match.evidenceExcerpt,
    match_method: 'llm',
    score: match.score,
    observed_at: item.createdAt,
  })));
  if (evidence.length > 0) {
    await database.execute(`
      insert into ontology_evidence(source_type, source_key, theme_id, feature_type, feature_value, match_method, score, observed_at)
      select source_type, source_key, theme_id, feature_type, feature_value, match_method, score::smallint, observed_at
      from jsonb_to_recordset($1::jsonb) as x(
        source_type text, source_key text, theme_id text, feature_type text,
        feature_value text, match_method text, score text, observed_at timestamptz
      )
      on conflict(source_type, source_key, theme_id, feature_type, feature_value, match_method) do update set
        score=greatest(ontology_evidence.score, excluded.score), observed_at=excluded.observed_at
    `, [JSON.stringify(evidence.map((row) => ({
      ...row,
      score: asSmallint(row.score, 'ontology_evidence.score'),
    })))]);
  }

  const candidates: CandidateInput[] = [];
  for (const item of classified) {
    for (const candidate of item.candidates) {
      if (
        candidate.candidateType === 'term'
        && candidate.themeId
        && catalog.termsByTheme.get(candidate.themeId)?.has(normalizePhrase(candidate.label))
      ) continue;
      const keyTheme = candidate.themeId || 'new';
      candidates.push({
        candidate_type: candidate.candidateType,
        candidate_key: `${keyTheme}:${normalizePhrase(candidate.label)}`,
        proposed_theme_id: candidate.themeId,
        proposed_label: candidate.label,
        description: candidate.description,
        score: asSmallint(candidate.confidence, 'candidate.confidence'),
        context: {
          evidence_excerpt: candidate.evidenceExcerpt,
          classification_model: ONTOLOGY_AI_MODEL,
          prompt_version: ONTOLOGY_PROMPT_VERSION,
        },
        source_type: 'bookmark',
        source_key: item.bookmark.id,
        observed_at: item.createdAt,
      });
    }
  }
  if (candidates.length > 0) {
    await database.execute(`
      with incoming as (
        select
          candidate_type, candidate_key, proposed_theme_id, proposed_label,
          description, score::smallint as score, context, source_type, source_key, observed_at
        from jsonb_to_recordset($1::jsonb) as item(
          candidate_type text, candidate_key text, proposed_theme_id text,
          proposed_label text, description text, score text, context jsonb,
          source_type text, source_key text, observed_at timestamptz
        )
      ), deduplicated as (
        select distinct on (candidate_type, candidate_key, source_type, source_key) *
        from incoming order by candidate_type, candidate_key, source_type, source_key, score desc
      ), candidate_rows as (
        select distinct on (candidate_type, candidate_key)
          candidate_type, candidate_key, proposed_theme_id, proposed_label,
          description, score, context, observed_at
        from deduplicated
        order by candidate_type, candidate_key, score desc, observed_at desc
      ), upserted as (
        insert into ontology_candidates(
          candidate_type, candidate_key, proposed_theme_id, proposed_label,
          proposed_description, score, sample_context, first_seen_at, last_seen_at
        )
        select candidate_type, candidate_key, proposed_theme_id, proposed_label,
               description, score, context, observed_at, observed_at
        from candidate_rows
        on conflict(candidate_type, candidate_key) do update set
          score=greatest(ontology_candidates.score, excluded.score),
          sample_context=excluded.sample_context, last_seen_at=excluded.last_seen_at
        returning id, candidate_type, candidate_key
      )
      insert into ontology_candidate_evidence(candidate_id, source_type, source_key, evidence_score, context, observed_at)
      select u.id, i.source_type, i.source_key, i.score, i.context, i.observed_at
      from upserted u join deduplicated i using(candidate_type, candidate_key)
      on conflict(candidate_id, source_type, source_key) do update set
        evidence_score=greatest(ontology_candidate_evidence.evidence_score, excluded.evidence_score),
        context=excluded.context, observed_at=excluded.observed_at
    `, [JSON.stringify(candidates)]);
  }
  await database.execute(`
    update ontology_candidates c set
      evidence_count=(select count(*) from ontology_candidate_evidence e where e.candidate_id=c.id),
      source_count=(select count(distinct e.source_type || ':' || e.source_key) from ontology_candidate_evidence e where e.candidate_id=c.id),
      score=coalesce((select round(avg(e.evidence_score))::integer from ontology_candidate_evidence e where e.candidate_id=c.id),0)
    where c.status='pending'
  `);
}

async function updateThesisEvidence(
  database: Database,
  classified: ClassifiedBookmark[],
  catalog: OntologyCatalog,
): Promise<void> {
  const byTheme = new Map<string, {
    supportingScores: number[];
    contradictingScores: number[];
    evidence: Map<string, { direction: ThemeMatch['direction']; excerpt: string; confidence: number }>;
    symbols: Map<string, number>;
  }>();
  for (const item of classified) {
    for (const match of item.matches) {
      if (match.theme.kind !== 'theme') continue;
      const entry = byTheme.get(match.theme.id) || {
        supportingScores: [],
        contradictingScores: [],
        evidence: new Map<string, { direction: ThemeMatch['direction']; excerpt: string; confidence: number }>(),
        symbols: new Map<string, number>(),
      };
      if (match.direction === 'supporting') entry.supportingScores.push(match.score);
      if (match.direction === 'contradicting') entry.contradictingScores.push(match.score);
      entry.evidence.set(item.bookmark.id, {
        direction: match.direction,
        excerpt: match.evidenceExcerpt,
        confidence: match.score,
      });
      const membershipCandidates = new Set(item.candidates
        .filter((candidate) => candidate.candidateType === 'membership' && candidate.themeId === match.theme.id)
        .map((candidate) => candidate.label));
      for (const symbol of item.symbols) {
        if (membershipCandidates.has(symbol) || catalog.membershipsBySymbol.get(symbol)?.has(match.theme.id)) {
          entry.symbols.set(symbol, (entry.symbols.get(symbol) || 0) + 1);
        }
      }
      byTheme.set(match.theme.id, entry);
    }
  }
  for (const [themeId, entry] of byTheme) {
    const supporting = entry.supportingScores.length
      ? entry.supportingScores.reduce((sum, score) => sum + score, 0) / entry.supportingScores.length
      : 40;
    const contradicting = entry.contradictingScores.length
      ? entry.contradictingScores.reduce((sum, score) => sum + score, 0) / entry.contradictingScores.length
      : 0;
    const average = Math.round(Math.max(0, Math.min(100, supporting - contradicting * 0.6)));
    const confidence = Math.min(85, Math.max(20, Math.round(average * 0.65) + entry.evidence.size * 3));
    await database.execute(
      "update theses set status=$1, confidence=$2, updated_at=now() where id=(select coalesce(thesis_id,id) from ontology_themes where id=$3)",
      [confidence < 60 ? 'forming' : 'hardening', confidence, themeId],
    );
    const total = [...entry.symbols.values()].reduce((sum, count) => sum + count, 0) || 1;
    for (const [symbol, count] of [...entry.symbols].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
      const active = await database.query<{ active: boolean }>(
        "select exists(select 1 from symbol_theme_memberships where symbol=$1 and theme_id=$2 and status='active') as active",
        [symbol, themeId],
      );
      await database.execute(`
        insert into thesis_symbols(thesis_id, symbol, role, weight_hint)
        values ((select coalesce(thesis_id,id) from ontology_themes where id=$1), $2, $3, $4)
        on conflict(thesis_id, symbol) do update set role=excluded.role, weight_hint=excluded.weight_hint
      `, [themeId, symbol, active[0]?.active ? 'member' : 'candidate', Number((count / total).toFixed(4))]);
    }
    for (const [bookmarkId, evidence] of entry.evidence) {
      await database.execute(`
        insert into thesis_evidence(thesis_id, bookmark_id, evidence_type, direction, summary, confidence, created_at)
        select coalesce(t.thesis_id,t.id), b.id, 'x_bookmark_llm', $3, $4, $5, now()
        from ontology_themes t join bookmarks b on b.id=$2 where t.id=$1
          and not exists (
            select 1 from thesis_evidence e where e.thesis_id=coalesce(t.thesis_id,t.id)
              and e.bookmark_id=b.id and e.evidence_type='x_bookmark_llm'
          )
      `, [themeId, bookmarkId, evidence.direction, evidence.excerpt, evidence.confidence]);
    }
    await database.execute(`
      insert into thesis_scores(thesis_id, scored_at, confidence, momentum, evidence_quality, catalyst_strength, portfolio_fit, risk, notes)
      values ((select coalesce(thesis_id,id) from ontology_themes where id=$1), now(), $2, $3, $4, 25, 50, 65,
        'Adaptive score from the LLM-backed ontology pipeline.')
    `, [themeId, confidence, Math.min(85, 30 + entry.evidence.size * 6), Math.min(80, average)]);
  }
}

async function persistInvestigationEvidence(
  database: Database,
  investigations: InvestigatedBookmark[],
): Promise<void> {
  for (const item of investigations) {
    const direction = item.investigation.claim_status === 'contradicted'
      ? 'contradicting'
      : item.investigation.claim_status === 'corroborated'
        ? 'supporting'
        : 'neutral';
    const confidence = item.investigation.claim_status === 'corroborated'
      ? 75
      : item.investigation.claim_status === 'contradicted'
        ? 70
        : item.investigation.claim_status === 'partial'
          ? 55
          : 35;
    await database.execute(`
      insert into thesis_evidence(
        thesis_id, bookmark_id, evidence_type, direction, summary, source_url, confidence, created_at
      )
      select distinct coalesce(ot.thesis_id, ot.id), b.id, 'x_claim_investigation', $2, $3, $4, $5, now()
      from bookmarks b
      join bookmark_symbols bs on bs.bookmark_id=b.id
      join symbol_theme_memberships m on m.symbol=bs.symbol and m.status='active'
      join ontology_themes ot on ot.id=m.theme_id and ot.status='active' and ot.kind='theme'
      where b.id=$1
        and not exists (
          select 1 from thesis_evidence e
          where e.thesis_id=coalesce(ot.thesis_id, ot.id)
            and e.bookmark_id=b.id
            and e.evidence_type='x_claim_investigation'
        )
    `, [
      item.bookmarkId,
      direction,
      item.investigation.investigation_summary.slice(0, 1_000),
      item.investigation.sources.find((source) => source.url)?.url ?? null,
      confidence,
    ]);
  }
}

export async function persistClaimInvestigations(
  database: Database,
  investigations: InvestigatedBookmark[],
  investigatedAt: string,
): Promise<number> {
  if (!investigations.length) return 0;
  const rows = investigations.map((item) => ({
    id: item.bookmarkId,
    investigation_model: item.model,
    investigation_prompt_version: item.promptVersion,
    investigation_output: item.investigation,
    investigated_at: investigatedAt,
  }));
  await database.execute(`
    update bookmarks b set
      investigation_model=x.investigation_model,
      investigation_prompt_version=x.investigation_prompt_version,
      investigation_output=x.investigation_output,
      investigated_at=x.investigated_at
    from jsonb_to_recordset($1::jsonb) as x(
      id text, investigation_model text, investigation_prompt_version text,
      investigation_output jsonb, investigated_at timestamptz
    )
    where b.id=x.id
  `, [JSON.stringify(rows)]);
  await database.execute(`
    delete from thesis_evidence
    where bookmark_id=any($1::text[]) and evidence_type='x_claim_investigation'
  `, [investigations.map((item) => item.bookmarkId)]);
  await persistInvestigationEvidence(database, investigations);
  return investigations.length;
}

async function promoteReadyCandidates(database: Database): Promise<number> {
  const rows = await database.query<{
    id: number; candidate_type: string; proposed_theme_id: string | null; proposed_label: string;
    proposed_description: string; score: number; evidence_count: number; source_count: number;
    first_seen_at: string; auto_promote_sources: number | null;
  }>(`
    select c.*, t.auto_promote_sources from ontology_candidates c
    left join ontology_themes t on t.id=c.proposed_theme_id
    where c.status='pending'
      and c.candidate_type in ('theme','term','membership')
      and c.sample_context->>'prompt_version'=$1
    order by c.score desc, c.source_count desc
  `, [ONTOLOGY_PROMPT_VERSION]);
  let promoted = 0;
  for (const row of rows) {
    const required = Number(row.auto_promote_sources || 4);
    const minimum = row.candidate_type === 'theme' ? 75 : 65;
    if (Number(row.source_count) < required || Number(row.score) < minimum) continue;
    if (row.candidate_type === 'membership') {
      const symbol = row.proposed_label.toUpperCase();
      const verified = await database.query<{ allowed: boolean }>(
        "select exists(select 1 from symbols where symbol=$1 and status in ('verified','active','public_comp')) as allowed",
        [symbol],
      );
      if (!verified[0]?.allowed || !row.proposed_theme_id) continue;
      await database.execute(`
        insert into symbol_theme_memberships(symbol, theme_id, confidence, evidence_count, source_count, status, learned_by, first_seen_at, last_seen_at)
        values ($1,$2,$3,$4,$5,'active','llm_semantic',$6,now())
        on conflict(symbol,theme_id) do update set
          confidence=greatest(symbol_theme_memberships.confidence,excluded.confidence),
          evidence_count=excluded.evidence_count, source_count=excluded.source_count,
          status='active', learned_by=excluded.learned_by, last_seen_at=excluded.last_seen_at
      `, [symbol, row.proposed_theme_id, row.score, row.evidence_count, row.source_count, row.first_seen_at]);
    } else if (row.candidate_type === 'term') {
      const normalized = normalizePhrase(row.proposed_label);
      if (!normalized || normalized.split(' ').some((token) => ['http', 'https', 'www', 't.co'].includes(token)) || !row.proposed_theme_id) continue;
      const totals = await database.query<{ count: number }>(
        "select count(distinct source_type || ':' || source_key)::integer as count from ontology_observations where feature_value=$1",
        [normalized],
      );
      if (Number(row.source_count) < required + 1 || Number(row.source_count) / Math.max(1, Number(totals[0]?.count || 0)) < 0.65) continue;
      await database.execute(`
        insert into ontology_terms(theme_id,term,normalized_term,term_type,weight,status,evidence_count,source_count,created_by,created_at,updated_at)
        values ($1,$2,$3,'alias',$4,'active',$5,$6,'llm_semantic',now(),now())
        on conflict(theme_id,normalized_term) do update set
          weight=greatest(ontology_terms.weight,excluded.weight), status='active',
          evidence_count=excluded.evidence_count, source_count=excluded.source_count, updated_at=excluded.updated_at
      `, [row.proposed_theme_id, row.proposed_label, normalized, row.score, row.evidence_count, row.source_count]);
    } else {
      const themeId = row.proposed_theme_id || slugify(row.proposed_label).replaceAll('-', '_').slice(0, 80);
      if (!themeId) continue;
      const blocked = await database.query<{ status: string }>('select status from ontology_themes where id=$1', [themeId]);
      if (blocked[0] && ['blacklisted', 'retired', 'merged'].includes(blocked[0].status)) continue;
      await database.execute(`
        insert into theses(id,name,summary,status,confidence,time_horizon,created_at,updated_at)
        values ($1,$2,$3,'forming',40,'days_to_weeks',now(),now()) on conflict(id) do nothing
      `, [themeId, row.proposed_label, row.proposed_description]);
      await database.execute(`
        insert into ontology_themes(id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources,created_by,created_at,updated_at)
        values ($1,$1,'theme',$2,$3,'active',35,6,'llm_semantic',now(),now())
        on conflict(id) do update set thesis_id=coalesce(ontology_themes.thesis_id,excluded.thesis_id), status='active', updated_at=now()
      `, [themeId, row.proposed_label, row.proposed_description]);
    }
    await database.execute(
      "update ontology_candidates set status='promoted', reviewed_at=now(), review_note=$1 where id=$2",
      ['llm_semantic_quality_gates', row.id],
    );
    promoted += 1;
  }
  return promoted;
}

export async function ingestXBookmarks(
  database: Database,
  payload: XBookmarkPayload,
  catalog: OntologyCatalog,
  classified: ClassifiedBookmark[],
  investigations: InvestigatedBookmark[] = [],
): Promise<{
  bookmarks: number;
  marketRelated: number;
  remainingAi: number;
  investigations: number;
  autoPromoted: number;
  pendingCandidates: number;
  articleTasks: Array<{ bookmarkId: string; url: string }>;
}> {
  const investigationMap = new Map(investigations.map((item) => [item.bookmarkId, item]));
  await database.execute("select pg_advisory_xact_lock(hashtextextended('thesisforge-x-bookmark-ingest',0))");
  await syncThemeTheses(database);
  const oldSymbols = await clearPriorAiClassification(database, classified);
  const runId = await persistCoreRows(database, payload, classified, investigationMap);
  await recountSymbols(database, [...oldSymbols, ...classified.flatMap((item) => item.symbols)]);
  await persistOntologyEvidence(database, classified, catalog);
  await updateThesisEvidence(database, classified, catalog);
  await persistInvestigationEvidence(database, investigations);
  const autoPromoted = await promoteReadyCandidates(database);
  const pending = await database.query<{ count: number }>("select count(*)::integer as count from ontology_candidates where status='pending'");
  await database.execute(
    'update runs set completed_at=now(), notes=$1 where id=$2',
    [JSON.stringify({
      bookmarks_analyzed: classified.length,
      classification_model: ONTOLOGY_AI_MODEL,
      prompt_version: ONTOLOGY_PROMPT_VERSION,
      investigation_model: INVESTIGATION_AI_MODEL,
      investigation_prompt_version: INVESTIGATION_PROMPT_VERSION,
      investigations: investigations.length,
      auto_promoted: autoPromoted,
      pending_candidates: Number(pending[0]?.count || 0),
      runtime: 'cloudflare',
    }), runId],
  );
  const incomingIds = payload.bookmarks
    .filter((bookmark) => bookmark.id.length > 0)
    .map((bookmark) => bookmark.id);
  const summary = incomingIds.length ? await database.query<{ market_related: number; remaining_ai: number }>(`
    select
      count(*) filter (where b.is_market_related)::integer as market_related,
      count(*) filter (
        where b.classification_prompt_version is distinct from $2
           or b.classification_model is distinct from $3
      )::integer as remaining_ai
    from unnest($1::text[]) incoming(id)
    left join bookmarks b using(id)
  `, [incomingIds, ONTOLOGY_PROMPT_VERSION, ONTOLOGY_AI_MODEL]) : [{ market_related: 0, remaining_ai: 0 }];
  const articleTasks = await database.query<{ bookmark_id: string; target: string }>(`
    select u.bookmark_id, coalesce(u.expanded_url,u.url) as target
    from bookmark_urls u left join articles a on a.url=coalesce(u.expanded_url,u.url)
    where a.id is null order by u.bookmark_id desc limit 100
  `);
  return {
    bookmarks: classified.length,
    marketRelated: Number(summary[0]?.market_related || 0),
    remainingAi: Number(summary[0]?.remaining_ai || 0),
    investigations: investigations.length,
    autoPromoted,
    pendingCandidates: Number(pending[0]?.count || 0),
    articleTasks: articleTasks.map((row) => ({ bookmarkId: row.bookmark_id, url: row.target })),
  };
}
