import { NextResponse } from 'next/server';

export const LEDGER_WRITE_RETIRED =
  'Read-only desk. QUANTANAMO writes the ledger; operators only look.';

export function retiredLedgerWrite(): NextResponse<{ error: string }> {
  return NextResponse.json({ error: LEDGER_WRITE_RETIRED }, { status: 410 });
}

export async function POST(): Promise<NextResponse<{ error: string }>> {
  return retiredLedgerWrite();
}

export async function PUT(): Promise<NextResponse<{ error: string }>> {
  return retiredLedgerWrite();
}

export async function PATCH(): Promise<NextResponse<{ error: string }>> {
  return retiredLedgerWrite();
}

export async function DELETE(): Promise<NextResponse<{ error: string }>> {
  return retiredLedgerWrite();
}
