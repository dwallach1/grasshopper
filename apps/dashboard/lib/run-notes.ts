import { z } from 'zod';

export const RUN_OUTCOMES = ['passed', 'failed', 'skipped', 'running'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

const NotesJsonSchema = z
  .object({
    outcome: z.enum(['passed', 'failed', 'skipped']).optional(),
    status: z.string().optional(),
    headline: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    insights: z.array(z.string()).optional(),
    learnings: z.array(z.string()).optional(),
    actions: z.array(z.string()).optional(),
  })
  .passthrough();

export type ParsedRunNotes = {
  outcome: RunOutcome;
  headline: string;
  summary: string;
  insights: string[];
  learnings: string[];
  actions: string[];
  error: string | null;
  raw: string | null;
};

function titleFromRunType(runType: string): string {
  return runType.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function looksLikeJsonObject(notes: string): boolean {
  const trimmed = notes.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

/**
 * `runs.notes` is either operator prose or a JSON object. Dashboard projection
 * requires `outcome: 'passed' | 'failed' | 'skipped'` when the payload is JSON.
 */
export function parseRunNotes(
  notes: string | null,
  runType: string,
  complete: boolean,
): ParsedRunNotes {
  const fallbackHeadline = titleFromRunType(runType);
  if (!notes) {
    return {
      outcome: complete ? 'passed' : 'running',
      headline: fallbackHeadline,
      summary: '',
      insights: [],
      learnings: [],
      actions: [],
      error: null,
      raw: null,
    };
  }
  if (looksLikeJsonObject(notes)) {
    try {
      const parsed = NotesJsonSchema.safeParse(JSON.parse(notes));
      if (parsed.success) {
        const outcome = parsed.data.outcome ?? (complete ? 'passed' : 'running');
        return {
          outcome,
          headline: parsed.data.headline || fallbackHeadline,
          summary: parsed.data.summary || parsed.data.error || notes,
          insights: parsed.data.insights ?? [],
          learnings: parsed.data.learnings ?? [],
          actions: parsed.data.actions ?? [],
          error: parsed.data.error ?? null,
          raw: notes,
        };
      }
    } catch {
      // Prose that happens to be brace-wrapped is not JSON; fall through.
    }
  }
  return {
    outcome: complete ? 'passed' : 'running',
    headline: fallbackHeadline,
    summary: notes,
    insights: [],
    learnings: [],
    actions: [],
    error: null,
    raw: notes,
  };
}

export function encodeRunNotes(input: {
  outcome: 'passed' | 'failed' | 'skipped';
  headline: string;
  summary: string;
}): string {
  return JSON.stringify({
    outcome: input.outcome,
    headline: input.headline,
    summary: input.summary,
  });
}
