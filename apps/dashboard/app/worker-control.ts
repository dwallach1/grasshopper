import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const WorkerResponseBodySchema = z.object({
  error: z.string().optional(),
  workflow_id: z.string().optional(),
  output: z.string().optional(),
  raw: z.string().optional(),
  skipped: z.boolean().optional(),
});

export type WorkerResponseBody = z.infer<typeof WorkerResponseBodySchema>;

export type WorkerStepResult = {
  ok: boolean;
  status: number;
  body: WorkerResponseBody;
  via: 'http' | 'wrangler';
};

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..');
}

function workerUrl(base: string | undefined, pathname: string): string | null {
  const trimmed = base?.trim();
  if (!trimmed) return null;
  return `${trimmed.replace(/\/$/, '')}${pathname}`;
}

function internalToken(): string | null {
  const token = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  return token || null;
}

function parseJsonBody(text: string): WorkerResponseBody {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const result = WorkerResponseBodySchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Fall through to raw capture below.
  }
  return { raw: text.slice(0, 500) };
}

async function readJson(response: Response): Promise<WorkerResponseBody> {
  const text = await response.text();
  if (!text) return {};
  try {
    return parseJsonBody(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function missingWorkerEnv(baseUrl: string | undefined, baseVar: string): string {
  const missing: string[] = [];
  if (!baseUrl?.trim()) missing.push(baseVar);
  if (!internalToken()) missing.push('INTERNAL_SERVICE_TOKEN');
  return missing.join(', ');
}

async function postWorker(
  pathname: string,
  baseUrl: string | undefined,
  baseVar: string,
): Promise<WorkerStepResult> {
  const url = workerUrl(baseUrl, pathname);
  const token = internalToken();
  if (!url || !token) {
    throw new Error(
      `Worker HTTP trigger requires ${missingWorkerEnv(baseUrl, baseVar)} in the repo root .env.local. Restart the webapp after updating it.`,
    );
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-thesisforge-internal-token': token },
    cache: 'no-store',
  });
  const body = await readJson(response);
  return { ok: response.ok, status: response.status, body, via: 'http' };
}

export async function invokeKnowledgeSync(): Promise<WorkerStepResult> {
  return postWorker('/x/sync', process.env.THESISFORGE_KNOWLEDGE_WORKER_URL, 'THESISFORGE_KNOWLEDGE_WORKER_URL');
}

export async function invokeResearchRun(): Promise<WorkerStepResult> {
  const http = workerUrl(process.env.THESISFORGE_RESEARCH_WORKER_URL, '/research/run');
  const token = internalToken();
  if (http && token) {
    const response = await fetch(http, {
      method: 'POST',
      headers: { 'x-thesisforge-internal-token': token },
      cache: 'no-store',
    });
    const body = await readJson(response);
    return { ok: response.ok, status: response.status, body, via: 'http' };
  }
  const { stdout } = await execFileAsync(
    'bun',
    [
      '--bun', 'wrangler', 'workflows', 'trigger', 'thesisforge-research-cycle',
      '--config', 'wrangler.jsonc',
      '--params', JSON.stringify({ force: true, requestedBy: 'manual' }),
    ],
    { cwd: path.join(repoRoot(), 'workers/research'), maxBuffer: 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    return { ok: true, status: 200, body: parseJsonBody(trimmed), via: 'wrangler' };
  }
  return { ok: true, status: 200, body: { output: trimmed }, via: 'wrangler' };
}

export async function invokeAccountRefresh(): Promise<WorkerStepResult> {
  return postWorker('/account/refresh', process.env.THESISFORGE_RESEARCH_WORKER_URL, 'THESISFORGE_RESEARCH_WORKER_URL');
}

export async function invokeFullPipeline(): Promise<{
  knowledge: WorkerStepResult;
  research: WorkerStepResult;
}> {
  const knowledge = await invokeKnowledgeSync();
  if (!knowledge.ok) {
    return {
      knowledge,
      research: { ok: false, status: 0, body: { skipped: true }, via: 'http' },
    };
  }
  const research = await invokeResearchRun();
  return { knowledge, research };
}
