import { NextResponse } from 'next/server';

import { createServerSupabase } from '../../../lib/supabase-server';

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', new URL(request.url).origin), { status: 303 });
}
