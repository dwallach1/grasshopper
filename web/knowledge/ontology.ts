import type { Database } from './database';

const TOKEN_RE = /[a-z0-9]+(?:[.-][a-z0-9]+)*/g;
const CASHTAG_RE = /\$([A-Z][A-Z0-9.]{0,9})\b/g;
const UPPERCASE_RE = /\b[A-Z]{2,10}\b/g;
const HASHTAG_RE = /#([A-Za-z][A-Za-z0-9_]{2,40})/g;

export type Theme = {
  id: string;
  thesisId: string | null;
  kind: string;
  name: string;
  description: string;
  matchThreshold: number;
  autoPromoteSources: number;
};

export type ThemeMatch = {
  theme: Theme;
  score: number;
  matchedTerms: string[];
  matchedSymbols: string[];
};

type TermRow = { theme_id: string; normalized_term: string; weight: number; term_type: string };
type MembershipRow = { symbol: string; theme_id: string; confidence: number };
type LexiconRow = { token: string; token_type: string; weight: number };

export function normalizePhrase(value: string): string {
  return (value.toLowerCase().replaceAll('_', ' ').match(TOKEN_RE) || []).join(' ');
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function textFeatures(text: string, maxNgram = 4): Set<string> {
  const tokens = text.toLowerCase().replaceAll('_', ' ').match(TOKEN_RE) || [];
  const features = new Set(tokens);
  for (let width = 2; width <= Math.min(maxNgram, tokens.length); width += 1) {
    for (let index = 0; index <= tokens.length - width; index += 1) {
      features.add(tokens.slice(index, index + width).join(' '));
    }
  }
  return features;
}

export class OntologyCatalog {
  readonly themes = new Map<string, Theme>();
  readonly termsByTheme = new Map<string, Map<string, { weight: number; type: string }>>();
  readonly membershipsBySymbol = new Map<string, Map<string, number>>();
  readonly knownSymbols = new Set<string>();
  readonly blacklistedSymbols = new Set<string>();
  readonly ignoredSymbols = new Set<string>();
  readonly marketKeywords = new Map<string, number>();
  readonly marketContext = new Map<string, number>();
  readonly candidateStopwords = new Set<string>();

  constructor(input: {
    themes: Theme[];
    terms: TermRow[];
    memberships: MembershipRow[];
    lexicon: LexiconRow[];
    symbols?: string[];
    blacklistedSymbols?: string[];
  }) {
    for (const theme of input.themes) this.themes.set(theme.id, theme);
    for (const row of input.terms) {
      const terms = this.termsByTheme.get(row.theme_id) || new Map();
      terms.set(row.normalized_term, { weight: Number(row.weight), type: row.term_type });
      this.termsByTheme.set(row.theme_id, terms);
    }
    for (const row of input.memberships) {
      const memberships = this.membershipsBySymbol.get(row.symbol) || new Map();
      memberships.set(row.theme_id, Number(row.confidence));
      this.membershipsBySymbol.set(row.symbol, memberships);
      this.knownSymbols.add(row.symbol.toUpperCase());
    }
    for (const symbol of input.symbols || []) this.knownSymbols.add(symbol.toUpperCase());
    for (const symbol of input.blacklistedSymbols || []) this.blacklistedSymbols.add(symbol.toUpperCase());
    for (const row of input.lexicon) {
      if (row.token_type === 'ignored_symbol') this.ignoredSymbols.add(row.token.toUpperCase());
      else if (row.token_type === 'market_keyword') this.marketKeywords.set(normalizePhrase(row.token), Number(row.weight));
      else if (row.token_type === 'market_context') this.marketContext.set(normalizePhrase(row.token), Number(row.weight));
      else if (row.token_type === 'candidate_stopword') this.candidateStopwords.add(normalizePhrase(row.token));
    }
  }

  extractSymbols(text: string): Set<string> {
    const symbols = new Set<string>();
    for (const match of text.matchAll(CASHTAG_RE)) symbols.add(match[1].replaceAll('.', '-').toUpperCase());
    for (const match of text.matchAll(UPPERCASE_RE)) {
      const symbol = match[0].toUpperCase();
      if (this.knownSymbols.has(symbol)) symbols.add(symbol);
    }
    for (const symbol of [...symbols]) {
      if (this.ignoredSymbols.has(symbol) || this.blacklistedSymbols.has(symbol) || /^\d+$/.test(symbol)) {
        symbols.delete(symbol);
      }
    }
    return symbols;
  }

  marketScore(text: string, symbols: Set<string>, annotations: unknown[]): number {
    const features = textFeatures(text);
    let score = Math.min(symbols.size * 12, 48);
    for (const [term, weight] of this.marketKeywords) if (features.has(term)) score += weight;
    const context = normalizePhrase(JSON.stringify(annotations || []));
    for (const [term, weight] of this.marketContext) if (term && context.includes(term)) score += weight;
    return Math.min(score, 100);
  }

  classify(text: string, sourceSymbols: Set<string>): ThemeMatch[] {
    const symbols = new Set([...sourceSymbols].filter((symbol) => !this.blacklistedSymbols.has(symbol)));
    const features = textFeatures(text);
    const scores = new Map<string, number>();
    const termHits = new Map<string, Set<string>>();
    const symbolHits = new Map<string, Set<string>>();
    for (const [themeId, terms] of this.termsByTheme) {
      for (const [term, entry] of terms) {
        if (!features.has(term)) continue;
        const adjustment = entry.type === 'negative' ? -entry.weight : Math.round(entry.weight * 0.55);
        scores.set(themeId, (scores.get(themeId) || 0) + adjustment);
        const hits = termHits.get(themeId) || new Set<string>();
        hits.add(term);
        termHits.set(themeId, hits);
      }
    }
    for (const symbol of symbols) {
      for (const [themeId, confidence] of this.membershipsBySymbol.get(symbol) || []) {
        scores.set(themeId, (scores.get(themeId) || 0) + Math.round(confidence * 0.5));
        const hits = symbolHits.get(themeId) || new Set<string>();
        hits.add(symbol);
        symbolHits.set(themeId, hits);
      }
    }
    return [...scores.entries()].flatMap(([themeId, rawScore]) => {
      const theme = this.themes.get(themeId);
      const score = Math.max(0, Math.min(100, rawScore));
      if (!theme || score < theme.matchThreshold) return [];
      return [{
        theme,
        score,
        matchedTerms: [...(termHits.get(themeId) || [])].sort(),
        matchedSymbols: [...(symbolHits.get(themeId) || [])].sort(),
      }];
    }).sort((left, right) => right.score - left.score || left.theme.id.localeCompare(right.theme.id));
  }

  salientFeatures(text: string, limit = 40): Array<[string, string]> {
    const normalized = normalizePhrase(text.replace(/https?:\/\/\S+/gi, ' '));
    const tokens = normalized.split(' ').filter(Boolean);
    const counts = new Map<string, { feature: [string, string]; count: number; first: number }>();
    let order = 0;
    const add = (type: string, value: string) => {
      const key = `${type}:${value}`;
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { feature: [type, value], count: 1, first: order++ });
    };
    for (const match of text.matchAll(HASHTAG_RE)) {
      const value = normalizePhrase(match[1]);
      if (value) add('hashtag', value);
    }
    for (const token of tokens) {
      if (token.length >= 5 && !this.candidateStopwords.has(token) && !/^\d+$/.test(token)) add('term', token);
    }
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      const left = tokens[index];
      const right = tokens[index + 1];
      if (left.length >= 4 && right.length >= 4 && !this.candidateStopwords.has(left) && !this.candidateStopwords.has(right)) {
        add('term', `${left} ${right}`);
      }
    }
    return [...counts.values()]
      .sort((left, right) => right.count - left.count || left.first - right.first)
      .slice(0, limit)
      .map((entry) => entry.feature);
  }
}

export async function loadOntologyCatalog(database: Database): Promise<OntologyCatalog> {
  const [themeRows, terms, memberships, lexicon, symbols, blacklisted] = await Promise.all([
    database.query<{ id: string; thesis_id: string | null; kind: string; name: string; description: string; match_threshold: number; auto_promote_sources: number }>(
      "select id, thesis_id, kind, name, description, match_threshold, auto_promote_sources from ontology_themes where status='active'",
    ),
    database.query<TermRow>("select theme_id, normalized_term, term_type, weight from ontology_terms where status='active'"),
    database.query<MembershipRow>("select m.symbol, m.theme_id, m.confidence from symbol_theme_memberships m join ontology_themes t on t.id=m.theme_id join symbols s on s.symbol=m.symbol where m.status='active' and t.status='active' and s.status<>'blacklisted'"),
    database.query<LexiconRow>("select token, token_type, weight from ontology_lexicon where status='active'"),
    database.query<{ symbol: string }>("select symbol from symbols where status in ('known','verified','active','public_comp')"),
    database.query<{ symbol: string }>("select symbol from symbols where status='blacklisted'"),
  ]);
  return new OntologyCatalog({
    themes: themeRows.map((row) => ({
      id: row.id,
      thesisId: row.thesis_id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      matchThreshold: Number(row.match_threshold),
      autoPromoteSources: Number(row.auto_promote_sources),
    })),
    terms,
    memberships,
    lexicon,
    symbols: symbols.map((row) => row.symbol),
    blacklistedSymbols: blacklisted.map((row) => row.symbol),
  });
}
