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

  test('ontology review RPC is an invoker wrapper over a private definer', async () => {
    const sql = await readFile(join(schemaDir, '07_ontology_review.sql'), 'utf8');
    expect(functionBlock(sql, 'public.review_ontology_candidate(')).toContain('security invoker');
    expect(functionBlock(sql, 'private.review_ontology_candidate(')).toContain('security definer');
    expect(sql).toContain("grant execute on function public.review_ontology_candidate");
    expect(sql).not.toMatch(/grant execute on function public\.review_ontology_candidate[\s\S]*to anon/);
    expect(sql).toContain("entity_type in ('theme', 'symbol', 'candidate')");
    expect(sql).toContain("'reject', 'merge'");
    expect(functionBlock(sql, 'public.reject_junk_ontology_candidates()')).toContain('security invoker');
    expect(functionBlock(sql, 'private.reject_junk_ontology_candidates()')).toContain('security definer');
    expect(sql).toContain('junk_deny_list');
    expect(sql).toContain("'stock', 'stocks', 'price', 'results', 'popular'");
    expect(sql).toContain("'by', 'in', 'from', 'where', 'select', 'order'");
    expect(sql).toContain("'arr', 'pt', 'cpu', 'mw', 'llc'");
    expect(sql).toContain("'another', 'files', 'github'");
    expect(sql).toContain("'since', 'literally', 'called'");
    expect(sql).toContain("'awaited quarters', 'logo link'");
    expect(sql).toContain("'further', 'directly', 'phase'");
    expect(sql).toContain("'saml', 'sso', 'scim'");
    expect(sql).toContain("'cuda', 'skhy'");
    expect(sql).toContain("v ~ '^[a-z]{2,5}( [a-z]{2,5})+$'");
    expect(sql).toContain("grant execute on function public.reject_junk_ontology_candidates");
    expect(sql).not.toMatch(/grant execute on function public\.reject_junk_ontology_candidates[\s\S]*to anon/);
    expect(functionBlock(sql, 'private.ontology_theme_thesis_alias(')).toContain('security invoker');
    expect(sql).toContain("when 'neocloud' then 'neocloud_compute'");
    expect(sql).toContain("when 'earnings_events' then 'earnings_gap_structure'");
    expect(sql).not.toMatch(/when 'ipo_events' then/);
    expect(sql).not.toMatch(/grant execute on function private\.ontology_theme_thesis_alias[\s\S]*to anon/);
  });

  test('lesson incorporate RPC is an invoker wrapper over a private definer', async () => {
    const sql = await readFile(join(schemaDir, '09_lesson_incorporate.sql'), 'utf8');
    expect(functionBlock(sql, 'public.incorporate_research_lesson(')).toContain('security invoker');
    expect(functionBlock(sql, 'private.incorporate_research_lesson(')).toContain('security definer');
    expect(sql).toContain("grant execute on function public.incorporate_research_lesson");
    expect(sql).not.toMatch(/grant execute on function public\.incorporate_research_lesson[\s\S]*to anon/);
    expect(sql).toContain("'source', 'operator_incorporate'");
    expect(sql).toContain("meta->>'kind', '') = 'playbook_rule'");
    expect(sql).toContain('belief_updates_playbook_lesson_idx');
  });
});

const supabaseReady = await isSupabaseReady();

describe.skipIf(!supabaseReady)('ontology theme thesis alias', () => {
  test('Postgres resolves documented aliases and leaves ipo_events unmapped', async () => {
    const present = await withDatabase(LOCAL.databaseUrl, (database) =>
      database.query<{ ok: boolean }>(
        "select to_regprocedure('private.ontology_theme_thesis_alias(text)') is not null as ok",
      ),
    );
    if (!present[0]?.ok) {
      throw new Error('private.ontology_theme_thesis_alias is missing — apply 20260914234500_ontology_theme_thesis_alias');
    }
    const rows = await withDatabase(LOCAL.databaseUrl, (database) =>
      database.query<{ theme_id: string; alias: string | null }>(`
        select x.theme_id, private.ontology_theme_thesis_alias(x.theme_id) as alias
        from (values
          ('neocloud'),
          ('nuclear'),
          ('ai_power'),
          ('photonics'),
          ('crypto_ai'),
          ('earnings_events'),
          ('ipo_events')
        ) as x(theme_id)
      `),
    );
    expect(Object.fromEntries(rows.map((row) => [row.theme_id, row.alias]))).toEqual({
      neocloud: 'neocloud_compute',
      nuclear: 'ai_power_nuclear',
      ai_power: 'ai_power_nuclear',
      photonics: 'semis_photonics',
      crypto_ai: 'crypto',
      earnings_events: 'earnings_gap_structure',
      ipo_events: null,
    });
  });
});

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
