/**
 * Desk surfaces. Tab switches must not remount this shell or refetch the ledger.
 *
 * Board (`/`) is home. Book lives at `/book`. Chrome stays mounted; tab changes
 * paint from in-memory state and `history.pushState`.
 * Keep README.md "Local desk" in the same PR when this list changes.
 */

export const DESK_SURFACES = [
  'leaderboard',
  'book',
  'theses',
  'events',
  'backtests',
  'team',
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
  { href: '/', id: 'leaderboard', key: '1', label: 'Board', go: 'p' },
  { href: '/book', id: 'book', key: '2', label: 'Book', go: 'b' },
  { href: '/theses', id: 'theses', key: '3', label: 'Theses', go: 't' },
  { href: '/events', id: 'events', key: '4', label: 'Events', go: 'c' },
  { href: '/backtests', id: 'backtests', key: '5', label: 'Tests', go: 'e' },
  { href: '/team', id: 'team', key: '6', label: 'Team', go: 'm' },
] as const;

/** Old bookmarks → current surfaces. Keep chrome mounted; do not 404. */
export type DeskPathRedirect = {
  source: string;
  destination: string;
};

export const DESK_PATH_REDIRECTS = [
  { source: '/leaderboard', destination: '/' },
  { source: '/board', destination: '/' },
  { source: '/ranks', destination: '/' },
  { source: '/catalysts', destination: '/events' },
  { source: '/ontology', destination: '/theses' },
  { source: '/risk', destination: '/book' },
  { source: '/runs', destination: '/book' },
  { source: '/learnings', destination: '/theses' },
  { source: '/mates', destination: '/team' },
] as const satisfies readonly DeskPathRedirect[];

function surfaceFromHead(head: string): DeskSurface {
  switch (head) {
    case '':
    case 'leaderboard':
    case 'board':
    case 'ranks':
    case 'home':
      return 'leaderboard';
    case 'book':
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
    case 'team':
    case 'mates':
      return 'team';
    default:
      return 'leaderboard';
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
      return 'leaderboard';
    case 'i':
      return 'book';
    case 'k':
      return 'backtests';
    case 'l':
    case 'o':
      return 'theses';
    case 'a':
      return 'team';
    case 'd':
    case 'n':
      return 'leaderboard';
    default:
      return null;
  }
}

export function hrefForSurface(id: DeskSurface): string {
  return tabForSurface(id).href;
}
