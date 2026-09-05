import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { isPublicSnapshot, publicDeskJsonError } from '@quantanamo/contracts/desk-snapshot';
import { NextResponse } from 'next/server';

import { isPublicDesk, publicDeskSnapshotPath } from '../../../lib/desk-mode';
import { loadRootEnvLocal } from '../../../load-root-env';

export const dynamic = 'force-dynamic';

const DEFAULT_RELATIVE = join('workers', 'desk', '.data', 'current.json');

function snapshotFilePath(): string {
  const configured = publicDeskSnapshotPath();
  if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured);
  return join(process.cwd(), '..', '..', DEFAULT_RELATIVE);
}

export async function GET() {
  loadRootEnvLocal();
  if (!isPublicDesk()) {
    return NextResponse.json(publicDeskJsonError('Not found'), { status: 404 });
  }
  try {
    const raw = await readFile(snapshotFilePath(), 'utf8');
    const body: unknown = JSON.parse(raw);
    if (!isPublicSnapshot(body)) {
      return NextResponse.json(publicDeskJsonError(), { status: 503 });
    }
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch {
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
