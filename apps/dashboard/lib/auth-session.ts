import type { SupabaseClient } from '@supabase/supabase-js';

/** Auth-server lookups (getUser / HS256 getClaims) must not block the desk. */
export const AUTH_LOOKUP_MS = 2_000;

export type VerifiedAuth = {
  userId: string;
  email: string;
  accessToken: string;
};

/**
 * Resolve `work` or `null` after `ms`. Hung Auth round-trips must not stall `/`.
 */
export async function firstSettledOrTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const completed = work.then(
    (value) => ({ timedOut: false as const, value }),
    () => ({ timedOut: true as const }),
  );
  try {
    const winner = await Promise.race([completed, timedOut]);
    if (winner.timedOut) return null;
    return winner.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Local JWT verify via getClaims (asymmetric JWKS). HS256 still hits Auth;
 * either way the lookup is capped at AUTH_LOOKUP_MS. Identity comes from
 * `sub` and `email` claims.
 */
export async function verifyAuthClaims(supabase: SupabaseClient): Promise<VerifiedAuth | null> {
  const lookedUp = await firstSettledOrTimeout(supabase.auth.getClaims(), AUTH_LOOKUP_MS);
  if (!lookedUp || lookedUp.error) return null;
  const claims = lookedUp.data?.claims;
  if (!claims?.sub) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return null;
  return {
    userId: claims.sub,
    email: claims.email || claims.sub,
    accessToken,
  };
}

/** Refresh session cookies when Auth is fast; keep existing cookies if it is not. */
export async function refreshAuthCookies(supabase: SupabaseClient): Promise<void> {
  await firstSettledOrTimeout(supabase.auth.getClaims(), AUTH_LOOKUP_MS);
}
