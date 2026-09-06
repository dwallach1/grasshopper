import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dashboardRoot = join(import.meta.dir, '..');

async function readDashboard(relative: string): Promise<string> {
  return readFile(join(dashboardRoot, relative), 'utf8');
}

describe('desk IA smoke', () => {
  test('chrome lands on Book; Home and Risk are gone as destinations', async () => {
    const app = await readDashboard('app/terminal/app.tsx');
    const book = await readDashboard('app/terminal/book-panel.tsx');
    const nav = await readDashboard('lib/desk-nav.ts');
    expect(app).toContain("surface === 'book'");
    expect(app).toContain("surface === 'events'");
    expect(app).toContain("surface === 'team'");
    expect(app).toContain('<BookPanel');
    expect(app).toContain('<TeamPanel');
    expect(app).toContain('LastRunChip');
    expect(app).not.toContain("surface === 'home'");
    expect(app).not.toContain("surface === 'risk'");
    expect(app).not.toContain('RiskPanel');
    expect(app).not.toContain('HomePanel');
    expect(app).not.toContain('RISK CONTROLS');
    expect(app).not.toContain('3 buys');
    expect(app).not.toContain('20%');
    expect(nav).toContain("id: 'book'");
    expect(nav).toContain("id: 'team'");
    expect(nav).toContain("href: '/team'");
    expect(nav).toContain("go: 'm'");
    expect(nav).toContain("href: '/'");
    expect(nav).not.toMatch(/id: 'home'/);
    expect(nav).not.toMatch(/id: 'risk'/);
    expect(nav).not.toMatch(/label: 'Home'/);
    expect(nav).not.toMatch(/label: 'Risk'/);
    expect(nav).not.toMatch(/Polymarket/);
    expect(app).toContain('VenueFilterBar');
    expect(book).toContain('VenueFilterBar');
  });

  test('product chrome is GRASSHOPPER; venue shorts are STOCKS / PREDICTIONS', async () => {
    const app = await readDashboard('app/terminal/app.tsx');
    const shell = await readDashboard('app/terminal/public-shell.tsx');
    const signIn = await readDashboard('app/auth/sign-in.tsx');
    const layout = await readDashboard('app/layout.tsx');
    const venue = await readDashboard('lib/desk-venue.ts');
    const chips = await readDashboard('app/terminal/venue-filter.tsx');
    const tests = await readDashboard('app/terminal/backtests-panel.tsx');
    expect(app).toMatch(/term-brand[\s\S]{0,180}GRASSHOPPER\s*<\/a>/);
    expect(app).not.toMatch(/term-brand[\s\S]{0,180}QUANTANAMO/);
    expect(app).toContain('no QUANTANAMO run');
    expect(shell).toContain('>GRASSHOPPER<');
    expect(signIn).toContain('>GRASSHOPPER<');
    expect(layout).toContain("title: 'Grasshopper'");
    expect(venue).toContain("short: 'STOCKS'");
    expect(venue).toContain("short: 'PREDICTIONS'");
    expect(venue).toContain("label: 'STOCKS'");
    expect(venue).toContain("label: 'PREDICTIONS'");
    expect(venue).toContain("? 'ODDSBORNE' : 'QUANTANAMO'");
    expect(venue).toContain("? 'PREDICTIONS' : 'STOCKS'");
    expect(chips).toContain('venueShort(venue)');
    expect(chips).not.toContain("'EQ'");
    expect(chips).not.toContain("'PM'");
    expect(tests).toContain('term-tests-cards');
    expect(tests).toContain('term-test-card');
    expect(tests).toContain('term-test-trades-cards');
    const team = await readDashboard('app/terminal/team-panel.tsx');
    const avatars = await readDashboard('app/terminal/team-avatars.tsx');
    const css = await readDashboard('app/globals.css');
    expect(team).toContain('desk_agents');
    expect(team).toContain('TeamAvatar');
    expect(team).not.toContain('pnl');
    expect(avatars).toContain('GrasshopperMark');
    expect(avatars).toContain('QuantMark');
    expect(avatars).toContain('OddsMark');
    expect(avatars).toContain('BanditMark');
    expect(team).toContain('cards.map');
    expect(avatars).not.toContain('from \'three\'');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('term-team-avatar');
  });

  test('Book diagnostic is table-first and not a spinning cluster', async () => {
    const book = await readDashboard('app/terminal/book-panel.tsx');
    const app = await readDashboard('app/terminal/app.tsx');
    const ribbon = await readDashboard('app/terminal/book-nav-ribbon.tsx');
    expect(book).toContain('<BookTable');
    expect(book).toContain('<BookDiagnostic');
    expect(book.indexOf('<BookTable')).toBeLessThan(book.indexOf('<BookDiagnostic'));
    expect(book).toContain('table is canonical');
    expect(book).not.toContain('BookExploded');
    expect(book).not.toContain('cluster.rotation');
    expect(app).not.toContain('BookExploded');
    expect(app).not.toContain('from \'three\'');
    expect(app).toContain("from './team-panel'");
    expect(ribbon).not.toContain('rotation.y');
    expect(ribbon).toContain('OrthographicCamera');
  });
});
