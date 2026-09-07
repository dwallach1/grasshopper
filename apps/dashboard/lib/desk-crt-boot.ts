/**
 * Public-desk CRT boot copy. Short staged phosphor log from the snapshot.
 * No invented marks — steward lines only appear when the board already ranks them.
 */
import { assembleLeaderboard } from './desk-leaderboard';
import type { DeskPayload } from './ledger-types';

function bootPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export const CRT_BOOT_STEP_MS = 420;
export const CRT_BOOT_HOLD_MS = 560;
export const CRT_BOOT_FADE_MS = 420;
export const CRT_BOOT_FIRST_MS = 160;

export type CrtBootLine = {
  id: string;
  label: string;
  status: string;
};

export function padCrtDots(label: string, status: string, width = 32): string {
  const used = label.length + status.length + 2;
  const dots = Math.max(2, width - used);
  return `${label} ${'.'.repeat(dots)} ${status}`;
}

export function assembleCrtBoot(desk: DeskPayload | null): CrtBootLine[] {
  const lines: CrtBootLine[] = [
    { id: 'desk', label: 'GRASSHOPPER', status: 'READY' },
    { id: 'snap', label: 'LOCAL SNAPSHOT', status: desk ? 'LINK' : 'WAIT' },
    { id: 'ledger', label: 'LEDGER ONLINE', status: desk ? 'OK' : 'HOLD' },
  ];
  if (!desk) return lines;
  const lead = assembleLeaderboard(desk).rows.find((row) => row.place === 1 && row.ranked);
  if (!lead || lead.return_pct === null) return lines;
  lines.push({
    id: `lead:${lead.id}`,
    label: lead.steward,
    status: bootPct(lead.return_pct),
  });
  return lines;
}

export function crtBootDurationMs(lineCount: number): number {
  if (lineCount <= 0) return CRT_BOOT_HOLD_MS + CRT_BOOT_FADE_MS;
  const steps = CRT_BOOT_FIRST_MS + Math.max(0, lineCount - 1) * CRT_BOOT_STEP_MS;
  return steps + CRT_BOOT_HOLD_MS + CRT_BOOT_FADE_MS;
}

let playedThisLoad = false;

export function takeCrtBootSlot(): boolean {
  if (playedThisLoad) return false;
  playedThisLoad = true;
  return true;
}

export function resetCrtBootSlot(): void {
  playedThisLoad = false;
}
