import { isPublicSnapshot, publicDeskJsonError, toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';
import { NextResponse } from 'next/server';

import { isPublicDesk } from '../../../lib/desk-mode';
import { loadDeskFromPostgres } from '../../../lib/ledger';
import { hasDatabaseUrl } from '../../../lib/postgres';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

export async function GET() {
  loadRootEnvLocal();
  if (!isPublicDesk()) {
    return NextResponse.json(publicDeskJsonError('Not found'), { status: 404 });
  }
  if (!hasDatabaseUrl()) {
    return NextResponse.json(publicDeskJsonError(), { status: 503 });
  }
  try {
    const published = toPublicDeskSnapshot({
      ...await loadDeskFromPostgres(),
      source: 'postgres',
    });
    if (!isPublicSnapshot(published)) {
      return NextResponse.json(publicDeskJsonError(), { status: 503 });
    }
    return NextResponse.json(published, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'desk_local_live_read_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return NextResponse.json(publicDeskJsonError(), { status: 503 });
  }
}

export async function POST() {
  return NextResponse.json(publicDeskJsonError('Method not allowed'), { status: 405 });
}

export async function PUT() {
  return NextResponse.json(publicDeskJsonError('Method not allowed'), { status: 405 });
}

export async function PATCH() {
  return NextResponse.json(publicDeskJsonError('Method not allowed'), { status: 405 });
}

export async function DELETE() {
  return NextResponse.json(publicDeskJsonError('Method not allowed'), { status: 405 });
}
