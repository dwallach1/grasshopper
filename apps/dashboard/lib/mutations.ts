import { z } from 'zod';

import { asSmallint } from './numbers';
import { encodeRunNotes } from './run-notes';
import { hasDatabaseUrl, hasSecretKey, openSql, restAuthHeaders, supabaseUrl } from './postgres';
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

function requireLedgerWrite(): void {
  if (!hasDatabaseUrl() && !hasSecretKey()) {
    throw new Error(
      'Ledger writes need QUANTANAMO_DATABASE_URL or SUPABASE_SECRET_KEY in the repo-root .env.local.',
    );
  }
}

export async function updateThesisStatus(input: ThesisStatusUpdate): Promise<ThesisStatusUpdate> {
  requireLedgerWrite();
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const status = parseThesisStatus(input.status);
  if (hasDatabaseUrl()) {
    const sql = openSql();
    try {
      const rows = await sql<Array<{ id: string; status: string }>>`
        update public.theses
        set status = ${status}, updated_at = now()
        where id = ${thesisId}
        returning id, status
      `;
      const row = rows[0];
      if (!row) throw new Error(`Thesis ${thesisId} not found`);
      return { thesis_id: row.id, status: parseThesisStatus(row.status) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const response = await fetch(
    `${supabaseUrl()}/rest/v1/theses?id=eq.${encodeURIComponent(thesisId)}`,
    {
      method: 'PATCH',
      headers: {
        ...restAuthHeaders(),
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
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

export async function appendThesisEvidence(input: EvidenceInsert): Promise<{ id: number }> {
  requireLedgerWrite();
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const evidenceType = z.string().trim().min(1).max(80).parse(input.evidence_type);
  const direction = z.enum(['supporting', 'challenging', 'neutral']).parse(input.direction);
  const summary = SummarySchema.parse(input.summary);
  const confidence = asSmallint(input.confidence, 'evidence.confidence');
  if (hasDatabaseUrl()) {
    const sql = openSql();
    try {
      const rows = await sql<Array<{ id: number }>>`
        insert into public.thesis_evidence (
          thesis_id, evidence_type, direction, summary, confidence, created_at
        ) values (
          ${thesisId}, ${evidenceType}, ${direction}, ${summary}, ${confidence}, now()
        )
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error('Evidence insert returned no id');
      return { id: Number(row.id) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const response = await fetch(`${supabaseUrl()}/rest/v1/thesis_evidence`, {
    method: 'POST',
    headers: {
      ...restAuthHeaders(),
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
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

export async function appendOperatorRun(input: RunInsert): Promise<{ id: number }> {
  requireLedgerWrite();
  const runType = z.string().trim().min(1).max(80).parse(input.run_type);
  const outcome = z.enum(['passed', 'failed', 'skipped']).parse(input.outcome);
  const headline = z.string().trim().min(1).max(200).parse(input.headline);
  const summary = SummarySchema.parse(input.summary);
  const notes = encodeRunNotes({ outcome, headline, summary });
  if (hasDatabaseUrl()) {
    const sql = openSql();
    try {
      const rows = await sql<Array<{ id: number }>>`
        insert into public.runs (run_type, started_at, completed_at, notes)
        values (${runType}, now(), now(), ${notes})
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error('Run insert returned no id');
      return { id: Number(row.id) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const now = new Date().toISOString();
  const response = await fetch(`${supabaseUrl()}/rest/v1/runs`, {
    method: 'POST',
    headers: {
      ...restAuthHeaders(),
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
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

export async function appendLesson(input: LessonInsert): Promise<{ id: number }> {
  requireLedgerWrite();
  const thesisId = ThesisIdSchema.parse(input.thesis_id);
  const lessonType = LessonTypeSchema.parse(input.lesson_type);
  const summary = SummarySchema.parse(input.summary);
  const marketRegime = input.market_regime?.trim() || null;
  if (hasDatabaseUrl()) {
    const sql = openSql();
    try {
      const cycles = await sql<Array<{ id: number }>>`
        select id from public.research_cycles
        where thesis_id = ${thesisId}
        order by updated_at desc, id desc
        limit 1
      `;
      const cycle = cycles[0];
      if (!cycle) {
        throw new Error(`Thesis ${thesisId} has no research_cycles row; lessons require a cycle.`);
      }
      const rows = await sql<Array<{ id: number }>>`
        insert into public.research_lessons (
          cycle_id, thesis_id, lesson_type, summary, market_regime, incorporated, created_at
        ) values (
          ${cycle.id}, ${thesisId}, ${lessonType}, ${summary}, ${marketRegime}, false, now()
        )
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error('Lesson insert returned no id');
      return { id: Number(row.id) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const cycleResponse = await fetch(
    `${supabaseUrl()}/rest/v1/research_cycles?thesis_id=eq.${encodeURIComponent(thesisId)}&select=id&order=updated_at.desc,id.desc&limit=1`,
    { headers: restAuthHeaders(), cache: 'no-store' },
  );
  const cyclePayload: unknown = await cycleResponse.json();
  const cycleParsed = z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).safeParse(cyclePayload);
  const cycleId = cycleParsed.success ? cycleParsed.data[0]?.id : undefined;
  if (!cycleResponse.ok || cycleId === undefined) {
    throw new Error(`Thesis ${thesisId} has no research_cycles row; lessons require a cycle.`);
  }
  const response = await fetch(`${supabaseUrl()}/rest/v1/research_lessons`, {
    method: 'POST',
    headers: {
      ...restAuthHeaders(),
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
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
