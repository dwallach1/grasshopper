import type { ReactNode } from 'react';

import { TerminalShell } from '../terminal/load';

export const dynamic = 'force-dynamic';

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
