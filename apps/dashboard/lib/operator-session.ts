import { NextResponse } from 'next/server';

import { createServerSupabase } from './supabase-server';

export type OperatorSession = {
  userId: string;
  email: string;
  accessToken: string;
};

export type OperatorGate = OperatorSession | 'unauthenticated' | 'forbidden';

export async function readOperatorSession(): Promise<OperatorGate> {
  const supabase = await createServerSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return 'unauthenticated';
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return 'unauthenticated';
  const { data: claimed, error: claimError } = await supabase.rpc('claim_ledger_operator');
  if (claimError) {
    console.info(
      JSON.stringify({
        event: 'operator_claim_failed',
        userId: userData.user.id,
        error: claimError.message,
      }),
    );
    return 'forbidden';
  }
  if (claimed !== true) return 'forbidden';
  return {
    userId: userData.user.id,
    email: userData.user.email || userData.user.id,
    accessToken,
  };
}

export async function operatorOrError(): Promise<OperatorSession | NextResponse> {
  const session = await readOperatorSession();
  if (session === 'unauthenticated') {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (session === 'forbidden') {
    return NextResponse.json({ error: 'This account is not on the operator allowlist' }, { status: 403 });
  }
  return session;
}

export function isOperatorSession(value: OperatorSession | NextResponse): value is OperatorSession {
  return 'accessToken' in value;
}
