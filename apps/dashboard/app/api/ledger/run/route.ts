import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { appendOperatorRun } from '../../../../lib/mutations';
import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../../load-root-env';

const BodySchema = z.object({
  run_type: z.string().trim().min(1).max(80).default('operator_note'),
  outcome: z.enum(['passed', 'failed', 'skipped']).default('passed'),
  headline: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
});

export async function POST(request: NextRequest) {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid run payload' }, { status: 400 });
  }
  try {
    const result = await appendOperatorRun(parsed.data, session.accessToken);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Run insert failed' },
      { status: 500 },
    );
  }
}
