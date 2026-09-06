'use client';

import { useEffect, useState } from 'react';

import { fetchDeskPayload } from '../../lib/desk-client';
import type { DeskPayload } from '../../lib/ledger-types';
import { TerminalApp } from './app';
import { DeskLiveline } from './desk-liveline';

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
      <main className="line-boot">
        <p className="line-kicker">grasshopper</p>
        <DeskLiveline
          unit="USD"
          loading={false}
          emptyText="snapshot not in ledger"
          showValue={false}
        />
        <p className="line-caption">Published snapshot only. The site does not query the live ledger.</p>
      </main>
    );
  }

  if (!desk) {
    return (
      <main className="line-boot">
        <p className="line-kicker">grasshopper</p>
        <DeskLiveline unit="USD" loading emptyText="waiting for published snapshot" showValue={false} />
      </main>
    );
  }

  return <TerminalApp initial={desk} publicView />;
}
