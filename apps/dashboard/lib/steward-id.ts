/**
 * Team ID-card face. Ledger roster only — never the fallback identity cast.
 * Domain is one of Stocks / Predictions / Coins / Crypto. No P/L, hold, or beat.
 */
import { currentStewards, teamCards } from './desk-team';
import type { DeskPayload, DeskTeamPayload } from './ledger-types';

export const STEWARD_ID_DOMAINS = ['Stocks', 'Predictions', 'Coins', 'Crypto'] as const;
export type StewardIdDomain = (typeof STEWARD_ID_DOMAINS)[number];

export type StewardIdCard = {
  slug: string;
  display_name: string;
  domain: StewardIdDomain;
  accent: string;
};

export function stewardDomainFace(slug: string, name = ''): StewardIdDomain | null {
  return domainToken(slug) ?? domainToken(name);
}

export function stewardSlugFace(slug: string): StewardIdDomain | null {
  switch (slug.trim().toLowerCase()) {
    case 'quantanamo':
      return 'Stocks';
    case 'oddsborne':
      return 'Predictions';
    case 'bandit':
      return 'Coins';
    case 'cointanamo':
      return 'Crypto';
    default:
      return null;
  }
}

function domainToken(raw: string): StewardIdDomain | null {
  switch (raw.trim().toLowerCase()) {
    case 'equity':
    case 'stock':
    case 'stocks':
      return 'Stocks';
    case 'prediction':
    case 'predictions':
      return 'Predictions';
    case 'meme':
    case 'meme coins':
    case 'coin':
    case 'coins':
      return 'Coins';
    case 'crypto':
      return 'Crypto';
    default:
      return null;
  }
}

function isFallbackAgent(agent: { id?: string; meta?: { source?: unknown } }): boolean {
  if (agent.meta?.source === 'fallback') return true;
  return (agent.id ?? '').startsWith('fallback-');
}

function ledgerRoster(desk: Pick<DeskPayload, 'team'>): DeskTeamPayload | null {
  const raw = desk.team;
  if (!raw || !Array.isArray(raw.agents) || raw.agents.length === 0) return null;
  const agents = raw.agents.filter((agent) => !isFallbackAgent(agent));
  if (agents.length === 0) return null;
  return {
    agents,
    domains: raw.domains ?? [],
    stewards: currentStewards(raw.stewards ?? []),
    accounts: raw.accounts ?? [],
  };
}

/** Published `desk_agents` only. Empty roster → no cards. */
export function stewardIdCards(desk: Pick<DeskPayload, 'team'>): StewardIdCard[] {
  const roster = ledgerRoster(desk);
  if (!roster) return [];
  return teamCards(roster).flatMap((card) => {
    const primary = card.domains.find((row) => row.is_primary) ?? card.domains[0];
    const domain = (primary ? stewardDomainFace(primary.slug, primary.name) : null)
      ?? stewardSlugFace(card.slug);
    if (!domain) return [];
    return [{
      slug: card.slug,
      display_name: card.display_name,
      domain,
      accent: card.accent,
    }];
  });
}
