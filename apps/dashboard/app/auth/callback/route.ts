import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createServerSupabase } from '../../../lib/supabase-server';

const OtpTypeSchema = z.enum(['email', 'magiclink', 'signup', 'invite', 'recovery', 'email_change']);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/';
  const errorDescription = url.searchParams.get('error_description');
  if (errorDescription) {
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(errorDescription)}`, url.origin));
  }

  const supabase = await createServerSupabase();
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const otpType = OtpTypeSchema.safeParse(url.searchParams.get('type'));

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
    }
  } else if (tokenHash && otpType.success) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType.data });
    if (error) {
      return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
    }
  } else {
    return NextResponse.redirect(new URL('/?auth_error=missing_auth_code', url.origin));
  }

  await supabase.rpc('claim_ledger_operator');
  return NextResponse.redirect(new URL(next, url.origin));
}
