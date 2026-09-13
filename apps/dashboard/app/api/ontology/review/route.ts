import { NextResponse } from 'next/server';

import { parseReviewRequest, reviewHttpError } from '../../../../lib/candidate-review';
import { isPublicDesk } from '../../../../lib/desk-mode';
import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';
import { createServerSupabase } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (isPublicDesk()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid review' }, { status: 400 });
  }
  const parsed = parseReviewRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: 'Invalid review' }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.rpc('review_ontology_candidate', {
    p_candidate_id: parsed.candidate_id,
    p_action: parsed.action,
    p_thesis_id: parsed.thesis_id,
    p_note: parsed.note,
  });
  if (error) {
    console.info(JSON.stringify({
      event: 'ontology_review_failed',
      candidate_id: parsed.candidate_id,
      action: parsed.action,
      error: error.message,
    }));
    const mapped = reviewHttpError(error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  return NextResponse.json(data);
}
