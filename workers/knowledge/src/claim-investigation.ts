import { z } from 'zod';

import {
  AI_MODELS,
  jsonSchemaResponseFormat,
  parseAiJsonObject,
  runAiRole,
  type AiGatewayRunOptions,
} from '@thesisforge/shared/ai';

import type { ClassifiedBookmark } from './ontology-analysis';
import type { XBookmark } from './bookmarks';

export const INVESTIGATION_AI_MODEL = AI_MODELS.investigation;
export const INVESTIGATION_PROMPT_VERSION = 'claim-investigation-v2';
export const MAX_INVESTIGATIONS_PER_SYNC = 8;
export const INVESTIGATION_CONCURRENCY = 2;
export const INVESTIGATION_MIN_MARKET_SCORE = 35;
export const INVESTIGATION_MIN_CLAIM_CONFIDENCE = 50;

const SourceTierSchema = z.enum([
  'sec_ir_regulator',
  'transcript_or_reputable_news',
  'company_or_primary',
  'social_or_x',
  'other',
]);

const CorroborationSchema = z.enum([
  'corroborated',
  'contradicted',
  'partial',
  'unverified',
]);

export const InvestigationSourceSchema = z.object({
  source_id: z.string().trim().min(1).max(64),
  tier: SourceTierSchema,
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().max(2_000).nullable(),
  published_at: z.string().trim().max(64).nullable(),
  excerpt: z.string().trim().min(1).max(1_200),
  supports_claim: z.boolean(),
});

export const ClaimInvestigationSchema = z.object({
  bookmark_id: z.string().trim().min(1),
  claim_status: CorroborationSchema,
  investigation_summary: z.string().trim().min(1).max(2_000),
  symbols: z.array(z.string().trim().min(1).max(16)).max(12),
  sources: z.array(InvestigationSourceSchema).max(16),
  corroborating_source_ids: z.array(z.string()).max(16),
  contradicting_source_ids: z.array(z.string()).max(16),
  open_questions: z.array(z.string().trim().min(1).max(400)).max(8),
  falsifiers: z.array(z.string().trim().min(1).max(400)).max(8),
  /** Explicitly forbidden: ratings, targets, and trade recommendations. */
  trade_recommendation: z.literal('none'),
});

export type ClaimInvestigation = z.infer<typeof ClaimInvestigationSchema>;

export type InvestigatedBookmark = {
  bookmarkId: string;
  model: string;
  promptVersion: string;
  investigation: ClaimInvestigation;
};

const InvestigationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bookmark_id: { type: 'string' },
    claim_status: {
      type: 'string',
      enum: ['corroborated', 'contradicted', 'partial', 'unverified'],
    },
    investigation_summary: { type: 'string' },
    symbols: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source_id: { type: 'string' },
          tier: {
            type: 'string',
            enum: [
              'sec_ir_regulator',
              'transcript_or_reputable_news',
              'company_or_primary',
              'social_or_x',
              'other',
            ],
          },
          title: { type: 'string' },
          url: { type: ['string', 'null'] },
          published_at: { type: ['string', 'null'] },
          excerpt: { type: 'string' },
          supports_claim: { type: 'boolean' },
        },
        required: [
          'source_id',
          'tier',
          'title',
          'url',
          'published_at',
          'excerpt',
          'supports_claim',
        ],
      },
    },
    corroborating_source_ids: { type: 'array', items: { type: 'string' } },
    contradicting_source_ids: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    falsifiers: { type: 'array', items: { type: 'string' } },
    trade_recommendation: { type: 'string', enum: ['none'] },
  },
  required: [
    'bookmark_id',
    'claim_status',
    'investigation_summary',
    'symbols',
    'sources',
    'corroborating_source_ids',
    'contradicting_source_ids',
    'open_questions',
    'falsifiers',
    'trade_recommendation',
  ],
} as const;

export function shouldInvestigateClaim(item: ClassifiedBookmark): boolean {
  if (item.marketScore < INVESTIGATION_MIN_MARKET_SCORE) return false;
  if (!item.claim) return false;
  if (item.claim.type === 'none') return false;
  return item.claim.confidence >= INVESTIGATION_MIN_CLAIM_CONFIDENCE;
}

export function parseClaimInvestigation(
  result: unknown,
  expectedBookmarkId: string,
): ClaimInvestigation {
  const parsed = ClaimInvestigationSchema.parse(parseAiJsonObject(result));
  if (parsed.bookmark_id !== expectedBookmarkId) {
    throw new Error('Investigation output bookmark_id does not match the claim');
  }
  if (parsed.trade_recommendation !== 'none') {
    throw new Error('Investigation output must not include a trade recommendation');
  }
  const sourceIds = new Set(parsed.sources.map((source) => source.source_id));
  for (const id of [...parsed.corroborating_source_ids, ...parsed.contradicting_source_ids]) {
    if (!sourceIds.has(id)) {
      throw new Error(`Investigation cites unknown source_id ${id}`);
    }
  }
  return parsed;
}

function linkedUrls(bookmark: XBookmark): string[] {
  const urls = new Set<string>();
  for (const item of bookmark.entities?.urls || []) {
    const value = item.expanded_url || item.url;
    if (value) urls.add(value.slice(0, 500));
  }
  return [...urls].slice(0, 8);
}

function investigationPrompt(item: ClassifiedBookmark): string {
  return [
    'You are an investigative research agent for equity claims extracted from X bookmarks.',
    'Use web_search to gather corroborating or contradicting primary sources (filings, IR, reputable news, transcripts).',
    'The bookmark tweet is already provided as the social claim — do not treat it as independent corroboration.',
    'Follow linked_urls when present; prefer primary documents over secondary commentary.',
    'Rank sources: SEC/IR/regulators first, transcripts and reputable news second, company/primary third, social/X last.',
    'You must NOT produce ratings, price targets, buy/sell advice, position sizes, or portfolio recommendations.',
    'trade_recommendation must always be the string "none".',
    'Separate the original tweet claim from retrieved evidence. Mark claim_status unverified when evidence is thin.',
    'Every material factual statement in investigation_summary must be backed by a source_id in sources.',
    'Return strict JSON matching the schema. Do not wrap in markdown.',
    `bookmark_id: ${item.bookmark.id}`,
    `tweet_created_at: ${item.createdAt}`,
    `tweet_text: ${JSON.stringify(item.text)}`,
    `extracted_claim: ${JSON.stringify(item.claim)}`,
    `symbols: ${JSON.stringify(item.symbols)}`,
    `linked_urls: ${JSON.stringify(linkedUrls(item.bookmark))}`,
  ].join('\n');
}

async function investigateOne(
  ai: Ai,
  gatewayId: string,
  item: ClassifiedBookmark,
): Promise<InvestigatedBookmark> {
  const result = await runAiRole(
    ai,
    'investigation',
    {
      messages: [{ role: 'user', content: investigationPrompt(item) }],
      max_tokens: 2_500,
      reasoning: { effort: 'low' },
      // OpenAI Responses API hosted search (AI Gateway proxies this for openai/* models).
      tools: [{ type: 'web_search' }],
      response_format: jsonSchemaResponseFormat('claim_investigation', InvestigationJsonSchema),
    },
    {
      gatewayId,
      metadata: {
        prompt_version: INVESTIGATION_PROMPT_VERSION,
        bookmark_id: item.bookmark.id,
      },
      tags: ['thesisforge', 'claim-investigation'],
    } satisfies AiGatewayRunOptions,
  );
  return {
    bookmarkId: item.bookmark.id,
    model: INVESTIGATION_AI_MODEL,
    promptVersion: INVESTIGATION_PROMPT_VERSION,
    investigation: parseClaimInvestigation(result, item.bookmark.id),
  };
}

export async function investigateClaimsWithAi(
  ai: Ai,
  gatewayId: string,
  classified: ClassifiedBookmark[],
): Promise<InvestigatedBookmark[]> {
  const eligible = classified.filter(shouldInvestigateClaim).slice(0, MAX_INVESTIGATIONS_PER_SYNC);
  const output: InvestigatedBookmark[] = [];
  for (let index = 0; index < eligible.length; index += INVESTIGATION_CONCURRENCY) {
    const group = eligible.slice(index, index + INVESTIGATION_CONCURRENCY);
    const settled = await Promise.allSettled(group.map((item) => investigateOne(ai, gatewayId, item)));
    for (const [offset, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        output.push(result.value);
        continue;
      }
      const bookmarkId = group[offset]?.bookmark.id ?? 'unknown';
      console.error(JSON.stringify({
        event: 'claim_investigation_failed',
        bookmark_id: bookmarkId,
        error: result.reason instanceof Error ? result.reason.message : 'unknown',
      }));
    }
  }
  return output;
}
