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
  const upstream = (process.env.DESK_UPSTREAM_URL || '').trim();
  if (!hasDatabaseUrl()) {
    if (upstream) {
      try {
        const res = await fetch(`${upstream.replace(/\/$/, '')}/api/desk`, { cache: 'no-store' });
        const body = await res.text();
        return new NextResponse(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: 'desk_upstream_read_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }));
        return NextResponse.json(publicDeskJsonError(), { status: 503 });
      }
    }
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
