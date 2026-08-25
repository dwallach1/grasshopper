import { describe, expect, test } from 'bun:test';

import {
  AI_MODELS,
  modelForRole,
  parseAiJsonObject,
  unwrapAiResponseText,
} from '@thesisforge/shared/ai';

describe('shared AI router helpers', () => {
  test('maps pipeline roles to AI Gateway model ids', () => {
    expect(modelForRole('triage')).toBe(AI_MODELS.triage);
    expect(modelForRole('investigation')).toBe('xai/grok-4.6');
    expect(modelForRole('research')).toBe('xai/grok-4.6');
    expect(modelForRole('synthesis')).toBe('anthropic/claude-sonnet-4.6');
    expect(modelForRole('synthesis_escalate')).toBe('anthropic/claude-opus-4.6');
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
});
