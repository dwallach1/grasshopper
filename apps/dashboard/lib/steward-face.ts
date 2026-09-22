/**
 * Desk facts → shared StewardAvatar morph params.
 * Presence is the one signal. Board, Team, and Book read the same map.
 */
import type { StewardMood } from './desk-avatar';
import type { DeskPayload } from './ledger-types';
import {
  stewardPresence,
  stewardPresences,
  type StewardPresence,
  type StewardPresenceState,
} from './steward-presence';

export type StewardFace = {
  presence: StewardPresence;
  settle: number;
  mood: StewardMood;
  alive: boolean;
  thinking: boolean;
  attending: boolean;
};

export const QUIET_STEWARD_FACE: StewardFace = {
  presence: 'idle',
  settle: 0,
  mood: 'idle',
  alive: false,
  thinking: false,
  attending: false,
};

export function stewardDeskFaces(desk: DeskPayload, nowMs: number): Map<string, StewardFace> {
  const faces = new Map<string, StewardFace>();
  for (const [slug, state] of stewardPresences(desk, nowMs)) {
    faces.set(slug, faceFromPresence(state));
  }
  return faces;
}

export function stewardDeskFace(desk: DeskPayload, slug: string, nowMs: number): StewardFace {
  return faceFromPresence(stewardPresence(desk, slug, nowMs));
}

function faceFromPresence(state: StewardPresenceState): StewardFace {
  return {
    presence: state.presence,
    settle: state.settle,
    mood: 'idle',
    alive: state.presence === 'working' || state.presence === 'done',
    thinking: false,
    attending: state.presence === 'waiting',
  };
}
