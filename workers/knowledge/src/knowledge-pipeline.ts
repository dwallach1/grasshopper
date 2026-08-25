import type { ArticleTask } from './documents';
import {
  bookmarksNeedingAi,
  classifiedNeedingInvestigation,
  ingestXBookmarks,
  persistClaimInvestigations,
  type XBookmarkPayload,
} from './bookmarks';
import { CaptureSchema, captureResearch } from './capture';
import { withDatabase, withDatabaseRetry, withReadOnlyDatabase } from './database';
import { persistPreparedArticle, prepareArticleTask } from './documents';
import { FinancialRequestSchema, fetchFinancialData } from './financial';
import { rebuildKnowledgeGraph, refreshWeeklyEventMap } from './graph';
import { publishDashboard } from './publication';
import { XCredentialVault } from './x-credential-vault';
import { readSecret, secretsEqual, type SecretBinding } from '@thesisforge/shared/secrets';
import { investigateClaimsWithAi, MAX_INVESTIGATIONS_PER_SYNC } from './claim-investigation';
import { classifyBookmarksWithAi } from './ontology-analysis';
import { loadOntologyCatalog } from './ontology';
import {
  createResearchSessions,
  markResearchSessionError,
  restartResearchSession,
  runResearchStep,
  type XResearchTask,
} from './x-research';
import { z, ZodError } from 'zod';

export { XCredentialVault } from './x-credential-vault';

const XAuthorizeBodySchema = z.object({
  redirectUri: z.string().url(),
});

const XCallbackBodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().url(),
});

const XResearchBodySchema = z.object({
  bookmarkId: z.string().min(1),
});

type KnowledgeTask = ArticleTask | XResearchTask;

type KnowledgeEnvironment = {
  HYPERDRIVE: Hyperdrive;
  RESEARCH_ORIGINALS: R2Bucket;
  ARTICLE_QUEUE: Queue<KnowledgeTask>;
  X_RESEARCH_QUEUE: Queue<XResearchTask>;
  X_CREDENTIAL_VAULT: DurableObjectNamespace<XCredentialVault>;
  AI: Ai;
  AI_GATEWAY_ID: string;
  SUPABASE_URL: string;
  THESISFORGE_PUBLICATION_TOKEN_SECRET: SecretBinding;
  THESISFORGE_PUBLICATION_TOKEN?: string;
  INTERNAL_SERVICE_TOKEN_SECRET: SecretBinding;
  INTERNAL_SERVICE_TOKEN?: string;
  FINANCIAL_DATASETS_API_KEY_SECRET: SecretBinding;
  FINANCIAL_DATASETS_API_KEY?: string;
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
  const current = await readSecret(
    env.INTERNAL_SERVICE_TOKEN_SECRET,
    'INTERNAL_SERVICE_TOKEN',
    env.INTERNAL_SERVICE_TOKEN,
  );
  return secretsEqual(supplied, current);
}

async function syncBookmarks(env: KnowledgeEnvironment) {
  const payload: XBookmarkPayload = await env.X_CREDENTIAL_VAULT.getByName('primary').fetchBookmarks();
  const { catalog, pending } = await withReadOnlyDatabase(env.HYPERDRIVE.connectionString, async (database) => ({
    catalog: await loadOntologyCatalog(database),
    pending: await bookmarksNeedingAi(database, payload),
  }));
  const classified = await classifyBookmarksWithAi(env.AI, env.AI_GATEWAY_ID, pending, payload.fetchedAt, catalog);
  const freshInvestigations = await investigateClaimsWithAi(env.AI, env.AI_GATEWAY_ID, classified);
  const result = await withDatabase(
    env.HYPERDRIVE.connectionString,
    (database) => ingestXBookmarks(database, payload, catalog, classified, freshInvestigations),
  );

  const backlog = await withReadOnlyDatabase(env.HYPERDRIVE.connectionString, (database) =>
    classifiedNeedingInvestigation(
      database,
      Math.max(0, MAX_INVESTIGATIONS_PER_SYNC - freshInvestigations.length),
    ));
  const backlogInvestigations = backlog.length
    ? await investigateClaimsWithAi(env.AI, env.AI_GATEWAY_ID, backlog)
    : [];
  const backlogPersisted = backlogInvestigations.length
    ? await withDatabase(env.HYPERDRIVE.connectionString, (database) =>
      persistClaimInvestigations(database, backlogInvestigations, payload.fetchedAt))
    : 0;

  if (result.articleTasks.length) {
    await env.ARTICLE_QUEUE.sendBatch(result.articleTasks.map((task) => ({ body: { kind: 'article' as const, ...task } })));
  }
  const researchTasks = await withDatabase(env.HYPERDRIVE.connectionString, (database) =>
    createResearchSessions(database));
  if (researchTasks.length) {
    await env.X_RESEARCH_QUEUE.sendBatch(researchTasks.map((task) => ({ body: task })));
  }
  const graph = await withDatabase(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
  const publication = await publishDashboard(env);
  const investigations = result.investigations + backlogPersisted;
  console.log(JSON.stringify({
    event: 'knowledge_sync_complete',
    ...result,
    articleTasks: result.articleTasks.length,
    investigations,
    researchSessions: researchTasks.length,
    graph,
    publication: publication.normalized_sha256,
  }));
  return {
    ...result,
    articleTasks: result.articleTasks.length,
    investigations,
    researchSessions: researchTasks.length,
    graph,
    publication,
  };
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
    const body = XAuthorizeBodySchema.parse(await request.json());
    return json({ url: await env.X_CREDENTIAL_VAULT.getByName('primary').authorizationUrl(body.redirectUri) });
  }
  if (url.pathname === '/x/callback' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const body = XCallbackBodySchema.parse(await request.json());
    return json(await env.X_CREDENTIAL_VAULT.getByName('primary').completeAuthorization(body.code, body.state, body.redirectUri));
  }
  if (url.pathname === '/x/sync' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    return json(await syncBookmarks(env));
  }
  if (url.pathname === '/x/research' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const body = XResearchBodySchema.parse(await request.json());
    const task = await withDatabase(env.HYPERDRIVE.connectionString, (database) =>
      restartResearchSession(database, body.bookmarkId));
    if (!task) return json({ error: 'bookmark_not_found' }, { status: 404 });
    await env.X_RESEARCH_QUEUE.send(task);
    return json({ enqueued: true, sessionId: task.sessionId });
  }
  if (url.pathname === '/financial' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
    const spec = FinancialRequestSchema.parse(await request.json());
    const apiKey = await readSecret(
      env.FINANCIAL_DATASETS_API_KEY_SECRET,
      'FINANCIAL_DATASETS_API_KEY',
      env.FINANCIAL_DATASETS_API_KEY,
    );
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
    if (batch.queue === 'thesisforge-knowledge-x-research') {
      for (const message of batch.messages) {
        if (message.body.kind !== 'x_research') {
          message.ack();
          continue;
        }
        const task = message.body;
        try {
          const result = await runResearchStep(env, task);
          if (result.finalized) {
            await withDatabaseRetry(env.HYPERDRIVE.connectionString, rebuildKnowledgeGraph);
            await publishDashboard(env);
          }
          message.ack();
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown';
          console.error(JSON.stringify({
            event: 'x_research_step_failed',
            session: task.sessionId,
            attempt: message.attempts,
            error: reason,
          }));
          const exhaustedRetries = message.attempts >= 3;
          try {
            await withDatabaseRetry(env.HYPERDRIVE.connectionString, (database) =>
              markResearchSessionError(database, task.sessionId, reason, exhaustedRetries));
          } catch {
            // Session bookkeeping is best-effort; the queue retry is authoritative.
          }
          message.retry({ delaySeconds: Math.min(900, 60 * (2 ** Math.min(message.attempts, 4))) });
        }
      }
      return;
    }
    const completed: Array<(typeof batch.messages)[number]> = [];
    for (const message of batch.messages) {
      if (message.body.kind !== 'article') {
        message.ack();
        continue;
      }
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
