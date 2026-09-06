/**
 * Map `desk_agents` / `desk_domains` / `desk_domain_stewards` / `desk_accounts`
 * into the Team surface. Stewardship is soft: current rows have `ended_at` null.
 * Never invent a mark, NAV, or P/L.
 */
import type {
  DeskAccountCatalogRow,
  DeskAgentRow,
  DeskDomainRow,
  DeskPayload,
  DeskStewardRow,
  DeskTeamPayload,
  JsonBag,
} from './ledger-types';
import { asFiniteNumber, requireIso } from './numbers';

export const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;

export type DeskTeamDomainChip = {
  slug: string;
  name: string;
  kind: string;
  accent: string;
  is_primary: boolean;
  accounts: Array<{
    account_key: string;
    label: string;
    currency: string;
  }>;
};

export type DeskTeamCard = {
  slug: string;
  display_name: string;
  role_title: string;
  charter: string;
  accent: string;
  avatar_key: string;
  status: string;
  heartbeat_at: string | null;
  domains: DeskTeamDomainChip[];
};

export function emptyTeam(): DeskTeamPayload {
  return {
    agents: [],
    domains: [],
    stewards: [],
    accounts: [],
  };
}

/** Identity copy only — no heartbeat, marks, or account P/L. */
export function fallbackTeam(): DeskTeamPayload {
  const ledger = fallbackDomain('fallback-ledger', 'ledger', 'Ledger', 'ops', '#7dd3a7', 5, 'Schema, desk, public phone view, cross-domain integrity.');
  const equity = fallbackDomain('fallback-equity', 'equity', 'Stocks', 'trading', '#5b8def', 10, 'Equities / broker book. Domain stays even if the steward changes.');
  const prediction = fallbackDomain('fallback-prediction', 'prediction', 'Predictions', 'trading', '#c084fc', 20, 'Prediction markets. Steward is soft-assigned.');
  const grasshopper = fallbackAgent(
    'fallback-grasshopper',
    'grasshopper',
    'GRASSHOPPER',
    'Ledger steward',
    'Owns the shared ledger schema, desk UX, and public phone view. Keeps domains and stewards consistent — not the trader for a book.',
    '#7dd3a7',
    'grasshopper',
    'active',
    1,
  );
  const quantanamo = fallbackAgent(
    'fallback-quantanamo',
    'quantanamo',
    'QUANTANAMO',
    'Equities trader',
    'Research, theses, and live trades on the equity book (Robinhood). Domain: Stocks.',
    '#5b8def',
    'quant',
    'active',
    2,
  );
  const oddsborne = fallbackAgent(
    'fallback-oddsborne',
    'oddsborne',
    'ODDSBORNE',
    'Prediction markets trader',
    'Polymarket US and future prediction venues. Domain: Predictions — steward can rotate without a migration.',
    '#c084fc',
    'odds',
    'watching',
    3,
  );
  return {
    agents: [grasshopper, quantanamo, oddsborne],
    domains: [ledger, equity, prediction],
    stewards: [
      fallbackSteward('fallback-steward-ledger', ledger.id, grasshopper.id),
      fallbackSteward('fallback-steward-equity', equity.id, quantanamo.id),
      fallbackSteward('fallback-steward-prediction', prediction.id, oddsborne.id),
    ],
    accounts: [],
  };
}

export function currentStewards(rows: DeskStewardRow[]): DeskStewardRow[] {
  return rows.filter((row) => row.ended_at === null);
}

export function assembleTeam(input: {
  agents: unknown[];
  domains: unknown[];
  stewards: unknown[];
  accounts: unknown[];
}): DeskTeamPayload {
  const mapped: DeskTeamPayload = {
    agents: mapAgents(input.agents),
    domains: mapDomains(input.domains),
    stewards: currentStewards(mapStewards(input.stewards)),
    accounts: mapAccounts(input.accounts),
  };
  if (mapped.agents.length === 0) return fallbackTeam();
  return mapped;
}

export function deskTeam(desk: Pick<DeskPayload, 'team'>): DeskTeamPayload {
  const raw = desk.team;
  if (!raw || !Array.isArray(raw.agents) || raw.agents.length === 0) {
    return fallbackTeam();
  }
  return {
    agents: raw.agents,
    domains: raw.domains ?? [],
    stewards: currentStewards(raw.stewards ?? []),
    accounts: raw.accounts ?? [],
  };
}

export function teamCards(team: DeskTeamPayload): DeskTeamCard[] {
  const domains = new Map(team.domains.map((row) => [row.id, row]));
  const accountsByDomain = new Map<string, DeskAccountCatalogRow[]>();
  for (const account of team.accounts) {
    const list = accountsByDomain.get(account.domain_id) ?? [];
    list.push(account);
    accountsByDomain.set(account.domain_id, list);
  }
  return [...team.agents]
    .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
    .map((agent) => {
      const chips = team.stewards
        .filter((row) => row.agent_id === agent.id)
        .map((row) => {
          const domain = domains.get(row.domain_id);
          if (!domain) return null;
          return {
            slug: domain.slug,
            name: domain.name,
            kind: domain.kind,
            accent: domain.accent,
            is_primary: row.is_primary,
            accounts: (accountsByDomain.get(domain.id) ?? []).map((account) => ({
              account_key: account.account_key,
              label: account.label,
              currency: account.currency,
            })),
          } satisfies DeskTeamDomainChip;
        })
        .filter((row): row is DeskTeamDomainChip => row !== null)
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name));
      return {
        slug: agent.slug,
        display_name: agent.display_name,
        role_title: agent.role_title,
        charter: agent.charter,
        accent: agent.accent,
        avatar_key: agent.avatar_key,
        status: agent.status,
        heartbeat_at: agent.heartbeat_at,
        domains: chips,
      };
    });
}

export function isHeartbeatFresh(heartbeatAt: string | null | undefined, nowMs: number): boolean {
  if (!heartbeatAt) return false;
  const at = Date.parse(heartbeatAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at >= 0 && nowMs - at < HEARTBEAT_FRESH_MS;
}

export function clipCharter(charter: string, max = 160): string {
  const text = charter.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function mapAgents(rows: unknown[]): DeskAgentRow[] {
  return asObjects(rows).map((row) => ({
    id: asText(row.id, 'desk_agents.id'),
    slug: asText(row.slug, 'desk_agents.slug'),
    display_name: asText(row.display_name, 'desk_agents.display_name'),
    role_title: asText(row.role_title, 'desk_agents.role_title'),
    charter: optionalText(row.charter),
    accent: optionalText(row.accent) || '#7dd3a7',
    avatar_key: optionalText(row.avatar_key) || 'spark',
    status: optionalText(row.status) || 'active',
    heartbeat_at: optionalIso(row.heartbeat_at, 'desk_agents.heartbeat_at'),
    sort_order: asOrder(row.sort_order),
    meta: asMeta(row.meta),
  }));
}

function mapDomains(rows: unknown[]): DeskDomainRow[] {
  return asObjects(rows).map((row) => ({
    id: asText(row.id, 'desk_domains.id'),
    slug: asText(row.slug, 'desk_domains.slug'),
    name: asText(row.name, 'desk_domains.name'),
    kind: asText(row.kind, 'desk_domains.kind'),
    description: optionalText(row.description),
    accent: optionalText(row.accent) || '#7dd3a7',
    status: optionalText(row.status) || 'active',
    sort_order: asOrder(row.sort_order),
    meta: asMeta(row.meta),
  }));
}

function mapStewards(rows: unknown[]): DeskStewardRow[] {
  return asObjects(rows).map((row) => ({
    id: asText(row.id, 'desk_domain_stewards.id'),
    domain_id: asText(row.domain_id, 'desk_domain_stewards.domain_id'),
    agent_id: asText(row.agent_id, 'desk_domain_stewards.agent_id'),
    is_primary: row.is_primary === true || row.is_primary === 1 || row.is_primary === 'true',
    assigned_at: requireIso(row.assigned_at as string | Date, 'desk_domain_stewards.assigned_at'),
    ended_at: optionalIso(row.ended_at, 'desk_domain_stewards.ended_at'),
    note: row.note === null || row.note === undefined ? null : optionalText(row.note),
  }));
}

function mapAccounts(rows: unknown[]): DeskAccountCatalogRow[] {
  return asObjects(rows).map((row) => ({
    id: asText(row.id, 'desk_accounts.id'),
    domain_id: asText(row.domain_id, 'desk_accounts.domain_id'),
    account_key: asText(row.account_key, 'desk_accounts.account_key'),
    label: asText(row.label, 'desk_accounts.label'),
    currency: optionalText(row.currency) || 'USD',
    status: optionalText(row.status) || 'active',
  }));
}

function fallbackDomain(
  id: string,
  slug: string,
  name: string,
  kind: string,
  accent: string,
  sort_order: number,
  description: string,
): DeskDomainRow {
  return {
    id,
    slug,
    name,
    kind,
    description,
    accent,
    status: 'active',
    sort_order,
    meta: { source: 'fallback' },
  };
}

function fallbackAgent(
  id: string,
  slug: string,
  display_name: string,
  role_title: string,
  charter: string,
  accent: string,
  avatar_key: string,
  status: string,
  sort_order: number,
): DeskAgentRow {
  return {
    id,
    slug,
    display_name,
    role_title,
    charter,
    accent,
    avatar_key,
    status,
    heartbeat_at: null,
    sort_order,
    meta: { source: 'fallback' },
  };
}

function fallbackSteward(id: string, domain_id: string, agent_id: string): DeskStewardRow {
  return {
    id,
    domain_id,
    agent_id,
    is_primary: true,
    assigned_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    note: 'fallback',
  };
}

function asObjects(rows: unknown[]): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

function asText(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`Invalid text ${field}`);
}

function optionalText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function optionalIso(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return requireIso(value as string | Date, field);
}

function asOrder(value: unknown): number {
  if (value === null || value === undefined || value === '') return 100;
  return asFiniteNumber(value as string | number, 'sort_order');
}

function asMeta(value: unknown): JsonBag {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonBag;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonBag;
      }
    } catch {
      return {};
    }
  }
  return {};
}
