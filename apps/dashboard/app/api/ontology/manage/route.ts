import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { z } from 'zod';

import { isOperatorSession, operatorOrError } from '../../../../lib/operator-session';

const OntologyManageSchema = z.object({
  entity_type: z.enum(['theme', 'symbol']),
  entity_key: z.string().trim().min(1).max(120),
  action: z.enum(['promote', 'demote', 'blacklist', 'restore']),
});

const SupabaseErrorSchema = z.object({
  message: z.string().optional(),
}).passthrough();

const OntologyManageEntitySchema = z.union([
  z.object({
    id: z.string().min(1),
    status: z.string().min(1),
  }).passthrough(),
  z.object({
    symbol: z.string().min(1),
    status: z.string().min(1),
  }).passthrough(),
]);

const OntologyManageResponseSchema = z.object({
  entity: OntologyManageEntitySchema,
});

export async function POST(request: NextRequest) {
  const session = await operatorOrError();
  if (!isOperatorSession(session)) return session;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = OntologyManageSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid ontology management action' }, { status: 400 });
  }
  const { entity_type: entityType, entity_key: entityKey, action } = parsed.data;
  const key = entityType === 'symbol' ? entityKey.toUpperCase() : entityKey;

  const databaseUrl = process.env.QUANTANAMO_DATABASE_URL?.trim();
  const dashboardToken = process.env.QUANTANAMO_DASHBOARD_TOKEN?.trim();
  const managerToken = process.env.QUANTANAMO_MANAGER_TOKEN?.trim();

  if (databaseUrl && dashboardToken && managerToken) {
    const sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 15,
      prepare: false,
      ssl: 'require',
    });
    try {
      await sql`select set_config(
        'request.headers',
        ${JSON.stringify({
          'x-quantanamo-dashboard-token': dashboardToken,
          'x-quantanamo-manager-token': managerToken,
          'x-quantanamo-manager-user-id': session.email,
        })},
        true
      )`;
      const rows = await sql<Array<{ manage_ontology_entity: unknown }>>`
        select public.manage_ontology_entity(${entityType}, ${key}, ${action}) as manage_ontology_entity
      `;
      const dbResult = rows[0]?.manage_ontology_entity;
      const wrapped = OntologyManageResponseSchema.safeParse(dbResult);
      if (wrapped.success) return NextResponse.json({ entity: wrapped.data.entity });
      const direct = OntologyManageEntitySchema.safeParse(dbResult);
      if (direct.success) return NextResponse.json({ entity: direct.data });
      return NextResponse.json({ error: 'Ontology action returned an invalid entity' }, { status: 502 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Ontology action failed' },
        { status: 500 },
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey || !dashboardToken || !managerToken) {
    return NextResponse.json(
      {
        error:
          'Ontology manager needs QUANTANAMO_DASHBOARD_TOKEN + QUANTANAMO_MANAGER_TOKEN (and SUPABASE_URL), or QUANTANAMO_DATABASE_URL with those tokens.',
      },
      { status: 503 },
    );
  }

  const requestHeaders = new Headers({
    apikey: secretKey || publishableKey,
    'content-type': 'application/json',
    'x-quantanamo-dashboard-token': dashboardToken,
    'x-quantanamo-manager-user-id': session.email,
    'x-quantanamo-manager-token': managerToken,
  });
  if (secretKey) {
    requestHeaders.set('Authorization', `Bearer ${secretKey}`);
  }

  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/manage_ontology_entity`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      p_entity_type: entityType,
      p_entity_key: key,
      p_action: action,
    }),
  });
  const result: unknown = await response.json().catch(() => ({ error: 'Supabase returned an invalid response' }));
  if (!response.ok) {
    const message = SupabaseErrorSchema.safeParse(result).data?.message || 'Ontology action failed';
    return NextResponse.json({ error: message }, { status: response.status });
  }
  const wrapped = OntologyManageResponseSchema.safeParse(result);
  if (wrapped.success) return NextResponse.json({ entity: wrapped.data.entity });
  const direct = OntologyManageEntitySchema.safeParse(result);
  if (direct.success) return NextResponse.json({ entity: direct.data });
  return NextResponse.json({ error: 'Ontology action returned an invalid entity' }, { status: 502 });
}
