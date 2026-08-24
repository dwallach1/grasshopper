import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

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
    return typeof payload.email === 'string' ? normalizeIdentity(payload.email) : null;
  } catch {
    return null;
  }
}

export async function authenticatedIdentity(requestHeaders: Headers): Promise<string | null> {
  // A configured Access application is authoritative on Cloudflare. Do not
  // accept the Sites identity header there because public request headers are
  // caller-controlled until the Access JWT has been verified.
  if (env.CF_ACCESS_AUD || env.CF_ACCESS_TEAM_DOMAIN) {
    return cloudflareAccessIdentity(requestHeaders);
  }

  const sitesIdentity = requestHeaders.get('oai-authenticated-user-id');
  return sitesIdentity ? normalizeIdentity(sitesIdentity) : null;
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
