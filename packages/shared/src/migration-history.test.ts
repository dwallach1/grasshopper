import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const MIGRATIONS_DIR = join(import.meta.dir, '../../../supabase/migrations');
const VERSION_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;

/**
 * Hosted Quantanamo (`xqungxapqicdmboniezz`) `schema_migrations.version`
 * values. Supabase Preview fails when any of these are missing under
 * `supabase/migrations/`. Keep this list in lockstep with the live table.
 */
export const HOSTED_QUANTANAMO_VERSIONS = [
  '20260823210246',
  '20260823211638',
  '20260823232527',
  '20260824001613',
  '20260824002149',
  '20260824013000',
  '20260824014652',
  '20260824014810',
  '20260824135914',
  '20260824151531',
  '20260824155537',
  '20260824155917',
  '20260824160100',
  '20260824161753',
  '20260824162210',
  '20260824190000',
  '20260824191000',
  '20260824192000',
  '20260824193000',
  '20260824213344',
  '20260824213940',
  '20260824220726',
  '20260825003758',
  '20260825010000',
  '20260825030728',
  '20260825033905',
  '20260825220909',
  '20260826143713',
  '20260826172225',
  '20260826192532',
  '20260826193522',
  '20260826195412',
  '20260826215510',
  '20260826220041',
  '20260826225246',
  '20260827142807',
  '20260827163725',
  '20260905211716',
  '20260905211841',
  '20260905212429',
  '20260905215124',
  '20260905215845',
  '20260906132304',
  '20260906141553',
  '20260906150056',
  '20260906155358',
  '20260907135640',
  '20260908133548',
  '20260909134557',
] as const;

export function parseMigrationVersions(filenames: string[]): string[] {
  const versions: string[] = [];
  for (const name of filenames) {
    if (!name.endsWith('.sql')) {
      continue;
    }
    const match = VERSION_FILE.exec(name);
    if (!match) {
      throw new Error(`Migration filename is not {14-digit version}_{snake}.sql: ${name}`);
    }
    versions.push(match[1]);
  }
  const unique = new Set(versions);
  if (unique.size !== versions.length) {
    throw new Error('Duplicate migration versions in supabase/migrations');
  }
  return versions;
}

describe('supabase migration history', () => {
  test('parses unique version prefixes and covers hosted Quantanamo history', () => {
    const filenames = readdirSync(MIGRATIONS_DIR);
    const local = parseMigrationVersions(filenames);
    const hostedMissing = HOSTED_QUANTANAMO_VERSIONS.filter((version) => !local.includes(version));
    expect(hostedMissing).toEqual([]);
  });
});
