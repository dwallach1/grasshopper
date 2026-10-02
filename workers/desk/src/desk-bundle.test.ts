import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { describe, expect, test } from 'bun:test';

const require = createRequire(import.meta.url);

/**
 * Hebrew "string" from zod/v4/locales/he.js. esbuild keeps every Zod locale
 * when any reached file uses `import { z } from 'zod'`. Wrangler bundles with
 * esbuild, so that import made the 2026-10-01 grasshopper-desk script
 * 679 KiB (gzip 109 KiB) and a 30 ms startup. Cold JSON routes then hit
 * Cloudflare 1102. `import * as z from 'zod'` lets esbuild drop the catalogs.
 */
const HEBREW_STRING_LABEL = 'מחרוזת';

describe('public desk worker bundle', () => {
  test('esbuild leaves Zod locale catalogs out of the script', async () => {
    const wranglerPkg = require.resolve('wrangler/package.json');
    const esbuild = createRequire(wranglerPkg)('esbuild') as typeof import('esbuild');
    const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = await esbuild.build({
      absWorkingDir: workerRoot,
      entryPoints: ['src/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['worker', 'browser'],
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    const js = result.outputFiles?.[0]?.text ?? '';
    const gzip = gzipSync(Buffer.from(js)).byteLength;
    expect(js).not.toContain(HEBREW_STRING_LABEL);
    expect(js).not.toContain('\\u05de\\u05d7\\u05e8\\u05d5\\u05d6\\u05ea');
    // Locales put gzip near 85 KiB. Without them the script stays under 55 KiB.
    expect(gzip).toBeLessThan(55_000);
    expect(js.length).toBeGreaterThan(20_000);
  });
});
