import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { readSecret } from '@thesisforge/shared/secrets';

export async function GET(request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  const redirectUri = `${new URL(request.url).origin}/api/x/callback`;
  const internalToken = await readSecret(env.INTERNAL_SERVICE_TOKEN_SECRET, 'INTERNAL_SERVICE_TOKEN');
  const response = await env.KNOWLEDGE_PIPELINE.fetch('https://knowledge.internal/x/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-thesisforge-internal-token': internalToken },
    body: JSON.stringify({ redirectUri }),
  });
  const result = await response.json<{ url?: string; error?: string }>();
  if (!response.ok || !result.url) return NextResponse.json({ error: result.error || 'X authorization failed' }, { status: response.status });
  return NextResponse.redirect(result.url);
}
