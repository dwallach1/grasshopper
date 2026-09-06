#!/usr/bin/env bun
/**
 * Build the public phone-desk snapshot from the live ledger (server-side only).
 * Never invent marks or P/L — loadDesk is the same assembler as the operator desk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { isPublicSnapshot, toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { loadDeskFromPostgres } from '../apps/dashboard/lib/ledger';
import { emptyMemeCoins } from '../apps/dashboard/lib/meme-book';
import { hasDatabaseUrl, openSql, type Sql } from '../apps/dashboard/lib/postgres';
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

const MEME_PUBLISH_TABLES = [
  'meme_tokens',
  'meme_orders',
  'meme_positions',
  'meme_fills',
  'meme_pnl',
  'meme_notes',
] as const;

async function assertMemeCoinsVisible(
  sql: Sql,
  meme: { tokens: unknown[]; positions: unknown[]; fills: unknown[] } | undefined,
): Promise<void> {
  const present = await sql`select to_regclass('public.meme_tokens') is not null as ok`;
  if (!present[0]?.ok) return;

  const policies = await sql`
    select count(*)::int as n
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'meme_tokens', 'meme_orders', 'meme_positions',
        'meme_fills', 'meme_pnl', 'meme_notes'
      )
      and policyname = 'quantanamo_worker_select'
  `;
  const policyCount = Number(policies[0]?.n ?? 0);
  if (policyCount < MEME_PUBLISH_TABLES.length) {
    console.error(JSON.stringify({
      event: 'desk_publish_meme_rls_missing',
      policies: policyCount,
      expected: MEME_PUBLISH_TABLES.length,
      error: 'meme_* tables exist but quantanamo_worker_select RLS is missing; GRANT alone publishes empty meme_coins',
    }));
    process.exit(1);
  }

  const payload = meme ?? emptyMemeCoins();
  const payloadRows = payload.tokens.length + payload.positions.length + payload.fills.length;
  if (payloadRows > 0) return;

  const estimates = await sql`
    select coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint as n
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('meme_tokens', 'meme_positions', 'meme_fills')
  `;
  const estimated = Number(estimates[0]?.n ?? 0);
  if (estimated > 0) {
    console.error(JSON.stringify({
      event: 'desk_publish_meme_empty',
      estimated_rows: estimated,
      error: 'meme_* catalog estimates show rows but snapshot meme_coins is empty — check quantanamo_worker_select RLS',
    }));
    process.exit(1);
  }
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

const sql = openSql();
try {
  await assertMemeCoinsVisible(sql, (snapshot as { meme_coins?: { tokens: unknown[]; positions: unknown[]; fills: unknown[] } }).meme_coins);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(snapshot)}\n`);
  console.error(`Wrote ${outPath} generated_at=${snapshot.generated_at}`);

  if (writeLedger) {
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
    }
  }
} finally {
  await sql.end({ timeout: 5 });
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
