import postgres from 'postgres';

import { loadRootEnvLocal } from '../load-root-env';

export type Sql = postgres.Sql;

export function restAuthHeaders(): HeadersInit {
  loadRootEnvLocal();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error(
      'Supabase is not configured. Set QUANTANAMO_DATABASE_URL or SUPABASE_SECRET_KEY in the repo-root .env.local.',
    );
  }
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
  };
}

export function supabaseUrl(): string {
  loadRootEnvLocal();
  const url = process.env.SUPABASE_URL?.trim();
  if (url) return url.replace(/\/$/, '');
  const databaseUrl = process.env.QUANTANAMO_DATABASE_URL?.trim();
  if (databaseUrl) {
    const match = databaseUrl.match(/\/\/[^./]*\.([a-z0-9]+):/i);
    if (match?.[1]) return `https://${match[1]}.supabase.co`;
  }
  throw new Error('SUPABASE_URL is not configured');
}

export function openSql(): Sql {
  loadRootEnvLocal();
  const databaseUrl = process.env.QUANTANAMO_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('QUANTANAMO_DATABASE_URL is not configured');
  }
  return postgres(databaseUrl, {
    max: 4,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    ssl: 'require',
  });
}

export function hasDatabaseUrl(): boolean {
  loadRootEnvLocal();
  return Boolean(process.env.QUANTANAMO_DATABASE_URL?.trim());
}

export function hasSecretKey(): boolean {
  loadRootEnvLocal();
  return Boolean(process.env.SUPABASE_SECRET_KEY?.trim());
}

/** Table GRANT/RLS failures from postgres.js (`42501`). */
export function isPostgresPermissionDenied(message: string): boolean {
  return /permission denied for (table|relation)/i.test(message);
}

/** Local / older ledgers may not have GRASSHOPPER `pm_*` or `meme_*` tables yet (`42P01`). */
export function isPostgresUndefinedRelation(message: string): boolean {
  return /relation .+ does not exist/i.test(message);
}
