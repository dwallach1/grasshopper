import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { updateThesisStatus } from '../../../../lib/mutations';
import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { THESIS_STATUSES } from '../../../../lib/thesis-status';
import { loadRootEnvLocal } from '../../../../load-root-env';

const BodySchema = z.object({
  thesis_id: z.string().trim().min(1).max(80),
  status: z.enum(THESIS_STATUSES),
});

export async function POST(request: NextRequest) {
  loadRootEnvLocal();
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid thesis status payload' }, { status: 400 });
  }
  try {
    const result = await updateThesisStatus(parsed.data, session.accessToken);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Thesis update failed' },
      { status: 500 },
    );
  }
}
