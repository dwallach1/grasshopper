import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

const entityTypes = new Set(['theme', 'symbol']);
const actions = new Set(['promote', 'demote', 'blacklist', 'restore']);

export async function POST(request: NextRequest) {
  const managerId = request.headers.get('oai-authenticated-user-id') || '';
  const managerIds = new Set(
    (env.THESISFORGE_MANAGER_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
  );
  if (!managerId || !managerIds.has(managerId)) {
    return NextResponse.json({ error: 'Ontology manager access required' }, { status: 403 });
  }

  let body: { entity_type?: string; entity_key?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const entityType = body.entity_type || '';
  const entityKey = (body.entity_key || '').trim();
  const action = body.action || '';
  if (!entityTypes.has(entityType) || !actions.has(action) || !entityKey || entityKey.length > 120) {
    return NextResponse.json({ error: 'Invalid ontology management action' }, { status: 400 });
  }

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
  const result = await response.json().catch(() => ({ error: 'Supabase returned an invalid response' }));
  if (!response.ok) {
    const message = typeof result?.message === 'string' ? result.message : 'Ontology action failed';
    return NextResponse.json({ error: message }, { status: response.status });
  }
  return NextResponse.json(result);
}
