import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { withDatabase } from '../../workers/knowledge/src/database';
import { LOCAL } from './env';
import { isSupabaseReady } from './harness';

const schemaDir = join(import.meta.dir, '../../supabase/schemas');

function functionBlock(sql: string, signature: string): string {
  const start = sql.indexOf(`create or replace function ${signature}`);
  expect(start).toBeGreaterThan(-1);
  const next = sql.indexOf('create or replace function', start + 1);
  return next === -1 ? sql.slice(start) : sql.slice(start, next);
}

describe('exposed SECURITY DEFINER RPCs', () => {
  test('declarative schema drops the anon ontology write RPC', async () => {
    const sql = await readFile(join(schemaDir, '02_worker_access.sql'), 'utf8');
    expect(sql).toContain('drop function if exists public.manage_ontology_entity(text, text, text)');
    expect(sql).not.toMatch(/grant execute on function public\.manage_ontology_entity/);
  });

  test('public operator RPCs are invoker wrappers over private definers', async () => {
    const sql = await readFile(join(schemaDir, '03_ledger_operators.sql'), 'utf8');
    expect(functionBlock(sql, 'public.claim_ledger_operator()')).toContain('security invoker');
    expect(functionBlock(sql, 'public.is_ledger_operator()')).toContain('security invoker');
    expect(functionBlock(sql, 'private.is_ledger_operator()')).toContain('security definer');
    expect(functionBlock(sql, 'private.claim_first_ledger_operator()')).toContain('security definer');
  });
});

const supabaseReady = await isSupabaseReady();

describe.skipIf(!supabaseReady)('local rpc grants', () => {
  test('anon cannot call the retired ontology write RPC', async () => {
    const response = await fetch(`${LOCAL.supabaseUrl}/rest/v1/rpc/manage_ontology_entity`, {
      method: 'POST',
      headers: {
        apikey: LOCAL.anonKey,
        authorization: `Bearer ${LOCAL.anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_entity_type: 'theme',
        p_entity_key: 'x',
        p_action: 'promote',
      }),
    });
    expect(response.ok).toBe(false);
    expect([401, 404]).toContain(response.status);
  });

  test('public operator helpers are not security definer', async () => {
    const rows = await withDatabase(LOCAL.databaseUrl, (database) =>
      database.query<{ proname: string; prosecdef: boolean }>(
        `select p.proname, p.prosecdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('claim_ledger_operator', 'is_ledger_operator')
         order by p.proname`,
      ),
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.prosecdef).toBe(false);
    }
  });
});
