const DEFAULT_OAUTH = ['github', 'google'] as const;

export type OAuthProviderId = (typeof DEFAULT_OAUTH)[number] | 'azure' | 'apple' | 'gitlab' | 'bitbucket';

/** Reject service-role material accidentally published as NEXT_PUBLIC_*. */
export function isPublishableKey(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('sb_secret_')) return false;
  if (trimmed.startsWith('sb_publishable_')) return true;
  if (!trimmed.startsWith('eyJ')) return false;
  const payloadPart = trimmed.split('.')[1];
  if (!payloadPart) return false;
  try {
    const json = atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'));
    return /"role"\s*:\s*"anon"/.test(json);
  } catch {
    return false;
  }
}

export function publicSupabaseUrlFromEnv(): string {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/$/, '');
  if (!url) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL in the repo-root .env.local.');
  }
  return url;
}

export function publicPublishableKeyFromEnv(): string {
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  if (!key) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the repo-root .env.local.');
  }
  if (!isPublishableKey(key)) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be the publishable/anon key, never service_role.',
    );
  }
  return key;
}

export function oauthProviderIdsFromEnv(): OAuthProviderId[] {
  const raw = process.env.NEXT_PUBLIC_AUTH_OAUTH_PROVIDERS?.trim();
  if (!raw) return [...DEFAULT_OAUTH];
  const parsed: OAuthProviderId[] = [];
  for (const item of raw.split(',')) {
    const id = parseOAuthProviderId(item.trim().toLowerCase());
    if (id) parsed.push(id);
  }
  return parsed.length > 0 ? parsed : [...DEFAULT_OAUTH];
}

function parseOAuthProviderId(value: string): OAuthProviderId | null {
  if (value === 'github') return 'github';
  if (value === 'google') return 'google';
  if (value === 'azure') return 'azure';
  if (value === 'apple') return 'apple';
  if (value === 'gitlab') return 'gitlab';
  if (value === 'bitbucket') return 'bitbucket';
  return null;
}
