import { NextResponse } from 'next/server';

import { loadDesk } from '../../../lib/ledger';
import { isOperatorSession, operatorOrError } from '../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

export async function GET() {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;
  try {
    const desk = await loadDesk(session.accessToken);
    return NextResponse.json(desk);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Ledger load failed' },
      { status: 503 },
    );
  }
}
