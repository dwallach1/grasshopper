'use client';

import { useEffect, useState } from 'react';

import { fetchDeskPayload } from '../../lib/desk-client';
import type { DeskPayload } from '../../lib/ledger-types';
import { TerminalApp } from './app';
import { CrtBoot } from './crt-boot';
import { DeskLiveline } from './desk-liveline';

export function PublicTerminal() {
  const [desk, setDesk] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [boot, setBoot] = useState(true);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduceMotion(reduce);
    if (reduce) setBoot(false);
  }, []);

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
        <p className="term-brand">GRASSHOPPER</p>
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
    if (reduceMotion) {
      return (
        <main className="line-boot">
          <p className="term-brand">GRASSHOPPER</p>
          <DeskLiveline unit="USD" loading emptyText="waiting for published snapshot" showValue={false} />
        </main>
      );
    }
    return <CrtBoot desk={null} onDone={() => undefined} />;
  }

  return (
    <>
      {boot && <CrtBoot desk={desk} onDone={() => setBoot(false)} />}
      <TerminalApp initial={desk} publicView />
    </>
  );
}
