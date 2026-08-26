import { NextRequest, NextResponse } from 'next/server';

import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../../load-root-env';
import { invokeAccountRefresh } from '../../../worker-control';

export async function POST(_request: NextRequest) {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;

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
