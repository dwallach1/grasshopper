import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  callbackErrorUrl,
  callbackSuccessUrl,
  deskRequestOrigin,
  newAuthCookieSink,
  redirectWithAuthCookies,
} from '../../../lib/auth-callback';
import { createRequestSupabase } from '../../../lib/supabase-server';

const OtpTypeSchema = z.enum(['email', 'magiclink', 'signup', 'invite', 'recovery', 'email_change']);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = deskRequestOrigin(request.headers.get('host'), request.url);
  const sink = newAuthCookieSink();
  const errorDescription = url.searchParams.get('error_description');
  if (errorDescription) {
    return NextResponse.redirect(callbackErrorUrl(origin, errorDescription));
  }

  const supabase = createRequestSupabase(request, sink);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const otpType = OtpTypeSchema.safeParse(url.searchParams.get('type'));

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.info(JSON.stringify({ event: 'auth_callback_exchange_failed', origin, error: error.message }));
      return redirectWithAuthCookies(callbackErrorUrl(origin, error.message), sink);
    }
  } else if (tokenHash && otpType.success) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType.data });
    if (error) {
      console.info(JSON.stringify({ event: 'auth_callback_verify_failed', origin, error: error.message }));
      return redirectWithAuthCookies(callbackErrorUrl(origin, error.message), sink);
    }
  } else {
    console.info(JSON.stringify({ event: 'auth_callback_missing_code', origin }));
    return NextResponse.redirect(callbackErrorUrl(origin, 'missing_auth_code'));
  }

  const { error: claimError } = await supabase.rpc('claim_ledger_operator');
  if (claimError) {
    console.info(JSON.stringify({ event: 'auth_callback_claim_failed', origin, error: claimError.message }));
  } else {
    console.info(JSON.stringify({ event: 'auth_callback_ok', origin }));
  }
  return redirectWithAuthCookies(callbackSuccessUrl(origin, url.searchParams.get('next')), sink);
}
