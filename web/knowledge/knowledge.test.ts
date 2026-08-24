import { describe, expect, test } from 'bun:test';

import { cleanHtml, documentTypeFor, extractDocumentText, objectPathFor } from './documents';
import { normalizePhrase, OntologyCatalog, slugify, textFeatures } from './ontology';

describe('worker knowledge primitives', () => {
  test('normalizes ontology phrases and n-grams deterministically', () => {
    expect(normalizePhrase('AI_Infrastructure / Power')).toBe('ai infrastructure power');
    expect(slugify('AI Infrastructure & Power')).toBe('ai-infrastructure-power');
    expect(textFeatures('power grid demand')).toContain('power grid');
  });

  test('classifies using database-shaped terms and verified memberships', () => {
    const catalog = new OntologyCatalog({
      themes: [{ id: 'power', thesisId: 'power', kind: 'theme', name: 'Power', description: '', matchThreshold: 35, autoPromoteSources: 4 }],
      terms: [{ theme_id: 'power', normalized_term: 'data center', weight: 80, term_type: 'phrase' }],
      memberships: [{ symbol: 'VST', theme_id: 'power', confidence: 80 }],
      lexicon: [{ token: 'earnings', token_type: 'market_keyword', weight: 20 }],
      symbols: ['VST'],
    });
    const symbols = catalog.extractSymbols('$VST data center earnings');
    expect(symbols).toEqual(new Set(['VST']));
    expect(catalog.marketScore('$VST data center earnings', symbols, [])).toBe(32);
    expect(catalog.classify('$VST data center earnings', symbols)[0]).toMatchObject({
      theme: { id: 'power' }, matchedSymbols: ['VST'], matchedTerms: ['data center'],
    });
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
