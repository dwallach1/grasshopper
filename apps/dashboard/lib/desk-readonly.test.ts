import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LEDGER_WRITE_RETIRED } from './retired-write';

const dashboardRoot = join(import.meta.dir, '..');

async function readDashboard(relative: string): Promise<string> {
  return readFile(join(dashboardRoot, relative), 'utf8');
}

describe('read-only operator desk', () => {
  test('client chrome has no thesis status, evidence, lesson, or mark write path', async () => {
    const app = await readDashboard('app/terminal/app.tsx');
    expect(app).not.toContain('/api/ledger/thesis');
    expect(app).not.toContain('/api/ledger/evidence');
    expect(app).not.toContain('/api/ledger/lesson');
    expect(app).not.toContain('/api/ledger/run');
    expect(app).not.toContain('updateThesisStatus');
    expect(app).not.toContain('appendThesisEvidence');
    expect(app).not.toContain('appendLesson');
    expect(app).not.toContain('Mark on ledger');
    expect(app).not.toContain('Set status');
    expect(app).not.toContain('postJson');
    expect(app).not.toMatch(/Status →/);
    expect(app).not.toContain('Append evidence');
    expect(app).not.toContain('Append a lesson');
  });

  test('ledger mutation routes are gone and do not post', async () => {
    const thesis = await readDashboard('app/api/ledger/thesis/route.ts');
    const evidence = await readDashboard('app/api/ledger/evidence/route.ts');
    const lesson = await readDashboard('app/api/ledger/lesson/route.ts');
    const run = await readDashboard('app/api/ledger/run/route.ts');
    const blob = [thesis, evidence, lesson, run].join('\n');
    expect(blob).toContain('retired-write');
    expect(blob).not.toContain('updateThesisStatus');
    expect(blob).not.toContain('appendThesisEvidence');
    expect(blob).not.toContain('appendLesson');
    expect(blob).not.toContain('appendOperatorRun');
    expect(blob).not.toContain("method: 'PATCH'");
    expect(blob).not.toContain("method: 'POST'");
    expect(LEDGER_WRITE_RETIRED).toContain('Read-only desk');
  });
});
