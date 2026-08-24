import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { isJsonString, type JsonValue } from '../shared/json';

type AccessClaims = {
  email?: JsonValue;
};

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
    const { payload } = await jwtVerify<AccessClaims>(token, jwks, {
      audience,
      issuer: teamDomain,
    });
    return isJsonString(payload.email) ? normalizeIdentity(payload.email) : null;
  } catch {
    return null;
  }
}

export async function authenticatedIdentity(requestHeaders: Headers): Promise<string | null> {
  return cloudflareAccessIdentity(requestHeaders);
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
