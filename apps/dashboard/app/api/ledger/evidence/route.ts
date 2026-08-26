import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { appendThesisEvidence } from '../../../../lib/mutations';
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
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence payload' }, { status: 400 });
  }
  try {
    const result = await appendThesisEvidence(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Evidence insert failed' },
      { status: 500 },
    );
  }
}
