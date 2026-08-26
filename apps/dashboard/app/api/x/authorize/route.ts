import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { loadRootEnvLocal } from '../../../../load-root-env';
import { startXAuthorization } from '../../../worker-control';

export async function GET(request: NextRequest) {
  loadRootEnvLocal();
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }

  try {
    const result = await startXAuthorization();
    const url = result.body.url;
    if (!result.ok || !url) {
      return NextResponse.json(
        { error: result.body.error || 'X authorization failed' },
        { status: result.status || 502 },
      );
    }
    return NextResponse.redirect(url);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'X authorization failed' },
      { status: 503 },
    );
  }
}
