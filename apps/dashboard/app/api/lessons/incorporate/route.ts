import { NextResponse } from 'next/server';

import { isPublicDesk } from '../../../../lib/desk-mode';
import { incorporateHttpError, parseIncorporateRequest } from '../../../../lib/lesson-incorporate';
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
    return NextResponse.json({ error: 'Invalid incorporate' }, { status: 400 });
  }
  const parsed = parseIncorporateRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: 'Invalid incorporate' }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.rpc('incorporate_research_lesson', {
    p_lesson_id: parsed.lesson_id,
  });
  if (error) {
    console.info(JSON.stringify({
      event: 'lesson_incorporate_failed',
      lesson_id: parsed.lesson_id,
      error: error.message,
    }));
    const mapped = incorporateHttpError(error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  return NextResponse.json(data);
}
