/**
 * Desk surfaces. Tab switches must not remount this shell or refetch the ledger.
 *
 * Investigated cause of multi-second lag: each tab was its own App Router page
 * (`app/page.tsx`, `app/book/page.tsx`, …) default-exporting `TerminalPage`,
 * which `await loadDesk()` (~30 PostgREST calls) and remounted `TerminalApp`.
 * `<Link>` / `router.push` therefore paid a full RSC + ledger waterfall per tab.
 * Chrome now lives in `app/(desk)/layout.tsx`; tab changes paint from in-memory
 * state and `history.pushState` without waiting on the server.
 * Keep README.md "Local desk" in the same PR when this list changes.
 */

export const DESK_SURFACES = [
  'book',
  'theses',
  'events',
  'backtests',
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
  { href: '/', id: 'book', key: '1', label: 'Book', go: 'b' },
  { href: '/theses', id: 'theses', key: '2', label: 'Theses', go: 't' },
  { href: '/events', id: 'events', key: '3', label: 'Events', go: 'c' },
  { href: '/backtests', id: 'backtests', key: '4', label: 'Tests', go: 'e' },
] as const;

/** Old bookmarks → current surfaces. Keep chrome mounted; do not 404. */
export type DeskPathRedirect = {
  source: string;
  destination: string;
};

export const DESK_PATH_REDIRECTS = [
  { source: '/book', destination: '/' },
  { source: '/catalysts', destination: '/events' },
  { source: '/ontology', destination: '/theses' },
  { source: '/risk', destination: '/' },
  { source: '/runs', destination: '/' },
  { source: '/learnings', destination: '/theses' },
] as const satisfies readonly DeskPathRedirect[];

function surfaceFromHead(head: string): DeskSurface {
  switch (head) {
    case '':
    case 'book':
    case 'home':
    case 'risk':
    case 'runs':
      return 'book';
    case 'theses':
    case 'ontology':
    case 'learnings':
      return 'theses';
    case 'events':
    case 'catalysts':
      return 'events';
    case 'backtests':
    case 'tests':
      return 'backtests';
    default:
      return 'book';
  }
}

export function canonicalDeskPath(pathname: string): string {
  const path = pathname.split('?')[0] || '/';
  const normalized = path === '' ? '/' : path.replace(/\/+$/, '') || '/';
  const hit = DESK_PATH_REDIRECTS.find((row) => row.source === normalized);
  return hit?.destination ?? normalized;
}

export function surfaceFromPath(pathname: string): DeskSurface {
  const canonical = canonicalDeskPath(pathname);
  const head = canonical.replace(/^\//, '').split('/')[0] || '';
  return surfaceFromHead(head);
}

export function tabForSurface(id: DeskSurface): DeskTab {
  const tab = DESK_TABS.find((item) => item.id === id);
  if (!tab) throw new Error(`Unknown desk surface ${id}`);
  return tab;
}

export function surfaceFromGoLetter(letter: string): DeskSurface | null {
  const direct = DESK_TABS.find((tab) => tab.go === letter);
  if (direct) return direct.id;
  switch (letter) {
    case 'h':
    case 'i':
      return 'book';
    case 'k':
      return 'backtests';
    case 'l':
    case 'o':
      return 'theses';
    default:
      return null;
  }
}

export function hrefForSurface(id: DeskSurface): string {
  return tabForSurface(id).href;
}
