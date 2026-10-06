'use client';

import type { MoneyUnit } from '../../lib/money-units';
import { formatUsd, signedAmount } from '../../lib/money-units';
import {
  hitLabel,
  passedBetCopy,
  SCORECARD_THIN_N,
  thesisCalibrationText,
  type StewardScorecardCard,
  type ThesisScoreRow,
} from '../../lib/steward-scorecard';
import { pnlClass } from './format';

/** Whole dollars / 3-dp SOL for the week strip — the exact figure lives in Realized. */
export function compactSigned(value: number, unit: MoneyUnit): string {
  if (unit === 'SOL') {
    const text = Math.abs(value).toFixed(3);
    if (value > 0) return `+${text}`;
    if (value < 0) return `-${text}`;
    return '0';
  }
  const rounded = Math.round(value);
  if (rounded === 0) return '$0';
  const text = formatUsd(Math.abs(rounded)).replace(/\.00$/, '');
  return rounded > 0 ? `+${text}` : `-${text}`;
}

function signed(value: number | null, unit: MoneyUnit): string {
  if (value === null) return 'not in ledger';
  return signedAmount(value, unit);
}

function thesisLabel(row: ThesisScoreRow): string {
  const name = row.name && row.name.length <= 24 ? row.name : null;
  const raw = name ?? row.thesis_id.replace(/[_-]+/g, ' ');
  return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
}

export function StewardScorecard({
  card,
  name,
}: {
  card: StewardScorecardCard;
  name: string;
}) {
  const { unit } = card;
  const passed = passedBetCopy(card.skips, card.steward);
  return (
    <section className="score-card" data-steward={card.steward} aria-label={`${name} scorecard`}>
      <header className="score-head">
        <p className="score-kicker">Scorecard</p>
        <span className="score-count">
          {card.trades} closed · {unit}
        </span>
        {card.not_from_fills > 0 && (
          <span className="score-badge is-quality" title="Closed trades priced from cash delta, settlement, or reconstruction instead of venue fills">
            {card.not_from_fills} of {card.trades} not from fills
          </span>
        )}
      </header>

      {card.weeks.length > 0 && (
        <ol className="score-weeks" aria-label="Last four weeks">
          {card.weeks.map((week) => (
            <li key={week.label} className={week.current ? 'is-current' : undefined}>
              <i>{week.label}</i>
              <b className={week.trades ? pnlClass(week.pnl) : 'muted'}>
                {week.trades ? compactSigned(week.pnl, unit) : '—'}
              </b>
              <span>
                {week.trades}t · {hitLabel(week.hit_rate)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <dl className="score-stats">
        <div>
          <dt>Expectancy</dt>
          <dd>
            <b className={pnlClass(card.expectancy)}>{signed(card.expectancy, unit)}</b>
            <span className="score-unit">/trade</span>
            {card.thin && <span className="score-badge">thin (n&lt;{SCORECARD_THIN_N})</span>}
          </dd>
        </div>
        <div>
          <dt>Realized</dt>
          <dd><b className={pnlClass(card.realized)}>{signed(card.realized, unit)}</b></dd>
        </div>
        <div>
          <dt>Unrealized</dt>
          <dd>
            <b className={pnlClass(card.open_positions ? card.unrealized : null)}>
              {card.open_positions ? signed(card.unrealized, unit) : '—'}
            </b>
            <span className="score-unit">{card.open_positions} open</span>
          </dd>
        </div>
        {card.fees && (
          <div className="score-wide">
            <dt>Fees</dt>
            <dd>
              {card.fees.recorded !== null && card.fees.recorded > 0
                ? <b>{signedAmount(-card.fees.recorded, unit)}</b>
                : <b className="muted">not captured</b>}
              {card.fees.missing > 0 && (
                <span className="score-unit">
                  {card.fees.noun === 'fills'
                    ? `fee_sol missing on ${card.fees.missing} fills`
                    : `fee_sol 0 on ${card.fees.missing} of ${card.fees.of}`}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      {card.theses.length > 0 && (
        <ul className="score-theses" aria-label="Thesis calibration: stated (or expected from entry odds) vs realized">
          {card.theses.map((row) => {
            const calibration = thesisCalibrationText(row);
            return (
              <li
                key={row.thesis_id}
                className={row.miscalibrated ? 'is-off' : undefined}
                title={calibration.title}
              >
                {thesisLabel(row)}
                <b>{calibration.value}</b>
                <i>n{row.priced_trades}</i>
              </li>
            );
          })}
        </ul>
      )}

      {passed && (passed.lead || passed.missing) && (
        <p className="score-skips" title="What one contract, one share, or one token would have made from the price at the decision. A plus means passing on it left money on the table.">
          {passed.lead}
          {passed.won && <> · {passed.won}</>}
          {passed.pnl !== null && (
            <>
              {' · '}
              <b className={pnlClass(passed.pnl)}>{signed(passed.pnl, unit)}</b>
              {passed.unitNote && <span className="score-unit"> {passed.unitNote}</span>}
            </>
          )}
          {passed.missing && <>{passed.lead ? ' · ' : ''}{passed.missing}</>}
        </p>
      )}
    </section>
  );
}
