/**
 * Desk facts → shared StewardAvatar morph params.
 * Board %, live pulse, watching, and an open ticket. Same map for Team + Board.
 */
import { assembleBookOpen } from './book-open-strip';
import {
  stewardMood,
  stewardThinking,
  type StewardMood,
} from './desk-avatar';
import { assembleStewardFreshness, type StewardFreshnessId } from './desk-freshness';
import { assembleLeaderboard } from './desk-leaderboard';
import { deskTeam, isHeartbeatFresh, teamCards } from './desk-team';
import type { DeskPayload } from './ledger-types';

export type StewardFace = {
  mood: StewardMood;
  alive: boolean;
  thinking: boolean;
  attending: boolean;
};

export const QUIET_STEWARD_FACE: StewardFace = {
  mood: 'idle',
  alive: false,
  thinking: false,
  attending: false,
};

export function stewardDeskFaces(desk: DeskPayload, nowMs: number): Map<string, StewardFace> {
  const faces = new Map<string, StewardFace>();
  const cards = teamCards(deskTeam(desk));
  const board = assembleLeaderboard(desk);
  const open = assembleBookOpen(desk);
  const boardBySlug = new Map(board.rows.map((row) => [row.slug, row]));
  const openBySlug = new Map(open.rows.map((row) => [row.slug, row]));
  const activityBySlug = new Map(
    assembleStewardFreshness(desk).map((row) => [row.id, row.activity_at]),
  );

  for (const card of cards) {
    const row = boardBySlug.get(card.slug);
    const tickets = openBySlug.get(card.slug);
    const activity = activityBySlug.get(card.slug as StewardFreshnessId) ?? card.heartbeat_at;
    faces.set(card.slug, {
      mood: stewardMood(row?.return_pct),
      alive: isHeartbeatFresh(activity, nowMs),
      thinking: stewardThinking(card.status),
      attending: (tickets?.tickets.length ?? 0) > 0 || (row?.open_lots ?? 0) > 0,
    });
  }

  for (const row of board.rows) {
    if (faces.has(row.slug)) continue;
    faces.set(row.slug, {
      mood: stewardMood(row.return_pct),
      alive: false,
      thinking: false,
      attending: row.open_lots > 0,
    });
  }

  for (const row of open.rows) {
    const prev = faces.get(row.slug) ?? QUIET_STEWARD_FACE;
    faces.set(row.slug, {
      ...prev,
      attending: prev.attending || row.tickets.length > 0,
    });
  }

  return faces;
}

export function stewardDeskFace(desk: DeskPayload, slug: string, nowMs: number): StewardFace {
  return stewardDeskFaces(desk, nowMs).get(slug) ?? QUIET_STEWARD_FACE;
}
