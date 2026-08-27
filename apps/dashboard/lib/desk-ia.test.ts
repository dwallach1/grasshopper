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
    const nav = await readDashboard('lib/desk-nav.ts');
    expect(app).toContain("surface === 'book'");
    expect(app).toContain("surface === 'events'");
    expect(app).toContain('<BookPanel');
    expect(app).toContain('LastRunChip');
    expect(app).not.toContain("surface === 'home'");
    expect(app).not.toContain("surface === 'risk'");
    expect(app).not.toContain('RiskPanel');
    expect(app).not.toContain('HomePanel');
    expect(app).not.toContain('RISK CONTROLS');
    expect(app).not.toContain('3 buys');
    expect(app).not.toContain('20%');
    expect(nav).toContain("id: 'book'");
    expect(nav).toContain("href: '/'");
    expect(nav).not.toMatch(/id: 'home'/);
    expect(nav).not.toMatch(/id: 'risk'/);
    expect(nav).not.toMatch(/label: 'Home'/);
    expect(nav).not.toMatch(/label: 'Risk'/);
  });

  test('exploded viz is Book-only and table-first', async () => {
    const book = await readDashboard('app/terminal/book-panel.tsx');
    const app = await readDashboard('app/terminal/app.tsx');
    const theses = await readDashboard('app/terminal/app.tsx');
    expect(book).toContain('<BookTable');
    expect(book.indexOf('<BookTable')).toBeLessThan(book.indexOf('<BookExploded'));
    expect(book).toContain('table is canonical');
    expect(app).not.toContain('BookExploded');
    expect(theses).not.toContain('book-exploded');
    expect(theses).not.toContain('from \'three\'');
  });
});
