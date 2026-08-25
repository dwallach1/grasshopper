import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { readSecret } from '@thesisforge/shared/secrets';

export async function POST(_request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }

  const internalToken = await readSecret(
    env.INTERNAL_SERVICE_TOKEN_SECRET,
    'INTERNAL_SERVICE_TOKEN',
    env.INTERNAL_SERVICE_TOKEN,
  );
  const response = await env.RESEARCH_ORCHESTRATOR.fetch('https://research.internal/account/refresh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thesisforge-internal-token': internalToken,
    },
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
  });
}
