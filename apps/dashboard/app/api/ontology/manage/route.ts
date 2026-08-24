import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { isJsonString, type JsonObject } from '@thesisforge/shared/json';

const entityTypes = new Set(['theme', 'symbol']);
const actions = new Set(['promote', 'demote', 'blacklist', 'restore']);

export async function POST(request: NextRequest) {
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return NextResponse.json({ error: 'Ontology manager access required' }, { status: 403 });
  }

  let body: JsonObject;
  try {
    body = await request.json<JsonObject>();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const entityType = isJsonString(body.entity_type) ? body.entity_type : '';
  const entityKey = isJsonString(body.entity_key) ? body.entity_key.trim() : '';
  const action = isJsonString(body.action) ? body.action : '';
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
  const result = await response.json<JsonObject>().catch((): JsonObject => ({
    error: 'Supabase returned an invalid response',
  }));
  if (!response.ok) {
    const message = isJsonString(result.message) ? result.message : 'Ontology action failed';
    return NextResponse.json({ error: message }, { status: response.status });
  }
  return NextResponse.json(result);
}
