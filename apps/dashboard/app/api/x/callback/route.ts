import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { readSecret } from '@thesisforge/shared/secrets';

const CallbackErrorSchema = z.object({
  error: z.string().optional(),
}).passthrough();

export async function GET(request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return NextResponse.json({ error: 'X callback is missing code or state' }, { status: 400 });
  const redirectUri = `${url.origin}/api/x/callback`;
  const internalToken = await readSecret(env.INTERNAL_SERVICE_TOKEN_SECRET, 'INTERNAL_SERVICE_TOKEN');
  const response = await env.KNOWLEDGE_PIPELINE.fetch('https://knowledge.internal/x/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-thesisforge-internal-token': internalToken },
    body: JSON.stringify({ code, state, redirectUri }),
  });
  if (!response.ok) {
    const parsed = CallbackErrorSchema.safeParse(await response.json());
    return NextResponse.json(
      parsed.success ? parsed.data : { error: 'X callback failed' },
      { status: response.status },
    );
  }
  return NextResponse.redirect(`${url.origin}/?x=authorized`);
}
