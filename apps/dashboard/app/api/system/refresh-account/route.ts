import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { invokeAccountRefresh } from '../../../worker-control';

export async function POST(request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }

  try {
    const result = await invokeAccountRefresh();
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Account refresh failed' },
      { status: 503 },
    );
  }
}
