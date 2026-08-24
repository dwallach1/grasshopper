import { z } from 'zod';

const MAX_RESPONSE_BYTES = 64 * 1024;

export const PublicationResultSchema = z.object({
  target_id: z.enum(['current', 'cloudflare-shadow']),
  generated_at: z.string().min(1),
  normalized_sha256: z.string().min(1),
  current_normalized_sha256: z.string().min(1).nullable(),
  matches_current: z.boolean(),
  changed_keys: z.array(z.string()),
  thesis_count: z.number(),
  trading_enabled: z.literal(false),
});

export type PublicationResult = z.infer<typeof PublicationResultSchema>;

export function isPublicationResult(value: unknown): value is PublicationResult {
  return PublicationResultSchema.safeParse(value).success;
}

export function parsePublicationResult(value: unknown): PublicationResult {
  return PublicationResultSchema.parse(value);
}

/** Read a bounded JSON body without trusting its shape. Callers must schema-parse. */
export async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Supabase publication response exceeded the size limit');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel('response size limit exceeded');
        throw new Error('Supabase publication response exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  if (!text) return null;
  return JSON.parse(text) as unknown;
}
