import { spawnSync } from 'node:child_process';
import { loadEnv, requireEnv, updateEnv } from './env.mjs';
import { Buffer } from 'node:buffer';

const env = loadEnv();
requireEnv(env, ['X_CLIENT_ID', 'X_REDIRECT_URI', 'X_ACCESS_TOKEN']);

const user = await xFetch('/2/users/me', env);
const userId = user.data?.id;
if (!userId) throw new Error(`Could not resolve X user id: ${JSON.stringify(user)}`);

const bookmarks = [];
let paginationToken = null;

for (;;) {
  const params = new URLSearchParams({
    max_results: '100',
    'tweet.fields': 'created_at,author_id,public_metrics,entities,context_annotations,lang,referenced_tweets',
    expansions: 'author_id,referenced_tweets.id',
    'user.fields': 'username,name,verified,description,public_metrics',
  });
  if (paginationToken) params.set('pagination_token', paginationToken);

  const page = await xFetch(`/2/users/${userId}/bookmarks?${params}`, env);
  if (Array.isArray(page.data)) bookmarks.push(...page.data);

  paginationToken = page.meta?.next_token;
  if (!paginationToken) break;
}

const payload = JSON.stringify({ fetched_at: new Date().toISOString(), user: user.data, bookmarks });
const ingest = spawnSync('.venv/bin/python', ['scripts/thesis_ingest.py', '--bookmarks', '-'], {
  cwd: process.cwd(),
  input: payload,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

if (ingest.error) throw ingest.error;
if (ingest.status !== 0) {
  throw new Error(`Supabase bookmark ingestion failed (${ingest.status}): ${ingest.stderr.trim()}`);
}

console.log(`Fetched ${bookmarks.length} bookmarks for @${user.data.username}.`);
console.log(ingest.stdout.trim());

async function xFetch(path, env, retried = false) {
  const response = await fetch(`https://api.x.com${path}`, {
    headers: { authorization: `Bearer ${env.X_ACCESS_TOKEN}` },
  });

  if (response.status === 401 && env.X_REFRESH_TOKEN && !retried) {
    const token = await refreshToken(env);
    env.X_ACCESS_TOKEN = token.access_token;
    if (token.refresh_token) env.X_REFRESH_TOKEN = token.refresh_token;
    updateEnv({ X_ACCESS_TOKEN: env.X_ACCESS_TOKEN, X_REFRESH_TOKEN: env.X_REFRESH_TOKEN });
    return xFetch(path, env, true);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`X API failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function refreshToken(env) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.X_REFRESH_TOKEN,
    client_id: env.X_CLIENT_ID,
  });

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64')}`;
  }

  const response = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Token refresh failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}
