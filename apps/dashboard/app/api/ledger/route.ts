import { NextResponse } from 'next/server';

import { authenticatedIdentity } from '../../access-identity';
import { loadDesk } from '../../../lib/ledger';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

export async function GET() {
  loadRootEnvLocal();
  const identity = await authenticatedIdentity(new Headers());
  if (!identity) {
    return NextResponse.json({ error: 'Dashboard authentication required' }, { status: 401 });
  }
  try {
    const desk = await loadDesk();
    return NextResponse.json(desk);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Ledger load failed' },
      { status: 503 },
    );
  }
}
