import { NextRequest, NextResponse } from 'next/server';

import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../../load-root-env';
import { invokeFullPipeline } from '../../../worker-control';

export async function POST(_request: NextRequest) {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;

  try {
    const result = await invokeFullPipeline();
    const ok = result.knowledge.ok && result.research.ok;
    return NextResponse.json(result, { status: ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Pipeline run failed' },
      { status: 503 },
    );
  }
}
