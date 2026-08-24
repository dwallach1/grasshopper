import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { readSecret } from '../../../../shared/secrets';

const allowed = new Set(['x/sync', 'financial', 'publication/refresh', 'research/capture']);

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  const path = (await context.params).path.join('/');
  if (!allowed.has(path)) return NextResponse.json({ error: 'Unsupported knowledge operation' }, { status: 404 });
  const body = await request.text();
  const internalToken = await readSecret(env.INTERNAL_SERVICE_TOKEN_SECRET, 'INTERNAL_SERVICE_TOKEN');
  const response = await env.KNOWLEDGE_PIPELINE.fetch(`https://knowledge.internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') || 'application/json', 'x-thesisforge-internal-token': internalToken },
    body,
  });
  return new NextResponse(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
}
