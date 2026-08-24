import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';

const allowed = new Set(['x/sync', 'financial', 'publication/refresh', 'research/capture']);

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  const path = (await context.params).path.join('/');
  if (!allowed.has(path)) return NextResponse.json({ error: 'Unsupported knowledge operation' }, { status: 404 });
  const body = await request.text();
  const response = await env.KNOWLEDGE_PIPELINE.fetch(`https://knowledge.internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') || 'application/json', 'x-thesisforge-internal-token': env.INTERNAL_SERVICE_TOKEN },
    body,
  });
  return new NextResponse(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
}
