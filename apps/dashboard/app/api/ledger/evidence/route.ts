import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { appendThesisEvidence } from '../../../../lib/mutations';
import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { loadRootEnvLocal } from '../../../../load-root-env';

const BodySchema = z.object({
  thesis_id: z.string().trim().min(1).max(80),
  evidence_type: z.string().trim().min(1).max(80),
  direction: z.enum(['supporting', 'challenging', 'neutral']),
  summary: z.string().trim().min(1).max(4000),
  confidence: z.number().int().min(0).max(100),
});

export async function POST(request: NextRequest) {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence payload' }, { status: 400 });
  }
  try {
    const result = await appendThesisEvidence(parsed.data, session.accessToken);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Evidence insert failed' },
      { status: 500 },
    );
  }
}
