'use client';

import { subscribeDeskRefresh } from '../../lib/desk-realtime';
import type { DeskPayload } from '../../lib/ledger-types';
import { TerminalApp } from './app';
import { SessionControls } from './session-controls';

export function OperatorTerminal({ initial, email }: { initial: DeskPayload; email: string }) {
  return (
    <TerminalApp
      initial={initial}
      chrome={<SessionControls email={email} />}
      subscribeRefresh={subscribeDeskRefresh}
    />
  );
}
