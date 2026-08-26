import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { updateThesisStatus } from '../../../../lib/mutations';
import { THESIS_STATUSES } from '../../../../lib/thesis-status';
import { loadRootEnvLocal } from '../../../../load-root-env';

const BodySchema = z.object({
  thesis_id: z.string().trim().min(1).max(80),
  status: z.enum(THESIS_STATUSES),
});

export async function POST(request: NextRequest) {
  loadRootEnvLocal();
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Manager access required' }, { status: 403 });
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid thesis status payload' }, { status: 400 });
  }
  try {
    const result = await updateThesisStatus(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Thesis update failed' },
      { status: 500 },
    );
  }
}
