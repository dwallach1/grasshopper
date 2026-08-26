import { NextResponse } from 'next/server';

import { createServerSupabase } from '../../../lib/supabase-server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';
  const errorDescription = url.searchParams.get('error_description');
  if (errorDescription) {
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(errorDescription)}`, url.origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/?auth_error=missing_oauth_code', url.origin));
  }
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
  }
  await supabase.rpc('claim_ledger_operator');
  return NextResponse.redirect(new URL(next, url.origin));
}
