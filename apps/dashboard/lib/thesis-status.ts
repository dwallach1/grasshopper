export const THESIS_STATUSES = ['forming', 'hardening', 'rejected', 'killed'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

const STATUS_SET = new Set<string>(THESIS_STATUSES);

export function isThesisStatus(value: string): value is ThesisStatus {
  return STATUS_SET.has(value);
}

export function parseThesisStatus(value: string): ThesisStatus {
  if (!isThesisStatus(value)) {
    throw new Error(
      `Invalid thesis status '${value}'. Expected forming, hardening, rejected, or killed.`,
    );
  }
  return value;
}
