import { spawnSync } from 'node:child_process';
import { XClient } from './client.mjs';
import { loadEnv, requireEnv } from './env.mjs';

const env = loadEnv();
requireEnv(env, ['X_CLIENT_ID', 'X_REDIRECT_URI', 'X_ACCESS_TOKEN']);
const client = new XClient(env);

const user = await client.fetch('/2/users/me');
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

  const page = await client.fetch(`/2/users/${userId}/bookmarks?${params}`);
  if (Array.isArray(page.data)) bookmarks.push(...page.data);

  paginationToken = page.meta?.next_token;
  if (!paginationToken) break;
}

const payload = JSON.stringify({ fetched_at: new Date().toISOString(), user: user.data, bookmarks });
const ingest = spawnSync('.venv/bin/python', ['-m', 'thesisforge', 'bookmarks', 'ingest', '--bookmarks', '-'], {
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
