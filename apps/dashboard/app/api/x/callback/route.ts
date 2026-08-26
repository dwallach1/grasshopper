import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      error:
        'Retired. QUANTANAMO reads X through the X connector; this Cloudflare OAuth callback is unwired from the operator desk.',
    },
    { status: 410 },
  );
}
