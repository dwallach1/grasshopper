import { publicDeskJsonError } from '@quantanamo/contracts/desk-snapshot';
import { NextResponse } from 'next/server';

import { isPublicDesk } from '../../../lib/desk-mode';
import { loadDesk } from '../../../lib/ledger';
import { isOperatorSession, operatorOrError } from '../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

export async function GET() {
  loadRootEnvLocal();
  if (isPublicDesk()) {
    return NextResponse.json(publicDeskJsonError('Not found'), { status: 404 });
  }
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
