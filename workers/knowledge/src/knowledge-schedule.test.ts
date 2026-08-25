import { describe, expect, test } from 'bun:test';

import { knowledgeScheduleGate } from './knowledge-schedule';

describe('New York knowledge schedule gate', () => {
  test('accepts the summer morning ingestion window', () => {
    expect(knowledgeScheduleGate(Date.parse('2026-08-25T13:35:00Z'))).toMatchObject({
      time: '09:35', slot: 'morning_ingest', actionable: true,
    });
  });

  test('accepts the winter morning ingestion window', () => {
    expect(knowledgeScheduleGate(Date.parse('2026-12-07T14:35:00Z'))).toMatchObject({
      time: '09:35', slot: 'morning_ingest', actionable: true,
    });
  });

  test('accepts the summer pre-close ingestion window', () => {
    expect(knowledgeScheduleGate(Date.parse('2026-08-25T18:35:00Z'))).toMatchObject({
      time: '14:35', slot: 'pre_close_ingest', actionable: true,
    });
  });

  test('rejects the paired UTC candidate that misses New York time', () => {
    expect(knowledgeScheduleGate(Date.parse('2026-08-25T14:35:00Z'))).toMatchObject({
      time: '10:35', slot: null, actionable: false,
    });
  });

  test('rejects weekends', () => {
    expect(knowledgeScheduleGate(Date.parse('2026-08-22T13:35:00Z'))).toMatchObject({
      weekday: 'Sat', actionable: false, reason: 'weekend',
    });
  });
});
