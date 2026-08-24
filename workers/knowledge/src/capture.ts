import { z } from 'zod';

import type { Database } from './database';
import { normalizePhrase, slugify } from './ontology';
import type { JsonObject } from '@thesisforge/shared/json';

const NonEmpty = (max: number) => z.string().trim().min(1).max(max);
const Score = (minimum = 0, maximum = 100) => z.number().min(minimum).max(maximum);
const OptionalString = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();

export const CaptureSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('thesis_view'),
    thesis_id: NonEmpty(120),
    stance: z.enum(['bullish', 'bearish', 'neutral']),
    variant: NonEmpty(2000),
    falsifier: NonEmpty(2000),
  }),
  z.object({
    operation: z.literal('prediction'),
    thesis_id: NonEmpty(120),
    statement: NonEmpty(2000),
    key: z.string().trim().min(1).max(120).optional(),
    target_date: OptionalString,
    probability: Score().optional(),
  }),
  z.object({
    operation: z.literal('insight'),
    title: NonEmpty(300),
    summary: NonEmpty(2000),
    slug: z.string().trim().min(1).max(120).optional(),
    insight_type: z.enum(['derived', 'contrarian', 'connection', 'risk']).optional(),
    novelty: Score().optional(),
    confidence: Score().optional(),
    nodes: z.array(z.string()).max(50).optional(),
  }),
  z.object({
    operation: z.literal('relation'),
    src_thesis_id: NonEmpty(120),
    dst_thesis_id: NonEmpty(120),
    relation_type: NonEmpty(80),
    strength: Score(0, 1).optional(),
    rationale: NonEmpty(2000),
  }),
  z.object({
    operation: z.literal('event_decision'),
    event_id: z.coerce.number().int().positive(),
    decision: z.enum(['participate', 'watch', 'skip']),
    rationale: NonEmpty(2000),
    trigger: OptionalString,
  }),
  z.object({
    operation: z.literal('cycle'),
    thesis_id: NonEmpty(120),
    hypothesis: NonEmpty(2000),
    expected_outcome: NonEmpty(2000),
    key: z.string().trim().min(1).max(120).optional(),
    regime: OptionalString,
  }),
  z.object({
    operation: z.literal('lesson'),
    cycle_key: NonEmpty(120),
    thesis_id: NonEmpty(120),
    summary: NonEmpty(2000),
    test_key: OptionalString,
    lesson_type: z.string().trim().min(1).optional(),
    regime: OptionalString,
    incorporated: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('catalog_term'),
    theme_id: NonEmpty(120),
    term: NonEmpty(300),
    term_type: z.string().trim().min(1).optional(),
    weight: Score(1, 100).optional(),
  }),
]);

export type Capture = z.infer<typeof CaptureSchema>;

export async function captureResearch(database: Database, input: Capture): Promise<JsonObject> {
  switch (input.operation) {
    case 'thesis_view': {
      const changed = await database.execute(
        'update theses set stance=$1,variant_perception=$2,falsifier=$3,updated_at=now() where id=$4',
        [input.stance, input.variant, input.falsifier, input.thesis_id],
      );
      if (!changed) throw new Error('unknown thesis');
      return { operation: input.operation, thesis_id: input.thesis_id };
    }
    case 'prediction': {
      const key = input.key || slugify(`${input.thesis_id}-${input.statement}`).slice(0, 90);
      await database.execute(
        `insert into predictions(external_key,thesis_id,statement,target_date,probability,status,created_at,updated_at)
         values($1,$2,$3,$4,$5,'open',now(),now())
         on conflict(external_key) do update set statement=excluded.statement,target_date=excluded.target_date,probability=excluded.probability,updated_at=now()`,
        [key, input.thesis_id, input.statement, input.target_date ?? null, input.probability ?? 50],
      );
      return { operation: input.operation, key };
    }
    case 'insight': {
      const insightSlug = input.slug || slugify(input.title);
      const type = input.insight_type ?? 'derived';
      const rows = await database.query<{ id: number }>(
        `insert into insights(slug,title,summary,insight_type,novelty,confidence,status,created_at,updated_at)
         values($1,$2,$3,$4,$5,$6,'active',now(),now())
         on conflict(slug) do update set title=excluded.title,summary=excluded.summary,insight_type=excluded.insight_type,novelty=excluded.novelty,confidence=excluded.confidence,updated_at=now()
         returning id`,
        [insightSlug, input.title, input.summary, type, input.novelty ?? 50, input.confidence ?? 50],
      );
      for (const node of input.nodes ?? []) {
        await database.execute(
          "insert into insight_links(insight_id,node_id,relationship) values($1,$2,'connects') on conflict do nothing",
          [rows[0].id, node],
        );
      }
      return { operation: input.operation, slug: insightSlug };
    }
    case 'relation': {
      await database.execute(
        `insert into thesis_relations(src_thesis_id,dst_thesis_id,relation_type,strength,rationale,created_at,updated_at)
         values($1,$2,$3,$4,$5,now(),now())
         on conflict(src_thesis_id,dst_thesis_id,relation_type) do update set strength=excluded.strength,rationale=excluded.rationale,updated_at=now()`,
        [input.src_thesis_id, input.dst_thesis_id, input.relation_type, input.strength ?? 0.5, input.rationale],
      );
      return { operation: input.operation, src: input.src_thesis_id, dst: input.dst_thesis_id };
    }
    case 'event_decision': {
      await database.execute(
        `insert into event_decisions(event_id,decision,rationale,participation_trigger,decided_at,updated_at)
         values($1,$2,$3,$4,now(),now())
         on conflict(event_id) do update set decision=excluded.decision,rationale=excluded.rationale,participation_trigger=excluded.participation_trigger,decided_at=now(),updated_at=now()`,
        [input.event_id, input.decision, input.rationale, input.trigger ?? null],
      );
      return { operation: input.operation, event_id: input.event_id };
    }
    case 'cycle': {
      const key = input.key || slugify(`cycle-${input.thesis_id}-${input.hypothesis}`).slice(0, 90);
      await database.execute(
        `insert into research_cycles(external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime,created_at,updated_at)
         values($1,$2,$3,$4,now(),'research','open',1,$5,now(),now())
         on conflict(external_key) do update set hypothesis=excluded.hypothesis,preregistered_outcome=excluded.preregistered_outcome,market_regime=excluded.market_regime,updated_at=now()`,
        [key, input.thesis_id, input.hypothesis, input.expected_outcome, input.regime ?? null],
      );
      return { operation: input.operation, key };
    }
    case 'lesson': {
      const cycle = await database.query<{ id: number }>(
        'select id from research_cycles where external_key=$1',
        [input.cycle_key],
      );
      if (!cycle[0]) throw new Error('unknown cycle');
      await database.execute(
        `insert into research_lessons(cycle_id,test_id,thesis_id,lesson_type,summary,market_regime,incorporated,created_at)
         values($1,(select id from strategy_tests where external_key=$2),$3,$4,$5,$6,$7,now())`,
        [
          cycle[0].id,
          input.test_key ?? null,
          input.thesis_id,
          input.lesson_type ?? 'negative_result',
          input.summary,
          input.regime ?? null,
          input.incorporated === true,
        ],
      );
      return { operation: input.operation, cycle_key: input.cycle_key };
    }
    case 'catalog_term': {
      await database.execute(
        `insert into ontology_terms(theme_id,term,normalized_term,term_type,weight,status,evidence_count,source_count,created_by,created_at,updated_at)
         values($1,$2,$3,$4,$5,'active',1,1,'worker_operator',now(),now())
         on conflict(theme_id,normalized_term) do update set term=excluded.term,term_type=excluded.term_type,weight=excluded.weight,status='active',updated_at=now()`,
        [
          input.theme_id,
          input.term,
          normalizePhrase(input.term),
          input.term_type ?? 'keyword',
          input.weight ?? 60,
        ],
      );
      return { operation: input.operation, theme_id: input.theme_id, term: input.term };
    }
    default: {
      const _exhaustive: never = input;
      throw new Error(`unsupported capture operation: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
