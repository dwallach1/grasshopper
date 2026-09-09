#!/usr/bin/env bun
/**
 * Mint a long-lived PostgREST JWT for role `desk_public_reader`.
 * CI (deploy-public-desk.yml) runs this with SUPABASE_JWT_SECRET and uploads
 * the JWT as a Worker secret. Never commit the output. Never put this secret
 * or service_role on the public Worker.
 *
 *   SUPABASE_JWT_SECRET=... bun scripts/mint-desk-reader-jwt.ts
 */
import { createHmac } from 'node:crypto';

import { DESK_PUBLIC_READER_ROLE } from '../packages/contracts/src/desk-snapshot';

function b64url(value: string | Buffer): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString('base64url');
}

const secret = (process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || '').trim();
if (!secret) {
  console.error('Set SUPABASE_JWT_SECRET (Project Settings → API → JWT secret).');
  process.exit(1);
}

const years = Number(process.env.DESK_READER_JWT_YEARS || 5);
const now = Math.floor(Date.now() / 1000);
const iss = (process.env.SUPABASE_JWT_ISS || 'supabase').trim();
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(JSON.stringify({
  iss,
  role: DESK_PUBLIC_READER_ROLE,
  iat: now,
  exp: now + Math.floor(years * 365.25 * 24 * 60 * 60),
}));
const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
process.stdout.write(`${header}.${payload}.${signature}\n`);
