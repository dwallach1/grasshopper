const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const currencyPrecise = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const qtyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const nyDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const nyTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return currency.format(value);
}

export function moneyPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return currencyPrecise.format(value);
}

export function qty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return qtyFormat.format(value);
}

export function nyStamp(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  return `${nyDate.format(new Date(timestamp))} ET`;
}

export function nyClock(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  return nyTime.format(new Date(timestamp));
}

export function age(timestamp: string | undefined, now: number | null): string {
  if (!timestamp || now === null) return 'n/a';
  const elapsed = Math.max(0, now - new Date(timestamp).getTime());
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function until(timestamp: string, now: number): string {
  const delta = new Date(timestamp).getTime() - now;
  if (delta <= 0) return 'due';
  if (delta < 3_600_000) return `${Math.max(1, Math.ceil(delta / 60_000))}m`;
  if (delta < 86_400_000) {
    const hours = Math.floor(delta / 3_600_000);
    const minutes = Math.ceil((delta % 3_600_000) / 60_000);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return nyStamp(timestamp);
}

export function titleCase(value: string | null | undefined): string {
  return (value || '')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function toneForStatus(status: string): 'up' | 'down' | 'warn' | 'muted' {
  const value = status.toLowerCase();
  if (['hardening', 'filled', 'open', 'passed', 'survived', 'complete', 'active', 'supporting'].includes(value)) {
    return 'up';
  }
  if (['killed', 'rejected', 'failed', 'blocked', 'challenging'].includes(value)) return 'down';
  if (['forming', 'queued', 'running', 'watching', 'skipped'].includes(value)) return 'warn';
  return 'muted';
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}
