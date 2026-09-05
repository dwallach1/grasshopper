import type { ReactNode } from 'react';

import { TerminalShell } from '../terminal/load';

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
