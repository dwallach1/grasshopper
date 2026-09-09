import {
  DESK_PUBLIC_READER_ROLE,
  isPublicSnapshot,
  toPublicDeskSnapshot,
} from '@quantanamo/contracts/desk-snapshot';
import { isPublishableKey } from '../../../apps/dashboard/lib/auth-public';
import { loadDeskFromRest } from '../../../apps/dashboard/lib/ledger-live';

export type DeskReaderEnv = {
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
};

export function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = JSON.parse(atob(padded + pad)) as { role?: unknown };
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}

export function liveReaderReady(env: DeskReaderEnv): boolean {
  const url = env.DESK_SUPABASE_URL?.trim() || '';
  const apiKey = env.DESK_READER_APIKEY?.trim() || '';
  const jwt = env.DESK_READER_JWT?.trim() || '';
  if (!url || !apiKey || !jwt) return false;
  if (!isPublishableKey(apiKey)) {
    console.error(JSON.stringify({ event: 'desk_reader_apikey_rejected' }));
    return false;
  }
  const role = jwtRole(jwt);
  if (role !== DESK_PUBLIC_READER_ROLE) {
    console.error(JSON.stringify({ event: 'desk_reader_jwt_rejected', role: role || 'missing' }));
    return false;
  }
  return true;
}

export async function loadPublicDeskLive(env: DeskReaderEnv): Promise<unknown> {
  const supabaseUrl = env.DESK_SUPABASE_URL?.trim() || '';
  const apiKey = env.DESK_READER_APIKEY?.trim() || '';
  const accessToken = env.DESK_READER_JWT?.trim() || '';
  if (!liveReaderReady(env) || !supabaseUrl || !apiKey || !accessToken) {
    throw new Error('desk_reader_unconfigured');
  }
  const live = await loadDeskFromRest({
    supabaseUrl,
    apiKey,
    accessToken,
  });
  const published = toPublicDeskSnapshot({
    ...live,
    source: 'postgrest',
  });
  if (!isPublicSnapshot(published)) {
    throw new Error('desk_live_rejected');
  }
  return published;
}
