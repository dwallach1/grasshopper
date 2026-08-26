/**
 * Desk surfaces. Tab switches must not remount this shell or refetch the ledger.
 *
 * Investigated cause of multi-second lag: each tab was its own App Router page
 * (`app/page.tsx`, `app/book/page.tsx`, …) default-exporting `TerminalPage`,
 * which `await loadDesk()` (~30 PostgREST calls) and remounted `TerminalApp`.
 * `<Link>` / `router.push` therefore paid a full RSC + ledger waterfall per tab.
 * Chrome now lives in `app/(desk)/layout.tsx`; tab changes paint from in-memory
 * state and `history.pushState` without waiting on the server.
 */

export const DESK_SURFACES = [
  'home',
  'book',
  'theses',
  'runs',
  'backtests',
  'catalysts',
  'learnings',
  'ontology',
  'risk',
] as const;

export type DeskSurface = (typeof DESK_SURFACES)[number];

export type DeskTab = {
  href: string;
  id: DeskSurface;
  key: string;
  label: string;
  go: string;
};

export const DESK_TABS: readonly DeskTab[] = [
  { href: '/', id: 'home', key: '1', label: 'Home', go: 'h' },
  { href: '/book', id: 'book', key: '2', label: 'Book', go: 'b' },
  { href: '/theses', id: 'theses', key: '3', label: 'Theses', go: 't' },
  { href: '/runs', id: 'runs', key: '4', label: 'Runs', go: 'r' },
  { href: '/backtests', id: 'backtests', key: '5', label: 'Tests', go: 'e' },
  { href: '/catalysts', id: 'catalysts', key: '6', label: 'Catalysts', go: 'c' },
  { href: '/learnings', id: 'learnings', key: '7', label: 'Lessons', go: 'l' },
  { href: '/ontology', id: 'ontology', key: '8', label: 'Ontology', go: 'o' },
  { href: '/risk', id: 'risk', key: '9', label: 'Risk', go: 'i' },
] as const;

/** Extra go-letter aliases that must not collide with `r` refresh when un-prefixed. */
const GO_ALIASES: Record<string, DeskSurface> = {
  m: 'home',
  k: 'backtests',
};

export function surfaceFromPath(pathname: string): DeskSurface {
  if (pathname === '/') return 'home';
  const head = pathname.replace(/^\//, '').split('/')[0] || 'home';
  const match = DESK_TABS.find((tab) => tab.id === head || tab.href === `/${head}`);
  return match?.id ?? 'home';
}

export function tabForSurface(id: DeskSurface): DeskTab {
  const tab = DESK_TABS.find((item) => item.id === id);
  if (!tab) throw new Error(`Unknown desk surface ${id}`);
  return tab;
}

export function surfaceFromGoLetter(letter: string): DeskSurface | null {
  const direct = DESK_TABS.find((tab) => tab.go === letter);
  if (direct) return direct.id;
  return GO_ALIASES[letter] ?? null;
}

export function hrefForSurface(id: DeskSurface): string {
  return tabForSurface(id).href;
}
