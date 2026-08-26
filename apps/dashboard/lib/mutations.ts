import { z } from 'zod';

import { publicSupabaseUrl, userRestHeaders } from './auth-env';
import { asSmallint } from './numbers';
import { encodeRunNotes } from './run-notes';
import { parseThesisStatus, type ThesisStatus } from './thesis-status';

const ThesisIdSchema = z.string().trim().min(1).max(80);
const LessonTypeSchema = z.string().trim().min(1).max(80);
const SummarySchema = z.string().trim().min(1).max(4000);

export type ThesisStatusUpdate = {
  thesis_id: string;
  status: ThesisStatus;
};

export type EvidenceInsert = {
  thesis_id: string;
  evidence_type: string;
  direction: string;
  summary: string;
  confidence: number;
};

export type RunInsert = {
  run_type: string;
  outcome: 'passed' | 'failed' | 'skipped';
  headline: string;
  summary: string;
};

export type LessonInsert = {
  thesis_id: string;
  lesson_type: string;
  summary: string;
  market_regime: string | null;
};

function writeHeaders(accessToken: string): HeadersInit {
  return {
    ...userRestHeaders(accessToken),
    'content-type': 'application/json',
    Prefer: 'return=representation',
  };
}

export async function updateThesisStatus(
  input: ThesisStatusUpdate,
  accessToken: string,
): Promise<ThesisStatusUpdate> {
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const status = parseThesisStatus(input.status);
  const response = await fetch(
    `${publicSupabaseUrl()}/rest/v1/theses?id=eq.${encodeURIComponent(thesisId)}`,
    {
      method: 'PATCH',
      headers: writeHeaders(accessToken),
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    },
  );
  const payload: unknown = await response.json();
  const parsed = z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).safeParse(payload);
  if (!response.ok || !parsed.success || !parsed.data[0]) {
    throw new Error(`Thesis status update failed (${response.status})`);
  }
  return { thesis_id: parsed.data[0].id, status: parseThesisStatus(parsed.data[0].status) };
}

export async function appendThesisEvidence(
  input: EvidenceInsert,
  accessToken: string,
): Promise<{ id: number }> {
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const evidenceType = z.string().trim().min(1).max(80).parse(input.evidence_type);
  const direction = z.enum(['supporting', 'challenging', 'neutral']).parse(input.direction);
  const summary = SummarySchema.parse(input.summary);
  const confidence = asSmallint(input.confidence, 'evidence.confidence');
  const response = await fetch(`${publicSupabaseUrl()}/rest/v1/thesis_evidence`, {
    method: 'POST',
    headers: writeHeaders(accessToken),
    body: JSON.stringify({
      thesis_id: thesisId,
      evidence_type: evidenceType,
      direction,
      summary,
      confidence,
      created_at: new Date().toISOString(),
    }),
  });
  const payload: unknown = await response.json();
  const parsed = z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).safeParse(payload);
  if (!response.ok || !parsed.success || parsed.data[0] === undefined) {
    throw new Error(`Evidence insert failed (${response.status})`);
  }
  return { id: Number(parsed.data[0].id) };
}

export async function appendOperatorRun(input: RunInsert, accessToken: string): Promise<{ id: number }> {
  const runType = z.string().trim().min(1).max(80).parse(input.run_type);
  const outcome = z.enum(['passed', 'failed', 'skipped']).parse(input.outcome);
  const headline = z.string().trim().min(1).max(200).parse(input.headline);
  const summary = SummarySchema.parse(input.summary);
  const notes = encodeRunNotes({ outcome, headline, summary });
  const now = new Date().toISOString();
  const response = await fetch(`${publicSupabaseUrl()}/rest/v1/runs`, {
    method: 'POST',
    headers: writeHeaders(accessToken),
    body: JSON.stringify({
      run_type: runType,
      started_at: now,
      completed_at: now,
      notes,
    }),
  });
  const payload: unknown = await response.json();
  const parsed = z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).safeParse(payload);
  if (!response.ok || !parsed.success || parsed.data[0] === undefined) {
    throw new Error(`Run insert failed (${response.status})`);
  }
  return { id: Number(parsed.data[0].id) };
}

export async function appendLesson(input: LessonInsert, accessToken: string): Promise<{ id: number }> {
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const lessonType = LessonTypeSchema.parse(input.lesson_type);
  const summary = SummarySchema.parse(input.summary);
  const marketRegime = input.market_regime?.trim() || null;
  const cycleResponse = await fetch(
    `${publicSupabaseUrl()}/rest/v1/research_cycles?thesis_id=eq.${encodeURIComponent(thesisId)}&select=id&order=updated_at.desc,id.desc&limit=1`,
    { headers: userRestHeaders(accessToken), cache: 'no-store' },
  );
  const cyclePayload: unknown = await cycleResponse.json();
  const cycleParsed = z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).safeParse(cyclePayload);
  const cycleId = cycleParsed.success ? cycleParsed.data[0]?.id : undefined;
  if (!cycleResponse.ok || cycleId === undefined) {
    throw new Error(`Thesis ${thesisId} has no research_cycles row; lessons require a cycle.`);
  }
  const response = await fetch(`${publicSupabaseUrl()}/rest/v1/research_lessons`, {
    method: 'POST',
    headers: writeHeaders(accessToken),
    body: JSON.stringify({
      cycle_id: Number(cycleId),
      thesis_id: thesisId,
      lesson_type: lessonType,
      summary,
      market_regime: marketRegime,
      incorporated: false,
      created_at: new Date().toISOString(),
    }),
  });
  const payload: unknown = await response.json();
  const parsed = z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).safeParse(payload);
  if (!response.ok || !parsed.success || parsed.data[0] === undefined) {
    throw new Error(`Lesson insert failed (${response.status})`);
  }
  return { id: Number(parsed.data[0].id) };
}
