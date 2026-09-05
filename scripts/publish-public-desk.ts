#!/usr/bin/env bun
/**
 * Build the public phone-desk snapshot from the live ledger (server-side only).
 * Never invent marks or P/L — loadDesk is the same assembler as the operator desk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { isPublicSnapshot, toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { loadDeskFromPostgres } from '../apps/dashboard/lib/ledger';
import { hasDatabaseUrl, openSql } from '../apps/dashboard/lib/postgres';
import { loadRootEnvLocal } from '../apps/dashboard/load-root-env';

loadRootEnvLocal();

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const defaultOut = resolve(process.cwd(), 'workers/desk/.data/current.json');
const outPath = resolve(argValue('--out') || process.env.PUBLIC_DESK_SNAPSHOT_PATH || defaultOut);
const publishUrl = (argValue('--push') || process.env.DESK_PUBLISH_URL || '').trim();
const publishToken = (process.env.DESK_PUBLISH_TOKEN || '').trim();
const writeLedger = !hasFlag('--no-ledger');

if (!hasDatabaseUrl()) {
  console.error('Publisher requires QUANTANAMO_DATABASE_URL (server-only).');
  process.exit(1);
}

const live = await loadDeskFromPostgres();
const snapshot = toPublicDeskSnapshot({
  ...live,
  source: 'postgres',
});

if (!isPublicSnapshot(snapshot)) {
  console.error('Publisher refused to write a non-snapshot payload.');
  process.exit(1);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(snapshot)}\n`);
console.error(`Wrote ${outPath} generated_at=${snapshot.generated_at}`);

if (writeLedger) {
  const sql = openSql();
  try {
    await sql`
      insert into public.dashboard_snapshots(id, generated_at, payload)
      values ('public', ${snapshot.generated_at}, ${sql.json(snapshot as never)})
      on conflict (id) do update
      set generated_at = excluded.generated_at,
          payload = excluded.payload
    `;
    console.error('Recorded dashboard_snapshots.id=public (Worker still serves KV, not PostgREST).');
  } catch (error) {
    console.error(JSON.stringify({
      event: 'desk_publish_ledger_audit_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (publishUrl) {
  if (!publishToken) {
    console.error('DESK_PUBLISH_TOKEN is required with --push / DESK_PUBLISH_URL.');
    process.exit(1);
  }
  // Accept base Worker URL or full /internal/snapshot path.
  const pushTarget = /\/internal\/snapshot\/?$/.test(publishUrl.replace(/\/+$/, ''))
    ? publishUrl.replace(/\/+$/, '')
    : `${publishUrl.replace(/\/+$/, '')}/internal/snapshot`;
  const response = await fetch(pushTarget, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${publishToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) {
    console.error(`Publish push failed (${response.status}).`);
    process.exit(1);
  }
  console.error(`Pushed snapshot to ${publishUrl}`);
}
