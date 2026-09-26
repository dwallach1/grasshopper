import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

describe('steward entry scripts (stewards/)', () => {
  test.skipIf(!python)('compile, contract and credential checks pass', () => {
    const run = spawnSync(python!, ['-m', 'unittest', 'discover', '-s', 'stewards', '-p', 'test_*.py'], {
      cwd: root, encoding: 'utf8',
    });
    expect(run.stderr).toContain('OK');
    expect(run.status).toBe(0);
  });
});
