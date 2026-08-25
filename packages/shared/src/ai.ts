/** Pipeline roles for multi-model reasoning through Cloudflare AI Gateway. */
export const AI_ROLES = [
  'triage',
  'investigation',
  'research',
  'synthesis',
  'synthesis_escalate',
] as const;

export type AiRole = (typeof AI_ROLES)[number];

export const AI_MODELS = {
  triage: '@cf/meta/llama-3.1-8b-instruct-fast',
  investigation: 'xai/grok-4.6',
  research: 'xai/grok-4.6',
  synthesis: 'anthropic/claude-sonnet-4.6',
  synthesis_escalate: 'anthropic/claude-opus-4.6',
} as const satisfies Record<AiRole, string>;

export type AiModelId = (typeof AI_MODELS)[AiRole];

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type AiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiGatewayRunOptions = {
  gatewayId: string;
  skipCache?: boolean;
  collectLog?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  tags?: string[];
  maxAttempts?: number;
};

export type AiRunInputs = {
  messages: AiChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /** Workers AI structured output (Llama / @cf models). */
  guided_json?: Record<string, unknown>;
  /** OpenAI-compatible structured output for third-party models. */
  response_format?: Record<string, unknown>;
  /** Provider server tools (e.g. xAI web_search / x_search). */
  tools?: Array<Record<string, unknown>>;
  /** xAI reasoning effort when supported by the gateway. */
  reasoning?: { effort: ReasoningEffort };
  system?: string;
};

export function modelForRole(role: AiRole): AiModelId {
  return AI_MODELS[role];
}

export function isWorkersAiModel(model: string): boolean {
  return model.startsWith('@cf/');
}

/** Normalize Workers AI / gateway envelopes into a parseable JSON text body. */
export function unwrapAiResponseText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return JSON.stringify(result);
  }
  const record = result as Record<string, unknown>;
  if (typeof record.response === 'string') return record.response;
  // Workers AI JSON mode / guided_json sometimes returns an already-parsed object.
  if (record.response && typeof record.response === 'object') {
    return JSON.stringify(record.response);
  }
  if (typeof record.output_text === 'string') return record.output_text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    const text = record.content
      .flatMap((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
        const block = part as Record<string, unknown>;
        return typeof block.text === 'string' ? [block.text] : [];
      })
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (Array.isArray(record.output)) {
    const text = record.output
      .flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        if (!Array.isArray(row.content)) return [];
        return row.content.flatMap((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
          const block = part as Record<string, unknown>;
          return typeof block.text === 'string' ? [block.text] : [];
        });
      })
      .join('\n')
      .trim();
    if (text) return text;
  }
  return JSON.stringify(result);
}

export function parseAiJsonObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
      return parseAiJsonObject(record.response);
    }
  }

  const text = unwrapAiResponseText(result).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text;
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    throw new Error('AI returned invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI returned non-object JSON');
  }
  const record = value as Record<string, unknown>;
  // Nested envelope after JSON parse (string response that itself wraps payload).
  if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
    return parseAiJsonObject(record.response);
  }
  if (typeof record.response === 'string') {
    return parseAiJsonObject(record.response);
  }
  return record;
}

export function jsonSchemaResponseFormat(
  name: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

type AiBinding = {
  // Cloudflare's generated Ai.run overloads are provider-specific; keep this
  // intentionally wide so Workers can pass env.AI for any gateway model id.
  run(model: string, inputs: Record<string, unknown>, options?: object): Promise<unknown>;
  aiGatewayLogId?: string | null;
};

/** Run a role-selected model through `env.AI` + AI Gateway. */
export async function runAiRole(
  ai: AiBinding,
  role: AiRole,
  inputs: AiRunInputs,
  options: AiGatewayRunOptions,
): Promise<unknown> {
  const model = modelForRole(role);
  const payload: Record<string, unknown> = {
    messages: inputs.messages,
  };
  if (inputs.max_tokens !== undefined) payload.max_tokens = inputs.max_tokens;
  if (inputs.temperature !== undefined) payload.temperature = inputs.temperature;
  if (inputs.system) payload.system = inputs.system;
  if (inputs.guided_json && isWorkersAiModel(model)) payload.guided_json = inputs.guided_json;
  if (inputs.response_format && !isWorkersAiModel(model)) {
    payload.response_format = inputs.response_format;
  }
  if (inputs.tools?.length && !isWorkersAiModel(model)) payload.tools = inputs.tools;
  if (inputs.reasoning && (role === 'investigation' || role === 'research')) {
    payload.reasoning = inputs.reasoning;
  }

  return ai.run(model, payload, {
    gateway: {
      id: options.gatewayId,
      skipCache: options.skipCache ?? true,
      collectLog: options.collectLog ?? true,
      metadata: {
        ai_role: role,
        ai_model: model,
        ...options.metadata,
      },
      retries: {
        maxAttempts: options.maxAttempts ?? 3,
        retryDelayMs: 500,
        backoff: 'exponential',
      },
    },
    tags: options.tags ?? ['thesisforge', role],
  });
}
