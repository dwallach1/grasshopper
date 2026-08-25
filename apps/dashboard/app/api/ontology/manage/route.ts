import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';

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

export async function POST(request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Ontology manager access required' }, { status: 403 });
  }

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

  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  const dashboardToken = env.THESISFORGE_DASHBOARD_TOKEN;
  const managerToken = env.THESISFORGE_MANAGER_TOKEN;
  if (!url || !publishableKey || !dashboardToken || !managerToken) {
    return NextResponse.json({ error: 'Ontology manager is not configured' }, { status: 503 });
  }

  const response = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/rpc/manage_ontology_entity`,
    {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        'content-type': 'application/json',
        'x-thesisforge-dashboard-token': dashboardToken,
        'x-thesisforge-manager-user-id': managerId,
        'x-thesisforge-manager-token': managerToken,
      },
      body: JSON.stringify({
        p_entity_type: entityType,
        p_entity_key: entityType === 'symbol' ? entityKey.toUpperCase() : entityKey,
        p_action: action,
      }),
    },
  );
  const result: unknown = await response.json().catch(() => ({ error: 'Supabase returned an invalid response' }));
  if (!response.ok) {
    const message = SupabaseErrorSchema.safeParse(result).data?.message || 'Ontology action failed';
    return NextResponse.json({ error: message }, { status: response.status });
  }
  const wrapped = z.object({ entity: OntologyManageEntitySchema }).safeParse(result);
  if (wrapped.success) return NextResponse.json({ entity: wrapped.data.entity });
  const direct = OntologyManageEntitySchema.safeParse(result);
  if (direct.success) return NextResponse.json({ entity: direct.data });
  return NextResponse.json({ error: 'Ontology action returned an invalid entity' }, { status: 502 });
}
