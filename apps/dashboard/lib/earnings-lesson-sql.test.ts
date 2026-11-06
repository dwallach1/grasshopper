import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const schema = join(root, 'supabase/schemas/95_earnings_print_incorporated.sql');
const migration = join(root, 'supabase/migrations/20261106183000_earnings_print_incorporated.sql');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out);
    else if (/\.(sql|ts|py)$/.test(name) && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('earnings print lessons', () => {
  test('schema file is the migration, and the writer incorporates after the belief', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    const fnStart = sql.indexOf('create or replace function public.steward_record_earnings_lesson');
    const fnEnd = sql.indexOf('comment on function public.steward_record_earnings_lesson');
    const fn = sql.slice(fnStart, fnEnd);
    const beliefAt = fn.indexOf('insert into public.belief_updates');
    expect(beliefAt).toBeGreaterThan(0);
    expect(fn.indexOf('set incorporated = true', beliefAt)).toBeGreaterThan(beliefAt);
    expect(fn).toContain("'replayed', true, 'incorporated', true");
    expect(fn).toContain('v_thesis, null, null, v_summary');
    expect(fn).toContain("'confidence_delta', 0");
    expect(fn).not.toContain('playbook_rule');
    expect(fn).not.toContain('steward_sizing_guidance');
    expect(fn).not.toContain('edge_max_stake');
    for (const match of fn.matchAll(/insert into public\.research_(?:cycles|lessons) \(([^)]*)\)/g)) {
      const cols = match[1].split(',').map((col) => col.trim());
      expect(cols).not.toContain('id');
    }
  });

  test('backfill counts bound earnings_print lessons, then marks only those', () => {
    const sql = readFileSync(schema, 'utf8');
    const listed = sql.indexOf('create temporary table earnings_print_to_incorporate');
    const notice = sql.indexOf('about to be incorporated');
    const update = sql.indexOf('update public.research_lessons l\nset incorporated = true');
    expect(listed).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(listed);
    expect(update).toBeGreaterThan(notice);
    const predicate = sql.slice(listed, notice);
    expect(predicate).toContain("l.lesson_type = 'earnings_print'");
    expect(predicate).toContain('l.incorporated is distinct from true');
    expect(predicate).toContain("b.meta->>'kind' = 'earnings_print'");
    expect(predicate).toContain("b.meta->>'research_lesson_id' = l.id::text");
    expect(predicate).toContain("c.external_key = 'earnings-print:' || (b.meta->>'lot_id')");
    expect(predicate).not.toContain("lesson_type = 'structure'");
    expect(predicate).not.toContain("lesson_type = 'missed_swing'");
    expect(sql).toContain('where id in (196, 229)');
  });

  test('sequence lag is a watchdog column and does not call setval', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(sql).toContain('as research_id_sequences');
    expect(sql).toContain('public.research_id_sequence_state');
    expect(sql).toContain('v_last < v_max');
    expect(sql).toContain('v_called is not true and v_last <= v_max');
    expect(sql).toContain('grant select on sequence public.research_cycles_id_seq, public.research_lessons_id_seq');
    expect(sql).not.toContain('setval(');
    expect(sql).toContain('does not make /api/health not-ok');
    expect(sql).not.toContain('create or replace function public.steward_close_lesson');
  });

  test('no remaining insert supplies an explicit research cycle or lesson id', () => {
    const roots = ['supabase', 'workers', 'stewards', 'apps'].map((dir) => join(root, dir));
    const hits: string[] = [];
    const insert = /insert\s+into\s+(?:public\.)?research_(?:cycles|lessons)\s*\(([^)]*)\)/gi;
    for (const dir of roots) {
      for (const path of walk(dir)) {
        const text = readFileSync(path, 'utf8');
        if (/overriding\s+system\s+value/i.test(text) && /research_(?:cycles|lessons)/i.test(text)) {
          hits.push(`${path}: overriding system value`);
        }
        for (const match of text.matchAll(insert)) {
          const cols = match[1].split(',').map((col) => col.trim().replace(/"/g, ''));
          if (cols.includes('id')) hits.push(`${path}: ${match[0].slice(0, 120)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
