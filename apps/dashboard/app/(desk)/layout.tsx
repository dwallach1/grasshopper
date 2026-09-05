import type { ReactNode } from 'react';

import { isPublicDesk } from '../../lib/desk-mode';
import { TerminalShell } from '../terminal/load';

export const dynamic = isPublicDesk() ? 'force-static' : 'force-dynamic';

export default async function DeskLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <TerminalShell />
      {children}
    </>
  );
}
