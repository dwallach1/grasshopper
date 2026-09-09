import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { isPublicSnapshot, publicDeskJsonError, toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';
import { NextResponse } from 'next/server';

import { isPublicDesk, publicDeskSnapshotPath } from '../../../lib/desk-mode';
import { loadDeskFromPostgres } from '../../../lib/ledger';
import { hasDatabaseUrl } from '../../../lib/postgres';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

const DEFAULT_RELATIVE = join('workers', 'desk', '.data', 'current.json');

function snapshotFilePath(): string {
  const configured = publicDeskSnapshotPath();
  if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured);
  return join(process.cwd(), '..', '..', DEFAULT_RELATIVE);
}

async function livePublicDesk(): Promise<unknown | null> {
  if (!hasDatabaseUrl()) return null;
  try {
    const published = toPublicDeskSnapshot({
      ...await loadDeskFromPostgres(),
      source: 'postgres',
    });
    return isPublicSnapshot(published) ? published : null;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'desk_local_live_read_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return null;
  }
}

async function filePublicDesk(): Promise<unknown | null> {
  try {
    const raw = await readFile(snapshotFilePath(), 'utf8');
    const body: unknown = JSON.parse(raw);
    return isPublicSnapshot(body) ? body : null;
  } catch {
    return null;
  }
}

export async function GET() {
  loadRootEnvLocal();
  if (!isPublicDesk()) {
    return NextResponse.json(publicDeskJsonError('Not found'), { status: 404 });
  }
  const body = (await livePublicDesk()) ?? (await filePublicDesk());
  if (!body) {
    return NextResponse.json(publicDeskJsonError(), { status: 503 });
  }
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
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
