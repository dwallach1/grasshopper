export const THESIS_STATUSES = ['forming', 'hardening', 'rejected', 'killed'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

export const LIVE_THESIS_STATUSES = ['forming', 'hardening'] as const;
export type LiveThesisStatus = (typeof LIVE_THESIS_STATUSES)[number];

const STATUS_SET = new Set<string>(THESIS_STATUSES);
const LIVE = new Set<string>(LIVE_THESIS_STATUSES);

export function isThesisStatus(value: string): value is ThesisStatus {
  return STATUS_SET.has(value);
}

export function isLiveThesisStatus(status: string): boolean {
  return LIVE.has(status);
}

export function isLiveThesis(row: { status: string }): boolean {
  return isLiveThesisStatus(row.status);
}

export function parseThesisStatus(value: string): ThesisStatus {
  if (!isThesisStatus(value)) {
    throw new Error(
      `Invalid thesis status '${value}'. Expected forming, hardening, rejected, or killed.`,
    );
  }
  return value;
}
