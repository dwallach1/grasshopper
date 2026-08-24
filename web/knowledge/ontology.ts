import type { Database } from './database';

const CASHTAG_RE = /\$([A-Z][A-Z0-9.]{0,9})\b/g;
const UPPERCASE_RE = /\b[A-Z]{2,10}\b/g;

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
  direction: 'supporting' | 'contradicting' | 'neutral';
  evidenceExcerpt: string;
};

type TermRow = { theme_id: string; normalized_term: string; weight: number; term_type: string };
type MembershipRow = { symbol: string; theme_id: string; confidence: number };
type LexiconRow = { token: string; token_type: string; weight: number };

export function normalizePhrase(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/[^a-z0-9.-]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

  promptContext(): Array<{ id: string; kind: string; name: string; description: string; terms: string[] }> {
    return [...this.themes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((theme) => ({
        id: theme.id,
        kind: theme.kind,
        name: theme.name,
        description: theme.description,
        terms: [...(this.termsByTheme.get(theme.id)?.keys() || [])].sort().slice(0, 16),
      }));
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
