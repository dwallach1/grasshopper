import { z } from 'zod';

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Local operator identity. The dashboard runs only on localhost and is not
 * exposed behind Cloudflare Access.
 */
function localDevIdentity(): string | null {
  const identity = process.env.LOCAL_DEV_IDENTITY?.trim();
  if (!identity) return null;
  const parsed = z.string().email().safeParse(identity);
  return parsed.success ? normalizeIdentity(parsed.data) : normalizeIdentity(identity);
}

export async function authenticatedIdentity(_requestHeaders: Headers): Promise<string | null> {
  return localDevIdentity();
}

export function isManagerIdentity(identity: string): boolean {
  const allowed = new Set(
    (process.env.THESISFORGE_MANAGER_USER_IDS || '')
      .split(',')
      .map(normalizeIdentity)
      .filter(Boolean),
  );
  return allowed.has(normalizeIdentity(identity));
}
