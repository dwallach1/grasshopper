import type { Database } from './database';
import { normalizePhrase, slugify } from './ontology';
import { isJsonString, type JsonObject, type JsonValue } from '@thesisforge/shared/json';

export type Capture = JsonObject & { operation: string };

function requiredString(input: Capture, key: string, max = 2000): string {
  const value = input[key];
  if (!isJsonString(value) || !value.trim() || value.length > max) throw new Error(`${key} is required`);
  return value.trim();
}

function boundedNumber(value: JsonValue | undefined, fallback: number, minimum = 0, maximum = 100): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`number must be between ${minimum} and ${maximum}`);
  return number;
}

export async function captureResearch(database: Database, input: Capture): Promise<JsonObject> {
  switch (input.operation) {
    case 'thesis_view': {
      const thesisId = requiredString(input, 'thesis_id', 120);
      const stance = requiredString(input, 'stance', 12);
      if (!['bullish', 'bearish', 'neutral'].includes(stance)) throw new Error('invalid stance');
      const changed = await database.execute('update theses set stance=$1,variant_perception=$2,falsifier=$3,updated_at=now() where id=$4', [stance, requiredString(input, 'variant'), requiredString(input, 'falsifier'), thesisId]);
      if (!changed) throw new Error('unknown thesis');
      return { operation: input.operation, thesis_id: thesisId };
    }
    case 'prediction': {
      const thesisId = requiredString(input, 'thesis_id', 120);
      const statement = requiredString(input, 'statement');
      const key = isJsonString(input.key) && input.key ? input.key : slugify(`${thesisId}-${statement}`).slice(0, 90);
      await database.execute(`insert into predictions(external_key,thesis_id,statement,target_date,probability,status,created_at,updated_at) values($1,$2,$3,$4,$5,'open',now(),now()) on conflict(external_key) do update set statement=excluded.statement,target_date=excluded.target_date,probability=excluded.probability,updated_at=now()`, [key, thesisId, statement, input.target_date || null, boundedNumber(input.probability, 50)]);
      return { operation: input.operation, key };
    }
    case 'insight': {
      const title = requiredString(input, 'title', 300);
      const insightSlug = isJsonString(input.slug) && input.slug ? input.slug : slugify(title);
      const type = isJsonString(input.insight_type) ? input.insight_type : 'derived';
      if (!['derived','contrarian','connection','risk'].includes(type)) throw new Error('invalid insight_type');
      const rows = await database.query<{ id: number }>(`insert into insights(slug,title,summary,insight_type,novelty,confidence,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'active',now(),now()) on conflict(slug) do update set title=excluded.title,summary=excluded.summary,insight_type=excluded.insight_type,novelty=excluded.novelty,confidence=excluded.confidence,updated_at=now() returning id`, [insightSlug, title, requiredString(input, 'summary'), type, boundedNumber(input.novelty, 50), boundedNumber(input.confidence, 50)]);
      const nodes = Array.isArray(input.nodes) ? input.nodes.filter(isJsonString).slice(0, 50) : [];
      for (const node of nodes) await database.execute("insert into insight_links(insight_id,node_id,relationship) values($1,$2,'connects') on conflict do nothing", [rows[0].id, node]);
      return { operation: input.operation, slug: insightSlug };
    }
    case 'relation': {
      const src = requiredString(input, 'src_thesis_id', 120);
      const dst = requiredString(input, 'dst_thesis_id', 120);
      const relation = requiredString(input, 'relation_type', 80);
      await database.execute(`insert into thesis_relations(src_thesis_id,dst_thesis_id,relation_type,strength,rationale,created_at,updated_at) values($1,$2,$3,$4,$5,now(),now()) on conflict(src_thesis_id,dst_thesis_id,relation_type) do update set strength=excluded.strength,rationale=excluded.rationale,updated_at=now()`, [src, dst, relation, boundedNumber(input.strength, 0.5, 0, 1), requiredString(input, 'rationale')]);
      return { operation: input.operation, src, dst };
    }
    case 'event_decision': {
      const decision = requiredString(input, 'decision', 20);
      if (!['participate','watch','skip'].includes(decision)) throw new Error('invalid decision');
      await database.execute(`insert into event_decisions(event_id,decision,rationale,participation_trigger,decided_at,updated_at) values($1,$2,$3,$4,now(),now()) on conflict(event_id) do update set decision=excluded.decision,rationale=excluded.rationale,participation_trigger=excluded.participation_trigger,decided_at=now(),updated_at=now()`, [Number(input.event_id), decision, requiredString(input, 'rationale'), input.trigger || null]);
      return { operation: input.operation, event_id: Number(input.event_id) };
    }
    case 'cycle': {
      const thesisId = requiredString(input, 'thesis_id', 120);
      const hypothesis = requiredString(input, 'hypothesis');
      const key = isJsonString(input.key) && input.key ? input.key : slugify(`cycle-${thesisId}-${hypothesis}`).slice(0, 90);
      await database.execute(`insert into research_cycles(external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime,created_at,updated_at) values($1,$2,$3,$4,now(),'research','open',1,$5,now(),now()) on conflict(external_key) do update set hypothesis=excluded.hypothesis,preregistered_outcome=excluded.preregistered_outcome,market_regime=excluded.market_regime,updated_at=now()`, [key, thesisId, hypothesis, requiredString(input, 'expected_outcome'), input.regime || null]);
      return { operation: input.operation, key };
    }
    case 'lesson': {
      const cycleKey = requiredString(input, 'cycle_key', 120);
      const cycle = await database.query<{ id: number }>('select id from research_cycles where external_key=$1', [cycleKey]);
      if (!cycle[0]) throw new Error('unknown cycle');
      await database.execute(`insert into research_lessons(cycle_id,test_id,thesis_id,lesson_type,summary,market_regime,incorporated,created_at) values($1,(select id from strategy_tests where external_key=$2),$3,$4,$5,$6,$7,now())`, [cycle[0].id, input.test_key || null, requiredString(input, 'thesis_id', 120), isJsonString(input.lesson_type) ? input.lesson_type : 'negative_result', requiredString(input, 'summary'), input.regime || null, input.incorporated === true]);
      return { operation: input.operation, cycle_key: cycleKey };
    }
    case 'catalog_term': {
      const themeId = requiredString(input, 'theme_id', 120);
      const term = requiredString(input, 'term', 300);
      await database.execute(`insert into ontology_terms(theme_id,term,normalized_term,term_type,weight,status,evidence_count,source_count,created_by,created_at,updated_at) values($1,$2,$3,$4,$5,'active',1,1,'worker_operator',now(),now()) on conflict(theme_id,normalized_term) do update set term=excluded.term,term_type=excluded.term_type,weight=excluded.weight,status='active',updated_at=now()`, [themeId, term, normalizePhrase(term), isJsonString(input.term_type) ? input.term_type : 'keyword', boundedNumber(input.weight, 60, 1, 100)]);
      return { operation: input.operation, theme_id: themeId, term };
    }
    default:
      throw new Error('unsupported capture operation');
  }
}
