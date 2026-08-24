import { describe, expect, test } from 'bun:test';

import {
  approvedTradeProposals,
  autonomousExecutionActive,
  parseAutonomousExecutionResult,
  parseBrokerOrderAudit,
  parseCloudTask,
  parsePositionAiOutput,
  parsePositionConfiguration,
  parseTheses,
  parseThesisAiOutput,
} from './schemas';

describe('research cloud-control schemas', () => {
  test('parses theses and approved proposals from context', () => {
    const context = {
      snapshot: {
        generated_at: '2026-08-24T12:00:00Z',
        payload: {
          theses: [{
            id: 'power',
            name: 'Power',
            summary: 'Data-center electricity demand',
            confidence: 80,
            stance: 'bullish',
            symbols: ['VST'],
          }],
        },
      },
      approved_proposals: [{
        id: 7,
        thesis_id: 'power',
        symbol: 'vst',
        side: 'buy',
        notional: 250,
        rationale: 'fresh catalyst',
        created_at: '2026-08-24T12:01:00Z',
        broker_alerts: { position_action: 'open' },
      }],
      risk_controls: [{
        control_key: 'autonomous-execution',
        status: 'active',
        enforcement_level: 'code',
      }],
    };
    expect(parseTheses(context)).toEqual([expect.objectContaining({ id: 'power', symbols: ['VST'] })]);
    expect(approvedTradeProposals(context)[0]).toMatchObject({
      id: 7,
      symbol: 'VST',
      side: 'buy',
      positionAction: 'open',
    });
    expect(autonomousExecutionActive(context)).toBe(true);
  });

  test('fails closed on invalid stored DO payloads', () => {
    expect(parsePositionConfiguration(JSON.stringify({
      positionKey: 'a:VST',
      episodeId: 'ep-1',
      symbol: 'VST',
      accountKey: 'rh:abc',
      nextReviewAt: null,
    })).symbol).toBe('VST');
    expect(() => parsePositionConfiguration('{"positionKey":"missing"}')).toThrow('invalid');
    expect(parseAutonomousExecutionResult(JSON.stringify({
      refId: 'ref-1',
      status: 'submitted',
      accountKey: 'rh:abc',
      brokerOrderId: 'ord-1',
      orderJson: '{}',
      reviewJson: '{}',
      submittedAt: '2026-08-24T12:00:00Z',
    })).brokerOrderId).toBe('ord-1');
    expect(() => parseAutonomousExecutionResult('{"status":"submitted"}')).toThrow('invalid');
  });

  test('parses broker order audit fills', () => {
    const { fills } = parseBrokerOrderAudit(
      JSON.stringify({
        executions: [
          { id: 'fill-1', quantity: 2, price: 10.5, timestamp: '2026-08-24T15:00:00Z' },
          { quantity: -1, price: 10 },
        ],
      }),
      JSON.stringify({ order_checks: {} }),
    );
    expect(fills).toEqual([expect.objectContaining({ id: 'fill-1', quantity: 2, price: 10.5 })]);
  });

  test('parses thesis AI output and fails closed on garbage', () => {
    expect(parseThesisAiOutput({
      response: JSON.stringify({
        material_change: true,
        trade_decision: 'buy',
        symbol: 'VST',
        notional_percent: 2,
        decision_confidence: 90,
      }),
    })).toMatchObject({ material_change: true, trade_decision: 'buy', symbol: 'VST' });
    expect(parseThesisAiOutput('not-json')).toMatchObject({
      material_change: false,
      risks: ['unstructured_model_output'],
    });
  });

  test('parses position AI output and defaults to hold on garbage', () => {
    expect(parsePositionAiOutput({
      response: JSON.stringify({
        position_action: 'reduce',
        decision_confidence: 80,
        thesis_state: 'weakening',
        summary: 'risk rising',
      }),
    }).position_action).toBe('reduce');
    expect(parsePositionAiOutput('@@@')).toMatchObject({
      position_action: 'hold',
      decision_confidence: 0,
    });
  });

  test('parses cloud queue tasks and rejects unknown kinds', () => {
    const task = parseCloudTask({
      kind: 'thesis_research',
      runId: 'run-1',
      idempotencyKey: 'run-1:thesis:power',
      contextVersion: 'v1',
      marketSlot: 'midday',
      thesis: {
        id: 'power',
        name: 'Power',
        summary: 'Demand',
        symbols: ['VST'],
      },
    });
    expect(task.kind).toBe('thesis_research');
    expect(() => parseCloudTask({ kind: 'unknown', runId: 'x' })).toThrow();
  });
});
