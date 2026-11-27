import { usEquitySession, type UsEquitySession } from '@quantanamo/contracts/market-calendar';

import { bundleIsFresh } from '../../../supabase/functions/desk-public-rest/bundle-cache';

export type MarketSessionHealth = {
  /** True only inside the NYSE core session, including a half day before its early close. */
  open: boolean;
  status: UsEquitySession['status'];
  /** America/New_York calendar day, YYYY-MM-DD. */
  date: string;
  early_close: boolean;
  /** Core-session close in ET, `13:00` on an early close and `16:00` on a full day. Null when the day is closed. */
  close_et: string | null;
  /** Holiday or early-close name from the NYSE calendar. Null on an ordinary day. */
  name: string | null;
};

export type BundleHealthFields = {
  bundle_generated_at: string;
  bundle_age_s: number | null;
  /** True when the served book is older than the fresh window. This is cache age, not a dead ledger. */
  bundle_stale: boolean;
  /** True when a single-flight refresh is in progress and this answer is still the previous book. */
  bundle_refreshing: boolean;
  ledger_snapshot_at: string | null;
  ledger_mark_at: string | null;
  ledger_snapshot_age_s: number | null;
  ledger_mark_age_s: number | null;
  market_session: MarketSessionHealth;
};

function minutesToEt(minutes: number | null): string | null {
  if (minutes == null) return null;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Whole seconds since `iso`. A clock skew of a few minutes counts as zero. Unparseable is null. */
export function ageSeconds(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const delta = now - parsed;
  if (delta < 0) return 0;
  return Math.floor(delta / 1000);
}

/** NYSE session at `now`. Same calendar as public.us_equity_market_calendar. */
export function marketSessionHealth(now: number): MarketSessionHealth {
  const session = usEquitySession(now);
  return {
    open: session.status === 'open',
    status: session.status,
    date: session.date,
    early_close: session.calendar?.kind === 'early_close',
    close_et: minutesToEt(session.closeMinutes),
    name: session.calendar?.name ?? null,
  };
}

/** True during the core session, when the cron should touch the public bundle. */
export function shouldWarmDeskBundle(now: number): boolean {
  return usEquitySession(now).status === 'open';
}

export function bundleHealthFields(input: {
  generated_at: string;
  bundle_refreshing?: boolean;
  ledger_snapshot_at?: string | null;
  ledger_mark_at?: string | null;
}, now: number): BundleHealthFields {
  const bundleAge = ageSeconds(input.generated_at, now);
  return {
    bundle_generated_at: input.generated_at,
    bundle_age_s: bundleAge,
    bundle_stale: !bundleIsFresh(input.generated_at, now),
    bundle_refreshing: input.bundle_refreshing === true,
    ledger_snapshot_at: input.ledger_snapshot_at ?? null,
    ledger_mark_at: input.ledger_mark_at ?? null,
    ledger_snapshot_age_s: ageSeconds(input.ledger_snapshot_at, now),
    ledger_mark_age_s: ageSeconds(input.ledger_mark_at, now),
    market_session: marketSessionHealth(now),
  };
}
