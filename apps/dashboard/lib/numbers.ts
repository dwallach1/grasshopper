/** Coerce Postgres numerics (often text) into finite numbers without `typeof`. */

export function asFiniteNumber(value: string | number | null | undefined, field: string): number {
  if (value === null || value === undefined) {
    throw new Error(`Invalid number ${field}: empty`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number ${field}: ${String(value)}`);
  }
  return n;
}

export function asOptionalNumber(
  value: string | number | null | undefined,
  field: string,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  return asFiniteNumber(value, field);
}

export function asSmallint(value: string | number, field: string): number {
  const n = asFiniteNumber(value, field);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`Invalid smallint ${field}: ${String(value)}`);
  }
  return n;
}

export function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

export function requireIso(value: Date | string | null | undefined, field: string): string {
  const iso = isoTimestamp(value);
  if (!iso) throw new Error(`Missing timestamp ${field}`);
  return iso;
}
