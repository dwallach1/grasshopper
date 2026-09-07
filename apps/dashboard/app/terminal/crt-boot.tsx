'use client';

import { useEffect, useState } from 'react';

import {
  assembleCrtBoot,
  CRT_BOOT_FADE_MS,
  CRT_BOOT_FIRST_MS,
  CRT_BOOT_HOLD_MS,
  CRT_BOOT_STEP_MS,
  padCrtDots,
  type CrtBootLine,
} from '../../lib/desk-crt-boot';
import type { DeskPayload } from '../../lib/ledger-types';

export function CrtBoot({
  desk,
  onDone,
}: {
  desk: DeskPayload | null;
  onDone: () => void;
}) {
  const lines = assembleCrtBoot(desk);
  const warming = desk === null;
  const [shown, setShown] = useState(warming ? 1 : 0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (warming || leaving) return undefined;
    if (shown < lines.length) {
      const wait = shown === 0 ? CRT_BOOT_FIRST_MS : CRT_BOOT_STEP_MS;
      const id = window.setTimeout(() => setShown((count) => count + 1), wait);
      return () => window.clearTimeout(id);
    }
    const hold = window.setTimeout(() => setLeaving(true), CRT_BOOT_HOLD_MS);
    return () => window.clearTimeout(hold);
  }, [leaving, lines.length, shown, warming]);

  useEffect(() => {
    if (!leaving) return undefined;
    const id = window.setTimeout(onDone, CRT_BOOT_FADE_MS);
    return () => window.clearTimeout(id);
  }, [leaving, onDone]);

  return (
    <div
      className={`crt-boot${leaving ? ' is-out' : ''}${warming ? ' is-warm' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Grasshopper desk boot"
    >
      <div className="crt-boot-tube crt-scan" aria-hidden="true" />
      <div className="crt-boot-frame">
        <span className="crt-boot-corner crt-boot-corner-tl" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-tr" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-bl" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-br" aria-hidden="true" />
        <p className="crt-boot-kicker">{warming ? 'UPLINK' : 'DESK OPEN'}</p>
        <ol className="crt-boot-log">
          {lines.map((line, index) => (
            <CrtBootRow
              key={line.id}
              line={line}
              visible={warming ? index === 0 : index < shown}
              active={!warming && !leaving && index === shown - 1}
            />
          ))}
        </ol>
        <p className="crt-boot-bar" aria-hidden="true">
          {slashBar(warming ? 2 : shown, lines.length)}
        </p>
      </div>
    </div>
  );
}

function CrtBootRow({
  line,
  visible,
  active,
}: {
  line: CrtBootLine;
  visible: boolean;
  active: boolean;
}) {
  if (!visible) {
    return <li className="crt-boot-row is-wait" aria-hidden="true">&nbsp;</li>;
  }
  return (
    <li className={`crt-boot-row${active ? ' is-on' : ''}`}>
      <span>{padCrtDots(line.label, line.status)}</span>
    </li>
  );
}

function slashBar(shown: number, total: number): string {
  const cells = 18;
  const filled = Math.max(1, Math.round((shown / Math.max(1, total)) * cells));
  return `${'/'.repeat(filled)}${'-'.repeat(Math.max(0, cells - filled))}`;
}
