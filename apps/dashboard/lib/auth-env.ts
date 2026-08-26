import { fallbackDeskAuthMethods, parseDeskAuthMethods, GoTrueSettingsSchema, type DeskAuthMethods } from './auth-methods';
import { loadRootEnvLocal } from '../load-root-env';
import {
  isPublishableKey,
  oauthProviderIdsFromEnv,
  publicPublishableKeyFromEnv,
  publicSupabaseUrlFromEnv,
  type OAuthProviderId,
} from './auth-public';

export type { OAuthProviderId };
export { isPublishableKey };
export type { DeskAuthMethods };

export async function loadDeskAuthMethods(): Promise<DeskAuthMethods> {
  const preferred = oauthProviderIds();
  try {
    const response = await fetch(`${publicSupabaseUrl()}/auth/v1/settings`, {
      headers: {
        apikey: publicPublishableKey(),
        Authorization: `Bearer ${publicPublishableKey()}`,
      },
      cache: 'no-store',
    });
    if (!response.ok) return fallbackDeskAuthMethods();
    const parsed = GoTrueSettingsSchema.safeParse(await response.json());
    if (!parsed.success) return fallbackDeskAuthMethods();
    return parseDeskAuthMethods(parsed.data, preferred);
  } catch {
    return fallbackDeskAuthMethods();
  }
}

export function publicSupabaseUrl(): string {
  loadRootEnvLocal();
  try {
    return publicSupabaseUrlFromEnv();
  } catch {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!url) {
      throw new Error('Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) in the repo-root .env.local.');
    }
    return url;
  }
}

export function publicPublishableKey(): string {
  loadRootEnvLocal();
  try {
    return publicPublishableKeyFromEnv();
  } catch {
    const key = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
    if (!key) {
      throw new Error(
        'Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (project publishable/anon key) in the repo-root .env.local.',
      );
    }
    if (!isPublishableKey(key)) {
      throw new Error(
        'Publishable/anon key required; never put service_role in NEXT_PUBLIC_* or the browser client.',
      );
    }
    return key;
  }
}

export function oauthProviderIds(): OAuthProviderId[] {
  loadRootEnvLocal();
  return oauthProviderIdsFromEnv();
}

export function userRestHeaders(accessToken: string): HeadersInit {
  const publishable = publicPublishableKey();
  return {
    apikey: publishable,
    Authorization: `Bearer ${accessToken}`,
  };
}
