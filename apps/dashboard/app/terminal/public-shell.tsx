'use client';

import { useEffect, useState } from 'react';

import { fetchDeskPayload } from '../../lib/desk-client';
import type { DeskPayload } from '../../lib/ledger-types';
import { TerminalApp } from './app';

export function PublicTerminal() {
  const [desk, setDesk] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDeskPayload()
      .then((payload) => {
        if (!cancelled) setDesk(payload);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Desk snapshot unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="data-unavailable">
        <section>
          <b>Public desk</b>
          <h1>Snapshot unavailable</h1>
          <p>This site reads a published snapshot only. It does not query the live ledger.</p>
          <p><code>{error}</code></p>
        </section>
      </main>
    );
  }

  if (!desk) {
    return (
      <main className="data-unavailable">
        <section>
          <b className="term-brand">GRASSHOPPER</b>
          <h1>Desk</h1>
          <p>Loading the published snapshot. Marks stay blank until the ledger includes them.</p>
        </section>
      </main>
    );
  }

  return <TerminalApp initial={desk} publicView />;
}
