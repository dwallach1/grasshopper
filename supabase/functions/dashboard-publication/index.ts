import tradePolicy from './trade-policy.json' with { type: 'json' };

const EXPECTED_TOKEN_SHA256 = '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c';
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function isPublicationBody(value: unknown): value is { publishCurrent?: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const publishCurrent = (value as { publishCurrent?: unknown }).publishCurrent;
  return publishCurrent === undefined || typeof publishCurrent === 'boolean';
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel('body size limit exceeded');
        throw new Error('body size limit exceeded');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function authorized(request: Request): Promise<boolean> {
  const token = request.headers.get('x-thesisforge-publication-token') || '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return constantTimeEqual(hex(digest), EXPECTED_TOKEN_SHA256);
}

function secretApiKey(): string {
  const namedSecrets = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (namedSecrets) {
    const parsed = JSON.parse(namedSecrets) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('Supabase secret API key is unavailable');
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!(await authorized(request))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let publishCurrent = false;
  try {
    const rawBody = await boundedText(request.body, MAX_REQUEST_BYTES);
    const body = rawBody ? JSON.parse(rawBody) as unknown : {};
    if (!isPublicationBody(body)) {
      return jsonResponse({ error: 'publishCurrent must be boolean' }, 400);
    }
    publishCurrent = body.publishCurrent === true;
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    console.error(JSON.stringify({ event: 'dashboard_publication_missing_supabase_url' }));
    return jsonResponse({ error: 'Publication service unavailable' }, 503);
  }

  try {
    const apiKey = secretApiKey();
    const headers: Record<string, string> = {
      apikey: apiKey,
      'content-type': 'application/json',
      'x-thesisforge-publication-token':
        request.headers.get('x-thesisforge-publication-token') || '',
    };
    if (!apiKey.startsWith('sb_secret_')) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/publish_dashboard_snapshot`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_trade_policy: tradePolicy,
          p_publish_current: publishCurrent,
        }),
      },
    );
    const responseBody = await boundedText(response.body, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      console.error(JSON.stringify({
        event: 'dashboard_publication_rpc_failed',
        status: response.status,
        mode: publishCurrent ? 'current' : 'shadow',
      }));
      return jsonResponse({ error: 'Publication failed' }, 502);
    }
    return new Response(responseBody, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'dashboard_publication_edge_error',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return jsonResponse({ error: 'Publication service unavailable' }, 503);
  }
});
