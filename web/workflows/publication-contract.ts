export type PublicationResult = {
  target_id: 'current' | 'cloudflare-shadow';
  generated_at: string;
  normalized_sha256: string;
  current_normalized_sha256: string | null;
  matches_current: boolean;
  changed_keys: string[];
  thesis_count: number;
  trading_enabled: false;
};

const MAX_RESPONSE_BYTES = 64 * 1024;

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
  return text ? JSON.parse(text) : null;
}

export function isPublicationResult(value: unknown): value is PublicationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PublicationResult>;
  return (
    (result.target_id === 'current' || result.target_id === 'cloudflare-shadow') &&
    typeof result.generated_at === 'string' &&
    typeof result.normalized_sha256 === 'string' &&
    (result.current_normalized_sha256 === null ||
      typeof result.current_normalized_sha256 === 'string') &&
    typeof result.matches_current === 'boolean' &&
    Array.isArray(result.changed_keys) &&
    result.changed_keys.every((key) => typeof key === 'string') &&
    typeof result.thesis_count === 'number' &&
    result.trading_enabled === false
  );
}
