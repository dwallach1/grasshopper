import type { ArticleTask } from './documents';
import { bookmarksNeedingAi, ingestXBookmarks, type XBookmarkPayload } from './bookmarks';
import { CaptureSchema, captureResearch } from './capture';
import { withDatabase, withDatabaseRetry, withReadOnlyDatabase } from './database';
import { persistPreparedArticle, prepareArticleTask } from './documents';
import { FinancialRequestSchema, fetchFinancialData } from './financial';
import { rebuildKnowledgeGraph, refreshWeeklyEventMap } from './graph';
import { publishDashboard } from './publication';
import { XCredentialVault } from './x-credential-vault';
import { readSecret, secretsEqual, type SecretBinding } from '@thesisforge/shared/secrets';
import { classifyBookmarksWithAi } from './ontology-analysis';
import { loadOntologyCatalog } from './ontology';
import { ZodError } from 'zod';

export { XCredentialVault } from './x-credential-vault';

type KnowledgeTask = ArticleTask;

type KnowledgeEnvironment = {
  HYPERDRIVE: Hyperdrive;
  RESEARCH_ORIGINALS: R2Bucket;
  ARTICLE_QUEUE: Queue<KnowledgeTask>;
  X_CREDENTIAL_VAULT: DurableObjectNamespace<XCredentialVault>;
  AI: Ai;
  AI_GATEWAY_ID: string;
  SUPABASE_URL: string;
  THESISFORGE_PUBLICATION_TOKEN_SECRET: SecretBinding;
  INTERNAL_SERVICE_TOKEN_SECRET: SecretBinding;
  FINANCIAL_DATASETS_API_KEY_SECRET: SecretBinding;
};

function json<Value>(value: Value, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function authorized(request: Request, env: KnowledgeEnvironment): Promise<boolean> {
  const supplied = request.headers.get('x-thesisforge-internal-token') || '';
  if (!supplied) return false;
  const current = await readSecret(env.INTERNAL_SERVICE_TOKEN_SECRET, 'INTERNAL_SERVICE_TOKEN');
  return secretsEqual(supplied, current);
}

async function syncBookmarks(env: KnowledgeEnvironment) {
  const payload: XBookmarkPayload = await env.X_CREDENTIAL_VAULT.getByName('primary').fetchBookmarks();
  const { catalog, pending } = await withReadOnlyDatabase(env.HYPERDRIVE.connectionString, async (database) => ({
    catalog: await loadOntologyCatalog(database),
    pending: await bookmarksNeedingAi(database, payload),
  }));
  const classified = await classifyBookmarksWithAi(env.AI, env.AI_GATEWAY_ID, pending, payload.fetchedAt, catalog);
  const result = await withDatabase(
    env.HYPERDRIVE.connectionString,
    (database) => ingestXBookmarks(database, payload, catalog, classified),
  );
  if (result.articleTasks.length) {
    await env.ARTICLE_QUEUE.sendBatch(result.articleTasks.map((task) => ({ body: { kind: 'article' as const, ...task } })));
  }
  const graph = await withDatabase(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
  const publication = await publishDashboard(env);
  console.log(JSON.stringify({ event: 'knowledge_sync_complete', ...result, articleTasks: result.articleTasks.length, graph, publication: publication.normalized_sha256 }));
  return { ...result, articleTasks: result.articleTasks.length, graph, publication };
}

async function route(request: Request, env: KnowledgeEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const [database, x] = await Promise.all([
      withReadOnlyDatabase(env.HYPERDRIVE.connectionString, async (db) => {
        const rows = await db.query<{ imported_at: string | null; bookmarks: number }>("select max(fetched_at)::text as imported_at,count(*)::integer as bookmarks from bookmarks");
        return rows[0];
      }),
      env.X_CREDENTIAL_VAULT.getByName('primary').status(),
    ]);
    return json({ ok: true, worker: 'thesisforge-knowledge-pipeline', database, x });
  }
  if (url.pathname === '/x/authorize' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json<{ redirectUri?: string }>();
    if (!body.redirectUri) return json({ error: 'redirectUri is required' }, { status: 400 });
    return json({ url: await env.X_CREDENTIAL_VAULT.getByName('primary').authorizationUrl(body.redirectUri) });
  }
  if (url.pathname === '/x/callback' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json<{ code?: string; state?: string; redirectUri?: string }>();
    if (!body.code || !body.state || !body.redirectUri) return json({ error: 'code, state, and redirectUri are required' }, { status: 400 });
    return json(await env.X_CREDENTIAL_VAULT.getByName('primary').completeAuthorization(body.code, body.state, body.redirectUri));
  }
  if (url.pathname === '/x/sync' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    return json(await syncBookmarks(env));
  }
  if (url.pathname === '/financial' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const spec = FinancialRequestSchema.parse(await request.json());
    const apiKey = await readSecret(env.FINANCIAL_DATASETS_API_KEY_SECRET, 'FINANCIAL_DATASETS_API_KEY');
    const result = await withDatabase(env.HYPERDRIVE.connectionString, (database) => fetchFinancialData(database, apiKey, spec));
    await publishDashboard(env);
    return json(result);
  }
  if (url.pathname === '/publication/refresh' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    return json(await publishDashboard(env));
  }
  if (url.pathname === '/research/capture' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const body = CaptureSchema.parse(await request.json());
    const result = await withDatabase(env.HYPERDRIVE.connectionString, (database) => captureResearch(database, body));
    await withDatabase(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
    await publishDashboard(env);
    return json(result);
  }
  return json({ error: 'not_found' }, { status: 404 });
}

const worker = {
  async fetch(request: Request, env: KnowledgeEnvironment): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ZodError) {
        return json({ error: 'invalid_request', issues: error.issues }, { status: 400 });
      }
      console.error(JSON.stringify({ event: 'knowledge_request_failed', path: new URL(request.url).pathname, error: error instanceof Error ? error.message : 'unknown' }));
      return json({ error: error instanceof Error ? error.message : 'internal_error' }, { status: 500 });
    }
  },
  async scheduled(controller: ScheduledController, env: KnowledgeEnvironment, ctx: ExecutionContext): Promise<void> {
    const operation = controller.cron === '15 12 * * SUN'
      ? withDatabase(env.HYPERDRIVE.connectionString, refreshWeeklyEventMap).then(async (result) => {
          await withDatabase(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
          await publishDashboard(env);
          return result;
        })
      : syncBookmarks(env);
    ctx.waitUntil(operation.catch((error) => {
      console.error(JSON.stringify({ event: 'knowledge_schedule_failed', cron: controller.cron, error: error instanceof Error ? error.message : 'unknown' }));
      throw error;
    }));
  },
  async queue(batch: MessageBatch<KnowledgeTask>, env: KnowledgeEnvironment): Promise<void> {
    const completed: Array<(typeof batch.messages)[number]> = [];
    for (const message of batch.messages) {
      try {
        const prepared = await prepareArticleTask(env.RESEARCH_ORIGINALS, message.body);
        await withDatabaseRetry(env.HYPERDRIVE.connectionString, (database) => persistPreparedArticle(database, prepared));
        completed.push(message);
      } catch (error) {
        console.error(JSON.stringify({ event: 'article_task_failed', id: message.id, attempt: message.attempts, error: error instanceof Error ? error.message : 'unknown' }));
        message.retry({ delaySeconds: Math.min(900, 30 * (2 ** Math.min(message.attempts, 5))) });
      }
    }
    if (completed.length) {
      try {
        await withDatabaseRetry(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
        await publishDashboard(env);
        for (const message of completed) message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: 'article_projection_failed', messages: completed.length, error: error instanceof Error ? error.message : 'unknown' }));
        for (const message of completed) message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<KnowledgeEnvironment, KnowledgeTask>;

export default worker;
