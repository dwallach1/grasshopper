import { describe, expect, test } from 'bun:test';

import { bookmarkFromUnknown, asSmallint, claimRowsForPersist } from './bookmarks';
import { CaptureSchema } from './capture';
import {
  parseClaimInvestigation,
  shouldInvestigateClaim,
} from './claim-investigation';
import { cleanHtml, documentTypeFor, extractDocumentText, objectPathFor } from './documents';
import { FinancialRequestSchema } from './financial';
import { parseOntologyAiOutput, type AnalysisInput, type ClassifiedBookmark } from './ontology-analysis';
import { normalizePhrase, OntologyCatalog, slugify } from './ontology';
import { parseResearchDecision, ResearchActionSchema, seedActions } from './x-research';
import { xOauthFailureMessage } from './x-oauth';

describe('worker knowledge primitives', () => {
  test('coerces claim confidence for jsonb_to_recordset inserts', () => {
    expect(asSmallint(88, 'claim.confidence')).toBe(88);
    expect(asSmallint('72', 'claim.confidence')).toBe(72);
    expect(() => asSmallint('nope', 'claim.confidence')).toThrow(/Invalid smallint/);
    expect(() => asSmallint(12.5, 'claim.confidence')).toThrow(/Invalid smallint/);

    const classified = [{
      bookmark: { id: 'b1' },
      createdAt: '2026-08-26T12:00:00Z',
      text: 'claim',
      symbols: ['VST'],
      marketScore: 90,
      claim: { type: 'company_event', summary: 'Contract', confidence: 88, evidenceExcerpt: 'signed' },
      matches: [],
      candidates: [],
      classificationOutput: {} as ClassifiedBookmark['classificationOutput'],
    }, {
      bookmark: { id: 'b2' },
      createdAt: '2026-08-26T12:00:00Z',
      text: 'noise',
      symbols: [],
      marketScore: 10,
      claim: { type: 'none', summary: '', confidence: 0, evidenceExcerpt: '' },
      matches: [],
      candidates: [],
      classificationOutput: {} as ClassifiedBookmark['classificationOutput'],
    }] as ClassifiedBookmark[];

    expect(claimRowsForPersist(classified)).toEqual([{
      bookmark_id: 'b1',
      claim_text: 'Contract',
      claim_type: 'company_event',
      confidence: 88,
    }]);
    // JSON.stringify must emit a number so Postgres can cast text→smallint safely.
    expect(JSON.parse(JSON.stringify(claimRowsForPersist(classified)))[0].confidence).toBe(88);
  });

  test('normalizes ontology identifiers deterministically', () => {
    expect(normalizePhrase('AI_Infrastructure / Power')).toBe('ai infrastructure power');
    expect(slugify('AI Infrastructure & Power')).toBe('ai-infrastructure-power');
  });

  test('parses X tweet payloads and rejects malformed bookmarks', () => {
    expect(bookmarkFromUnknown({ id: '1', text: 'hello $VST' })).toMatchObject({ id: '1', text: 'hello $VST' });
    expect(bookmarkFromUnknown({ text: 'missing id' })).toBeNull();
  });

  test('maps X OAuth 400s to a reauthorization-required failure', () => {
    expect(xOauthFailureMessage('X token refresh', 400, { error: 'invalid_grant' }))
      .toBe('X token refresh failed with status 400 (invalid_grant); reauthorization is required');
    expect(xOauthFailureMessage('X token refresh', 400, {})).toContain('reauthorization is required');
    expect(xOauthFailureMessage('X token refresh', 500, { error: 'server_error' }))
      .toBe('X token refresh failed with status 500 (server_error)');
    expect(xOauthFailureMessage('X token refresh', 401, null))
      .toBe('X token refresh failed with status 401');
  });

  test('validates financial and capture request boundaries', () => {
    expect(FinancialRequestSchema.parse({ endpoint: 'prices/snapshot', params: { ticker: 'VST' } })).toMatchObject({
      endpoint: 'prices/snapshot',
    });
    expect(() => FinancialRequestSchema.parse({ endpoint: '../etc/passwd' })).toThrow();
    expect(CaptureSchema.parse({
      operation: 'thesis_view',
      thesis_id: 'power',
      stance: 'bullish',
      variant: 'data-center demand',
      falsifier: 'capex cuts',
    }).operation).toBe('thesis_view');
    expect(() => CaptureSchema.parse({ operation: 'thesis_view', thesis_id: 'power' })).toThrow();
  });

  test('validates structured semantic ontology analysis with exact evidence', () => {
    const catalog = new OntologyCatalog({
      themes: [{ id: 'power', thesisId: 'power', kind: 'theme', name: 'Power', description: '', matchThreshold: 35, autoPromoteSources: 4 }],
      terms: [{ theme_id: 'power', normalized_term: 'data center', weight: 80, term_type: 'phrase' }],
      memberships: [{ symbol: 'VST', theme_id: 'power', confidence: 80 }],
      lexicon: [{ token: 'earnings', token_type: 'market_keyword', weight: 20 }],
      symbols: ['VST'],
    });
    const bookmark = { id: 'bookmark-1', text: '$VST signed a data-center power contract after earnings.' };
    const inputs: AnalysisInput[] = [{
      id: bookmark.id,
      text: bookmark.text,
      contextAnnotations: [],
      bookmark,
      createdAt: '2026-08-24T12:00:00Z',
    }];
    const classified = parseOntologyAiOutput({ response: JSON.stringify({ analyses: [{
      bookmark_id: bookmark.id,
      market_relevance: 92,
      claim_type: 'company_event',
      claim_summary: 'VST signed a power contract.',
      claim_confidence: 88,
      claim_evidence_excerpt: '$VST signed a data-center power contract',
      symbols: ['VST'],
      themes: [{
        theme_id: 'power', confidence: 91, direction: 'supporting',
        evidence_excerpt: 'data-center power contract',
      }],
      candidates: [{
        candidate_type: 'term', theme_id: 'power', label: 'data-center power contract',
        description: 'Reusable vocabulary for contracted data-center electricity demand.',
        confidence: 82, evidence_excerpt: 'data-center power contract',
      }],
    }] }) }, inputs, catalog);
    expect(classified[0]).toMatchObject({
      marketScore: 92,
      symbols: ['VST'],
      claim: { type: 'company_event', confidence: 88 },
      matches: [{ theme: { id: 'power' }, score: 91, direction: 'supporting' }],
    });

    const fromObjectEnvelope = parseOntologyAiOutput({
      response: {
        analyses: [{
          bookmark_id: bookmark.id,
          market_relevance: 70,
          claim_type: 'none',
          claim_summary: '',
          claim_confidence: 0,
          claim_evidence_excerpt: '',
          symbols: ['VST'],
          themes: [],
          candidates: [],
        }],
      },
    }, inputs, catalog);
    expect(fromObjectEnvelope[0]?.symbols).toEqual(['VST']);
  });

  test('fails closed when ontology AI omits analyses', () => {
    const catalog = new OntologyCatalog({
      themes: [], terms: [], memberships: [], lexicon: [],
    });
    const inputs: AnalysisInput[] = [{
      id: 'bookmark-1', text: 'hello', contextAnnotations: [], bookmark: { id: 'bookmark-1', text: 'hello' },
      createdAt: '2026-08-24T12:00:00Z',
    }];
    expect(() => parseOntologyAiOutput({ response: { not_analyses: true } }, inputs, catalog))
      .toThrow('missing analyses');
  });

  test('fails closed when model evidence is not present in the source', () => {
    const catalog = new OntologyCatalog({
      themes: [{ id: 'power', thesisId: 'power', kind: 'theme', name: 'Power', description: '', matchThreshold: 35, autoPromoteSources: 4 }],
      terms: [], memberships: [], lexicon: [],
    });
    const bookmark = { id: 'bookmark-1', text: 'No catalyst is stated.' };
    const inputs: AnalysisInput[] = [{
      id: bookmark.id, text: bookmark.text, contextAnnotations: [], bookmark, createdAt: '2026-08-24T12:00:00Z',
    }];
    expect(() => parseOntologyAiOutput({ analyses: [{
      bookmark_id: bookmark.id,
      market_relevance: 80,
      claim_type: 'company_event',
      claim_summary: 'A contract was announced.',
      claim_confidence: 90,
      claim_evidence_excerpt: 'announced a large contract',
      symbols: [], themes: [], candidates: [],
    }] }, inputs, catalog)).toThrow('exact source excerpt');
  });

  test('gates and validates claim investigation packets without trade advice', () => {
    const classified = {
      marketScore: 80,
      claim: { type: 'company_event', summary: 'Contract signed', confidence: 70, evidenceExcerpt: 'signed' },
    } as ClassifiedBookmark;
    expect(shouldInvestigateClaim(classified)).toBe(true);
    expect(shouldInvestigateClaim({
      ...classified,
      claim: { ...classified.claim!, confidence: 20 },
    })).toBe(false);

    const packet = parseClaimInvestigation({
      response: JSON.stringify({
        bookmark_id: 'b1',
        claim_status: 'partial',
        investigation_summary: 'IR release partially supports the claim.',
        symbols: ['VST'],
        sources: [{
          source_id: 's1',
          tier: 'company_or_primary',
          title: 'IR note',
          url: 'https://example.com/ir',
          published_at: '2026-08-20',
          excerpt: 'signed a power agreement',
          supports_claim: true,
        }],
        corroborating_source_ids: ['s1'],
        contradicting_source_ids: [],
        open_questions: ['Contract economics'],
        falsifiers: ['Agreement cancelled'],
        trade_recommendation: 'none',
      }),
    }, 'b1');
    expect(packet.claim_status).toBe('partial');
    expect(() => parseClaimInvestigation({
      response: JSON.stringify({ ...packet, trade_recommendation: 'buy' }),
    }, 'b1')).toThrow();
  });

  test('seeds compounding research from the conversation and referenced tweets', () => {
    const actions = seedActions({
      bookmark_id: '111',
      raw_json: {
        conversation_id: '222',
        referenced_tweets: [{ type: 'quoted', id: '333' }, { type: 'replied_to', id: 'bad-id' }],
      },
    });
    expect(actions).toMatchObject([
      { action: 'read_conversation', tweet_id: '222' },
      { action: 'lookup_tweets', tweet_ids: ['333'] },
    ]);
    expect(seedActions({ bookmark_id: '111', raw_json: null })).toMatchObject([
      { action: 'read_conversation', tweet_id: '111' },
    ]);
  });

  test('validates research actions fail closed on missing arguments', () => {
    expect(ResearchActionSchema.parse({
      action: 'search_x', tweet_id: null, tweet_ids: [], query: '$VST power contract', url: null,
      reason: 'Corroborate the claim.',
    }).action).toBe('search_x');
    expect(() => ResearchActionSchema.parse({
      action: 'open_url', tweet_id: null, tweet_ids: [], query: null, url: null,
      reason: 'Missing URL.',
    })).toThrow();
    expect(() => ResearchActionSchema.parse({
      action: 'lookup_tweets', tweet_id: null, tweet_ids: [], query: null, url: null,
      reason: 'Missing ids.',
    })).toThrow();
  });

  test('parses research decisions and rejects uncited or off-session output', () => {
    const decision = {
      bookmark_id: 'b1',
      findings: [{
        summary: 'Replies cite the signed interconnection agreement.',
        direction: 'supporting',
        confidence: 70,
        source_refs: ['tweet:900', 'article:https://example.com/ir'],
      }],
      new_symbols: ['VST'],
      next_actions: [{
        action: 'search_x', tweet_id: null, tweet_ids: [], query: 'interconnection agreement',
        url: null, reason: 'Look for counter-evidence.',
      }],
      should_continue: true,
      rationale: 'Replies point to a primary source worth corroborating.',
      trade_recommendation: 'none',
    };
    const knownRefs = new Set(['tweet:b1', 'tweet:900', 'article:https://example.com/ir']);
    const parsed = parseResearchDecision({ response: JSON.stringify(decision) }, 'b1', knownRefs);
    expect(parsed.findings[0].confidence).toBe(70);
    expect(parsed.next_actions).toHaveLength(1);
    expect(() => parseResearchDecision({ response: JSON.stringify(decision) }, 'other', knownRefs))
      .toThrow('does not match');
    expect(() => parseResearchDecision(
      { response: JSON.stringify(decision) }, 'b1', new Set(['tweet:b1']),
    )).toThrow('unknown source ref');
    expect(() => parseResearchDecision({
      response: JSON.stringify({ ...decision, trade_recommendation: 'buy' }),
    }, 'b1', knownRefs)).toThrow();
  });

  test('extracts bounded HTML text and stable R2 paths', async () => {
    const html = '<html><head><title> Grid &amp; Power </title><style>hidden</style></head><body><nav>menu</nav><p>Useful evidence.</p></body></html>';
    expect(cleanHtml(html)).toEqual({ title: 'Grid & Power', text: 'Grid & Power Useful evidence.' });
    const extracted = await extractDocumentText(new TextEncoder().encode(html), 'text/html; charset=utf-8');
    expect(extracted.status).toBe('complete');
    expect(extracted.text).toContain('Useful evidence.');
    expect(documentTypeFor('application/pdf', 'https://example.com/filing.pdf')).toBe('filing');
    expect(objectPathFor('a'.repeat(64), 'filing', '2026-08-24T12:00:00Z', 'application/pdf', 'https://example.com/a.pdf'))
      .toBe(`filing/2026/08/${'a'.repeat(64)}.pdf`);
  });
});
