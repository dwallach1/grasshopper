'use client';

import { useMemo } from 'react';

import { MARK_NOT_IN_LEDGER, NOT_IN_LEDGER } from '../../lib/book-performance';
import { slabTone, type BookSlab } from '../../lib/book-slabs';
import { ledgerFigure, moneyPrecise, pnlClass, qty, signedMoney } from './format';

const TONE_HEX = {
  up: '#3ddc84',
  down: '#ff5c33',
  neutral: '#5b9fd4',
  cash: '#ffb000',
} as const;

function plateSize(mass: number, maxMass: number): number {
  if (maxMass <= 0 || mass <= 0) return 22;
  return 22 + Math.sqrt(mass / maxMass) * 58;
}

export function BookLotTiles({
  slabs,
  selectedId,
  onSelect,
}: {
  slabs: readonly BookSlab[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const maxMass = useMemo(
    () => Math.max(1, ...slabs.map((row) => row.mass)),
    [slabs],
  );

  return (
    <div className="term-lot-tiles">
      {slabs.map((slab, index) => {
        const tone = slabTone(slab);
        const size = plateSize(slab.mass, maxMass);
        const costSize = plateSize(slab.cost ?? 0, maxMass);
        const selected = selectedId === slab.id;
        return (
          <button
            type="button"
            key={slab.id}
            className={selected ? 'term-lot-tile sel' : 'term-lot-tile'}
            onClick={() => onSelect(selected ? null : slab.id)}
          >
            <header>
              <b>{String(index + 1).padStart(2, '0')} · {slab.symbol}</b>
              <span>{slab.kind === 'cash' ? slab.note : qty(slab.quantity)}</span>
            </header>
            <div className="term-lot-frame" aria-hidden="true">
              <i className="term-lot-crosshair" />
              {slab.kind === 'lot' && slab.cost !== null && (
                <span
                  className="term-lot-plate cost"
                  style={{ width: costSize, height: costSize * 0.72 }}
                />
              )}
              <span
                className={`term-lot-plate mark ${slab.muted ? 'muted' : tone}`}
                style={{
                  width: size,
                  height: size * 0.72,
                  borderColor: TONE_HEX[tone],
                  background: slab.muted ? 'transparent' : `${TONE_HEX[tone]}22`,
                }}
              />
            </div>
            <dl>
              <div>
                <dt>w</dt>
                <dd>{ledgerFigure(slab.mass, moneyPrecise)}</dd>
              </div>
              <div>
                <dt>mark</dt>
                <dd>{slab.kind === 'cash'
                  ? (slab.notional === null ? NOT_IN_LEDGER : moneyPrecise(slab.notional))
                  : (slab.mark === null ? MARK_NOT_IN_LEDGER : moneyPrecise(slab.mark))}
                </dd>
              </div>
              <div>
                <dt>Δ</dt>
                <dd className={pnlClass(slab.pnl)}>
                  {slab.kind === 'cash' ? slab.note : (slab.pnl === null ? NOT_IN_LEDGER : signedMoney(slab.pnl))}
                </dd>
              </div>
            </dl>
          </button>
        );
      })}
    </div>
  );
}
