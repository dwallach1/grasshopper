import type { Database } from './database';
import { loadOntologyCatalog, normalizePhrase, slugify, type OntologyCatalog, type ThemeMatch } from './ontology';

export type XBookmark = {
  id: string;
  author_id?: string;
  created_at?: string;
  text?: string;
  entities?: { urls?: Array<{ url?: string; expanded_url?: string; display_url?: string }> };
  context_annotations?: unknown[];
  [key: string]: unknown;
};

export type XBookmarkPayload = {
  fetchedAt: string;
  user: Record<string, unknown>;
  bookmarks: XBookmark[];
};

type ClassifiedBookmark = {
  bookmark: XBookmark;
  createdAt: string;
  text: string;
  symbols: string[];
  marketScore: number;
  matches: ThemeMatch[];
  salient: Array<[string, string]>;
};

type CandidateInput = {
  candidate_type: string;
  candidate_key: string;
  proposed_theme_id: string | null;
  proposed_label: string;
  description: string;
  score: number;
  context: Record<string, unknown>;
  source_type: string;
  source_key: string;
  observed_at: string;
};

function claimType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('price target') || lower.includes('%') || lower.includes('+')) return 'price_target_or_momentum';
  if (lower.includes('earnings') || lower.includes('quarter')) return 'earnings_catalyst';
  if (lower.includes('13f') || lower.includes('portfolio')) return 'investor_positioning';
  if (lower.includes('deal') || lower.includes('contract') || lower.includes('announced')) return 'company_event';
  if (lower.includes('cheap') || lower.includes('valuation') || lower.includes('multiple')) return 'valuation';
  return 'opinion_or_theme';
}

function classifyBookmarks(payload: XBookmarkPayload, catalog: OntologyCatalog): ClassifiedBookmark[] {
  const unique = new Map<string, XBookmark>();
  for (const bookmark of payload.bookmarks) {
    if (typeof bookmark.id === 'string' && bookmark.id.length > 0) unique.set(bookmark.id, bookmark);
  }
  return [...unique.values()]
    .map((bookmark) => {
      const text = typeof bookmark.text === 'string' ? bookmark.text : '';
      const symbolSet = catalog.extractSymbols(text);
      return {
        bookmark,
        createdAt: typeof bookmark.created_at === 'string' ? bookmark.created_at : payload.fetchedAt,
        text,
        symbols: [...symbolSet].sort(),
        marketScore: catalog.marketScore(text, symbolSet, Array.isArray(bookmark.context_annotations) ? bookmark.context_annotations : []),
        matches: catalog.classify(text, symbolSet),
        salient: catalog.salientFeatures(text),
      };
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

async function persistCoreRows(
  database: Database,
  payload: XBookmarkPayload,
  classified: ClassifiedBookmark[],
): Promise<number> {
  const run = await database.query<{ id: string }>(
    "insert into runs(run_type, started_at, notes) values ('bookmark_ingest', now(), null) returning id",
  );
  const bookmarkRows = classified.map((item) => ({
    id: item.bookmark.id,
    author_id: typeof item.bookmark.author_id === 'string' ? item.bookmark.author_id : null,
    created_at: item.createdAt,
    fetched_at: payload.fetchedAt,
    text: item.text,
    raw_json: item.bookmark,
    market_score: item.marketScore,
    is_market_related: item.marketScore >= 35,
  }));
  await database.execute(`
    insert into bookmarks(id, author_id, created_at, fetched_at, text, raw_json, market_score, is_market_related)
    select id, author_id, created_at, fetched_at, text, raw_json, market_score, is_market_related
    from jsonb_to_recordset($1::jsonb) as x(
      id text, author_id text, created_at timestamptz, fetched_at timestamptz,
      text text, raw_json jsonb, market_score smallint, is_market_related boolean
    )
    on conflict(id) do update set
      fetched_at=excluded.fetched_at, text=excluded.text, raw_json=excluded.raw_json,
      market_score=excluded.market_score, is_market_related=excluded.is_market_related
  `, [JSON.stringify(bookmarkRows)]);

  const urlMap = new Map<string, { bookmark_id: string; url: string; expanded_url: string | null; display_url: string | null }>();
  for (const item of classified) for (const url of item.bookmark.entities?.urls || []) {
    if (typeof url.url !== 'string' || !url.url) continue;
    const row = {
      bookmark_id: item.bookmark.id,
      url: url.url,
      expanded_url: typeof url.expanded_url === 'string' ? url.expanded_url : null,
      display_url: typeof url.display_url === 'string' ? url.display_url : null,
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
      ), inserted as (
        insert into bookmark_symbols(bookmark_id, symbol, source)
        select bookmark_id, symbol, 'cashtag_or_uppercase' from incoming
        on conflict(bookmark_id, symbol) do nothing
        returning symbol
      ), counts as (
        select symbol, count(*)::bigint as added from inserted group by symbol
      )
      update symbols s set mention_count=s.mention_count+c.added, source_count=s.source_count+c.added
      from counts c where c.symbol=s.symbol
    `, [JSON.stringify(symbolRows)]);
  }

  const claims = classified.filter((item) => item.marketScore >= 35).map((item) => ({
    bookmark_id: item.bookmark.id,
    claim_text: item.text.slice(0, 500),
    claim_type: claimType(item.text),
    confidence: Math.min(70, Math.max(30, item.marketScore)),
  }));
  if (claims.length > 0) {
    await database.execute(`
      insert into claims(bookmark_id, claim_text, claim_type, created_at, confidence)
      select x.bookmark_id, x.claim_text, x.claim_type, now(), x.confidence
      from jsonb_to_recordset($1::jsonb)
        as x(bookmark_id text, claim_text text, claim_type text, confidence smallint)
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
    ...item.salient.map(([featureType, featureValue]) => ({ source_type: 'bookmark', source_key: item.bookmark.id, feature_type: featureType, feature_value: featureValue, observed_at: item.createdAt })),
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

  const evidence = classified.flatMap((item) => item.matches.flatMap((match) => [
    ...match.matchedTerms.map((term) => ({ source_type: 'bookmark', source_key: item.bookmark.id, theme_id: match.theme.id, feature_type: 'term', feature_value: term, match_method: 'term', score: match.score, observed_at: item.createdAt })),
    ...match.matchedSymbols.map((symbol) => ({ source_type: 'bookmark', source_key: item.bookmark.id, theme_id: match.theme.id, feature_type: 'symbol', feature_value: symbol, match_method: 'symbol', score: match.score, observed_at: item.createdAt })),
  ]));
  if (evidence.length > 0) {
    await database.execute(`
      insert into ontology_evidence(source_type, source_key, theme_id, feature_type, feature_value, match_method, score, observed_at)
      select source_type, source_key, theme_id, feature_type, feature_value, match_method, score, observed_at
      from jsonb_to_recordset($1::jsonb) as x(
        source_type text, source_key text, theme_id text, feature_type text,
        feature_value text, match_method text, score smallint, observed_at timestamptz
      )
      on conflict(source_type, source_key, theme_id, feature_type, feature_value, match_method) do update set
        score=greatest(ontology_evidence.score, excluded.score), observed_at=excluded.observed_at
    `, [JSON.stringify(evidence)]);
  }

  const candidates: CandidateInput[] = [];
  for (const item of classified) {
    for (const match of item.matches) {
      for (const symbol of item.symbols.filter((symbol) => !match.matchedSymbols.includes(symbol))) {
        candidates.push({
          candidate_type: 'membership', candidate_key: `${match.theme.id}:${symbol}`,
          proposed_theme_id: match.theme.id, proposed_label: symbol,
          description: `${symbol} repeatedly co-occurs with ${match.theme.name} evidence.`,
          score: match.score, context: { symbol, theme: match.theme.id, excerpt: item.text.slice(0, 500) },
          source_type: 'bookmark', source_key: item.bookmark.id, observed_at: item.createdAt,
        });
      }
      for (const [featureType, featureValue] of item.salient.slice(0, 8)) {
        if (catalog.termsByTheme.get(match.theme.id)?.has(featureValue)) continue;
        candidates.push({
          candidate_type: 'term', candidate_key: `${match.theme.id}:${featureValue}`,
          proposed_theme_id: match.theme.id, proposed_label: featureValue,
          description: `Learned vocabulary candidate for ${match.theme.name}.`,
          score: Math.max(1, match.score - (featureType === 'term' ? 5 : 0)),
          context: { feature_type: featureType, theme: match.theme.id, excerpt: item.text.slice(0, 500) },
          source_type: 'bookmark', source_key: item.bookmark.id, observed_at: item.createdAt,
        });
      }
    }
  }
  if (candidates.length > 0) {
    await database.execute(`
      with incoming as (
        select * from jsonb_to_recordset($1::jsonb) as item(
          candidate_type text, candidate_key text, proposed_theme_id text,
          proposed_label text, description text, score smallint, context jsonb,
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
      evidence_count=stats.evidence_count,
      source_count=stats.source_count,
      score=stats.score
    from (
      select candidate_id, count(*) as evidence_count,
             count(distinct source_type || ':' || source_key) as source_count,
             round(avg(evidence_score))::integer as score
      from ontology_candidate_evidence group by candidate_id
    ) stats where stats.candidate_id=c.id
  `);
}

async function updateThesisEvidence(database: Database, classified: ClassifiedBookmark[]): Promise<void> {
  const byTheme = new Map<string, { scores: number[]; bookmarks: Set<string>; symbols: Map<string, number>; name: string }>();
  for (const item of classified) {
    for (const match of item.matches) {
      if (match.theme.kind !== 'theme') continue;
      const entry: { scores: number[]; bookmarks: Set<string>; symbols: Map<string, number>; name: string } =
        byTheme.get(match.theme.id) || { scores: [], bookmarks: new Set<string>(), symbols: new Map<string, number>(), name: match.theme.name };
      entry.scores.push(match.score);
      entry.bookmarks.add(item.bookmark.id);
      for (const symbol of item.symbols) entry.symbols.set(symbol, (entry.symbols.get(symbol) || 0) + 1);
      byTheme.set(match.theme.id, entry);
    }
  }
  for (const [themeId, entry] of byTheme) {
    const average = Math.round(entry.scores.reduce((sum, score) => sum + score, 0) / Math.max(1, entry.scores.length));
    const confidence = Math.min(85, Math.max(40, Math.round(average * 0.65) + entry.bookmarks.size * 3));
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
    for (const bookmarkId of entry.bookmarks) {
      await database.execute(`
        insert into thesis_evidence(thesis_id, bookmark_id, evidence_type, direction, summary, confidence, created_at)
        select coalesce(t.thesis_id,t.id), b.id, 'x_bookmark', 'supporting', left(b.text,350), $3, now()
        from ontology_themes t join bookmarks b on b.id=$2 where t.id=$1
          and not exists (
            select 1 from thesis_evidence e where e.thesis_id=coalesce(t.thesis_id,t.id)
              and e.bookmark_id=b.id and e.evidence_type='x_bookmark'
          )
      `, [themeId, bookmarkId, average]);
    }
    await database.execute(`
      insert into thesis_scores(thesis_id, scored_at, confidence, momentum, evidence_quality, catalyst_strength, portfolio_fit, risk, notes)
      values ((select coalesce(thesis_id,id) from ontology_themes where id=$1), now(), $2, $3, $4, 25, 50, 65,
        'Adaptive score from the worker-based ontology pipeline.')
    `, [themeId, confidence, Math.min(85, 30 + entry.bookmarks.size * 6), Math.min(80, average)]);
  }
}

async function promoteReadyCandidates(database: Database): Promise<number> {
  const rows = await database.query<{
    id: number; candidate_type: string; proposed_theme_id: string | null; proposed_label: string;
    proposed_description: string; score: number; evidence_count: number; source_count: number;
    first_seen_at: string; auto_promote_sources: number | null;
  }>(`
    select c.*, t.auto_promote_sources from ontology_candidates c
    left join ontology_themes t on t.id=c.proposed_theme_id
    where c.status='pending' and c.candidate_type in ('theme','term','membership')
    order by c.score desc, c.source_count desc
  `);
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
        values ($1,$2,$3,$4,$5,'active','auto_cooccurrence',$6,now())
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
        values ($1,$2,$3,'alias',$4,'active',$5,$6,'auto_cooccurrence',now(),now())
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
        values ($1,$1,'theme',$2,$3,'active',35,6,'auto_emergence',now(),now())
        on conflict(id) do update set thesis_id=coalesce(ontology_themes.thesis_id,excluded.thesis_id), status='active', updated_at=now()
      `, [themeId, row.proposed_label, row.proposed_description]);
    }
    await database.execute(
      "update ontology_candidates set status='promoted', reviewed_at=now(), review_note=$1 where id=$2",
      [row.candidate_type === 'theme' ? 'auto_emergence' : 'auto_cooccurrence', row.id],
    );
    promoted += 1;
  }
  return promoted;
}

export async function ingestXBookmarks(database: Database, payload: XBookmarkPayload): Promise<{
  bookmarks: number;
  marketRelated: number;
  autoPromoted: number;
  pendingCandidates: number;
  articleTasks: Array<{ bookmarkId: string; url: string }>;
}> {
  await database.execute("select pg_advisory_xact_lock(hashtextextended('thesisforge-x-bookmark-ingest',0))");
  await syncThemeTheses(database);
  const catalog = await loadOntologyCatalog(database);
  const classified = classifyBookmarks(payload, catalog);
  const runId = await persistCoreRows(database, payload, classified);
  await persistOntologyEvidence(database, classified, catalog);
  await updateThesisEvidence(database, classified);
  const autoPromoted = await promoteReadyCandidates(database);
  const pending = await database.query<{ count: number }>("select count(*)::integer as count from ontology_candidates where status='pending'");
  await database.execute(
    'update runs set completed_at=now(), notes=$1 where id=$2',
    [JSON.stringify({ bookmarks: classified.length, auto_promoted: autoPromoted, pending_candidates: Number(pending[0]?.count || 0), runtime: 'cloudflare' }), runId],
  );
  const articleTasks = await database.query<{ bookmark_id: string; target: string }>(`
    select u.bookmark_id, coalesce(u.expanded_url,u.url) as target
    from bookmark_urls u left join articles a on a.url=coalesce(u.expanded_url,u.url)
    where a.id is null order by u.bookmark_id desc limit 100
  `);
  return {
    bookmarks: classified.length,
    marketRelated: classified.filter((item) => item.marketScore >= 35).length,
    autoPromoted,
    pendingCandidates: Number(pending[0]?.count || 0),
    articleTasks: articleTasks.map((row) => ({ bookmarkId: row.bookmark_id, url: row.target })),
  };
}
