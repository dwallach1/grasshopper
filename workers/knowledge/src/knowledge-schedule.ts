export type KnowledgeScheduleGate = {
  date: string;
  time: string;
  weekday: string;
  slot: 'morning_ingest' | 'pre_close_ingest' | null;
  actionable: boolean;
  reason: string;
};

export function knowledgeScheduleGate(timestamp: number): KnowledgeScheduleGate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';
  const time = `${get('hour')}:${get('minute')}`;
  const weekday = get('weekday');
  const slots = new Map<KnowledgeScheduleGate['time'], Exclude<KnowledgeScheduleGate['slot'], null>>([
    ['09:35', 'morning_ingest'],
    ['14:35', 'pre_close_ingest'],
  ]);
  const slot = slots.get(time) ?? null;
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const actionable = isWeekday && slot !== null;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time,
    weekday,
    slot,
    actionable,
    reason: actionable ? 'scheduled_knowledge_window' : isWeekday ? 'dst_guard_or_unscheduled_time' : 'weekend',
  };
}
