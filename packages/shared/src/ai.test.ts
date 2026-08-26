import { describe, expect, test } from 'bun:test';

import {
  AI_MODELS,
  isOpenAiResponsesModel,
  modelForRole,
  parseAiJsonObject,
  unwrapAiResponseText,
} from '@thesisforge/shared/ai';

describe('shared AI router helpers', () => {
  test('maps pipeline roles to AI Gateway model ids', () => {
    expect(modelForRole('triage')).toBe('openai/gpt-5.6-sol');
    expect(modelForRole('investigation')).toBe('openai/gpt-5.6-sol');
    expect(modelForRole('research')).toBe('openai/gpt-5.6-sol');
    expect(modelForRole('synthesis')).toBe('openai/gpt-5.6-sol');
    expect(modelForRole('synthesis_escalate')).toBe('openai/gpt-5.6-sol');
    expect(isOpenAiResponsesModel('openai/gpt-5.6-sol')).toBe(true);
    expect(isOpenAiResponsesModel('@cf/meta/llama-3.1-8b-instruct-fast')).toBe(false);
  });

  test('unwraps Workers AI and Anthropic-style envelopes', () => {
    expect(unwrapAiResponseText({ response: '{"ok":true}' })).toBe('{"ok":true}');
    expect(unwrapAiResponseText({
      content: [{ type: 'text', text: '{"a":1}' }],
    })).toBe('{"a":1}');
    expect(unwrapAiResponseText({ response: { analyses: [{ id: 1 }] } }))
      .toBe('{"analyses":[{"id":1}]}');
    expect(parseAiJsonObject({ response: '```json\n{"material_change":false}\n```' }))
      .toEqual({ material_change: false });
    expect(parseAiJsonObject({ response: { analyses: [{ bookmark_id: 'b1' }] } }))
      .toEqual({ analyses: [{ bookmark_id: 'b1' }] });
  });

  test('unwraps OpenAI Responses API envelopes', () => {
    expect(unwrapAiResponseText({
      output_text: '{"stance":"neutral"}',
    })).toBe('{"stance":"neutral"}');
    expect(parseAiJsonObject({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '{"trade_decision":"no_trade"}' }],
      }],
    })).toEqual({ trade_decision: 'no_trade' });
  });
});
