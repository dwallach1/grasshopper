import { type NextRequest } from 'next/server';

import {
  callbackSuccessUrl,
  deskRequestOrigin,
  newAuthCookieSink,
  redirectWithAuthCookies,
} from '../../../lib/auth-callback';
import { createRequestSupabase } from '../../../lib/supabase-server';

export async function POST(request: NextRequest) {
  const sink = newAuthCookieSink();
  const supabase = createRequestSupabase(request, sink);
  await supabase.auth.signOut();
  const origin = deskRequestOrigin(request.headers.get('host'), request.url);
  return redirectWithAuthCookies(callbackSuccessUrl(origin, '/'), sink);
}
