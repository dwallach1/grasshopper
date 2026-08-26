import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { appendLesson } from '../../../../lib/mutations';
import { loadRootEnvLocal } from '../../../../load-root-env';

const BodySchema = z.object({
  thesis_id: z.string().trim().min(1).max(80),
  lesson_type: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(4000),
  market_regime: z.string().trim().max(80).nullable().optional(),
});

export async function POST(request: NextRequest) {
  loadRootEnvLocal();
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid lesson payload' }, { status: 400 });
  }
  try {
    const result = await appendLesson({
      thesis_id: parsed.data.thesis_id,
      lesson_type: parsed.data.lesson_type,
      summary: parsed.data.summary,
      market_regime: parsed.data.market_regime ?? null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lesson insert failed' },
      { status: 500 },
    );
  }
}
