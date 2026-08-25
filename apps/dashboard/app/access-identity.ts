import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function accessTeamDomain(): string | null {
  const configured = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!configured) return null;
  return configured.replace(/\/$/, '').replace(/^([^:]+\.cloudflareaccess\.com)$/i, 'https://$1');
}

async function cloudflareAccessIdentity(requestHeaders: Headers): Promise<string | null> {
  const audience = env.CF_ACCESS_AUD?.trim();
  const teamDomain = accessTeamDomain();
  const token = requestHeaders.get('cf-access-jwt-assertion');
  if (!audience || !teamDomain || !token) return null;

  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      issuer: teamDomain,
    });
    const email = z.string().email().safeParse(payload.email);
    return email.success ? normalizeIdentity(email.data) : null;
  } catch {
    return null;
  }
}

/**
 * Local-only identity for `vite` / Miniflare. Production must keep
 * CF_ACCESS_AUD set to the real Access audience so this never activates,
 * and must never set LOCAL_DEV_IDENTITY on deployed Workers.
 */
function localDevIdentity(): string | null {
  const identity = env.LOCAL_DEV_IDENTITY?.trim();
  if (!identity) return null;
  const audience = env.CF_ACCESS_AUD?.trim();
  if (audience && audience !== 'local-dev') return null;
  return normalizeIdentity(identity);
}

export async function authenticatedIdentity(requestHeaders: Headers): Promise<string | null> {
  return (await cloudflareAccessIdentity(requestHeaders)) ?? localDevIdentity();
}

export function isManagerIdentity(identity: string): boolean {
  const allowed = new Set(
    (env.THESISFORGE_MANAGER_USER_IDS || '')
      .split(',')
      .map(normalizeIdentity)
      .filter(Boolean),
  );
  return allowed.has(normalizeIdentity(identity));
}
