'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { holdingTicket } from '../../lib/book-holdings';
import { assembleBookOpen, type BookOpenTicket } from '../../lib/book-open-strip';
import { isMarkStale } from '../../lib/desk-freshness';
import type { DeskPayload, LessonRow } from '../../lib/ledger-types';
import { formatAmount } from '../../lib/money-units';
import {
  assembleStewardBooks,
  beliefKindText,
  changeText,
  headerAmount,
  leanText,
  lessonGapText,
  lotLine,
  lotAmount,
  lotPnl,
  lotsForThesis,
  plainThesisName,
  plainWords,
  riskText,
  sizeNumber,
  sizeUnit,
  statusText,
  type BooksIdea,
  type BooksLot,
  type BooksSection,
  type StewardBooks,
} from '../../lib/steward-books';
import type { ThesisRosterRow } from '../../lib/thesis-roster';
import { CandidateReviewQueue } from './candidate-review';
import { DeskLiveline } from './desk-liveline';
import { age, pnlClass } from './format';
import { LessonQueue } from './lesson-queue';

/** What a tap opened: a position (with its thesis) or a thesis on its own. */
type Reading =
  | { kind: 'lot'; id: string }
  | { kind: 'idea'; id: string };

const LESSONS_SHOWN = 5;

/**
 * Book: one page per steward replacing the old Book and Theses tabs.
 * Header line, then open positions as one or two sentences (why it is held,
 * and the exit). Rule names, the score, and a prediction's full question
 * stay in the detail. One watched idea is its own line; several fold until
 * opened. The operator-only review queue renders only when `canReview`
 * (never on the public desk).
 */
export function BookPanel({
  desk,
  nowIso,
  canReview = false,
  canIncorporate = false,
  onReviewed,
}: {
  desk: DeskPayload;
  nowIso?: string;
  canReview?: boolean;
  canIncorporate?: boolean;
  onReviewed?: () => void;
}) {
  const nowMs = Date.parse(nowIso ?? desk.generated_at);
  const books = useMemo(() => assembleStewardBooks(desk, nowMs), [desk, nowMs]);
  const tickets = useMemo(() => assembleBookOpen(desk).rows.flatMap((row) => row.tickets), [desk]);
  const [reading, setReading] = useState<Reading | null>(null);
  const detailRef = useRef<HTMLElement>(null);

  const lotById = useMemo(() => {
    const map = new Map<string, { lot: BooksLot; section: BooksSection }>();
    for (const section of books.sections) {
      for (const lot of [...section.open, ...section.closed]) map.set(lot.holding.id, { lot, section });
    }
    return map;
  }, [books]);
  const ideaById = useMemo(() => {
    const map = new Map<string, { idea: BooksIdea; section: BooksSection }>();
    for (const section of books.sections) {
      for (const idea of [...section.watching, ...section.set_aside]) map.set(idea.thesis.id, { idea, section });
    }
    return map;
  }, [books]);

  const lotHit = reading?.kind === 'lot' ? lotById.get(reading.id) : undefined;
  const ideaHit = reading?.kind === 'idea' ? ideaById.get(reading.id) : undefined;
  const open = Boolean(lotHit || ideaHit);

  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [reading]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setReading(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="books-stage" data-reading={open ? '1' : '0'}>
      <div
        className="books"
        data-desk-nested-scroll="1"
        aria-hidden={open ? true : undefined}
      >
        <h1 className="visually-hidden">Book</h1>
        <header className="books-mast">
          <p className="paper-title">Book</p>
        </header>
        {books.sections.map((section) => (
          <StewardSection
            key={section.slug}
            section={section}
            onOpenLot={(id) => setReading({ kind: 'lot', id })}
            onOpenIdea={(id) => setReading({ kind: 'idea', id })}
          />
        ))}
        {canReview || canIncorporate ? (
          <Fold label="Operator review" className="books-operator">
            {canReview ? (
              <CandidateReviewQueue desk={desk} canReview={canReview} onReviewed={onReviewed} />
            ) : null}
            <LessonQueue desk={desk} canIncorporate={canIncorporate} onIncorporated={onReviewed} />
          </Fold>
        ) : null}
      </div>
      {lotHit ? (
        <BooksDetail
          ref={detailRef}
          books={books}
          section={lotHit.section}
          lot={lotHit.lot}
          thesis={lotHit.lot.thesis}
          ticket={holdingTicket(lotHit.lot.holding, tickets)}
          markedAt={lotHit.lot.holding.venue === 'equity' && lotHit.lot.holding.life === 'live' ? desk.book.observed_at : null}
          now={nowMs}
          onClose={() => setReading(null)}
          onOpenLot={(id) => setReading({ kind: 'lot', id })}
        />
      ) : ideaHit ? (
        <BooksDetail
          ref={detailRef}
          books={books}
          section={ideaHit.section}
          thesis={ideaHit.idea.thesis}
          now={nowMs}
          onClose={() => setReading(null)}
          onOpenLot={(id) => setReading({ kind: 'lot', id })}
        />
      ) : null}
    </div>
  );
}

function StewardSection({
  section,
  onOpenLot,
  onOpenIdea,
}: {
  section: BooksSection;
  onOpenLot: (id: string) => void;
  onOpenIdea: (id: string) => void;
}) {
  const change = changeText(section.return_pct);
  const lessonGaps = lessonGapText(section.lesson_gaps);
  const watched = section.watching.length === 1 ? section.watching[0] : undefined;
  return (
    <section className="books-steward" data-steward={section.slug} aria-label={section.name}>
      <header className="books-head">
        <h2 className="books-name">{section.name}</h2>
        <p className="books-line">
          <span>{section.value === null ? 'value not in ledger' : headerAmount(section.value, section.unit)}</span>
          {change ? (
            <>
              <span className="books-sep" aria-hidden="true"> · </span>
              <span className={pnlClass(section.return_pct)}>{change}</span>
            </>
          ) : null}
          {section.risk ? (
            <>
              <span className="books-sep" aria-hidden="true"> · </span>
              <span
                className="books-risk"
                title={section.risk.risk_basis === 'full_notional'
                  ? 'Open positions counted at full value (prices can jump past the exit) against a budget of 10% of the book.'
                  : 'Loss if every position hit its exit price, against a budget of 10% of the book.'}
              >
                {riskText(section.risk)}
              </span>
            </>
          ) : null}
          {section.over ? <em className="books-over"> · over budget</em> : null}
          {lessonGaps ? (
            <>
              <span className="books-sep" aria-hidden="true"> · </span>
              <span className="books-risk">{lessonGaps}</span>
            </>
          ) : null}
        </p>
      </header>
      {section.open.length ? (
        <ul className="books-lots" aria-label={`${section.name} open positions`}>
          {section.open.map((lot) => (
            <li key={lot.holding.id}>
              <LotRow lot={lot} onOpen={onOpenLot} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="books-none">Nothing open right now.</p>
      )}
      {section.checks.length ? (
        <ul className="books-checks" aria-label={`${section.name} things to check`}>
          {section.checks.map((row) => (
            <li key={row.id} className={row.tone === 'plain' ? undefined : `books-check-${row.tone}`}>{row.text}</li>
          ))}
        </ul>
      ) : null}
      {watched ? (
        <ul className="books-ideas">
          <li><IdeaRow idea={watched} onOpen={onOpenIdea} watch /></li>
        </ul>
      ) : section.watching.length > 1 ? (
        <Fold label={`Watching · ${section.watching.length} ideas`}>
          <ul className="books-ideas">
            {section.watching.map((idea) => (
              <li key={idea.thesis.id}><IdeaRow idea={idea} onOpen={onOpenIdea} /></li>
            ))}
          </ul>
        </Fold>
      ) : null}
      {section.set_aside.length ? (
        <Fold label={`Not watching · ${section.set_aside.length} ${section.set_aside.length === 1 ? 'idea' : 'ideas'}`}>
          <ul className="books-ideas is-aside">
            {section.set_aside.map((idea) => (
              <li key={idea.thesis.id}><IdeaRow idea={idea} onOpen={onOpenIdea} /></li>
            ))}
          </ul>
        </Fold>
      ) : null}
      {section.closed.length ? (
        <Fold label={`Closed · ${section.closed.length}`}>
          <ul className="books-lots is-closed">
            {section.closed.map((lot) => (
              <li key={lot.holding.id}><LotRow lot={lot} onOpen={onOpenLot} /></li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </section>
  );
}

function Fold({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`books-fold ${className}`.trim()} data-open={open ? '1' : '0'}>
      <button
        type="button"
        className="books-fold-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <i aria-hidden="true">{open ? 'hide' : 'show'}</i>
      </button>
      {open ? <div className="books-fold-body">{children}</div> : null}
    </div>
  );
}

function LotRow({ lot, onOpen }: { lot: BooksLot; onOpen: (id: string) => void }) {
  const h = lot.holding;
  const amount = lotAmount(h);
  const pnl = lotPnl(h);
  return (
    <button
      type="button"
      className="books-lot"
      data-lot={h.id}
      data-life={h.life}
      onClick={() => onOpen(h.id)}
    >
      <span className="books-lot-top">
        <b>{lot.name}</b>
        {amount ? <span className="books-lot-amt">{amount}</span> : null}
        <span className={`books-lot-pnl ${pnlClass(pnl.sign)}`}>{pnl.text}</span>
      </span>
      <span className="books-lot-why">{lotLine(lot)}</span>
    </button>
  );
}

function IdeaRow({
  idea,
  onOpen,
  watch = false,
}: {
  idea: BooksIdea;
  onOpen: (id: string) => void;
  watch?: boolean;
}) {
  return (
    <button
      type="button"
      className="books-idea"
      data-thesis={idea.thesis.id}
      data-watch={watch ? '1' : undefined}
      onClick={() => onOpen(idea.thesis.id)}
    >
      <b>{watch ? `Watching · ${idea.name}` : idea.name}</b>
    </button>
  );
}

function BooksDetail({
  ref,
  books,
  section,
  lot,
  thesis,
  ticket,
  markedAt = null,
  now,
  onClose,
  onOpenLot,
}: {
  ref: Ref<HTMLElement>;
  books: StewardBooks;
  section: BooksSection;
  lot?: BooksLot;
  thesis: ThesisRosterRow | null;
  ticket?: BookOpenTicket;
  markedAt?: string | null;
  now: number;
  onClose: () => void;
  onOpenLot: (id: string) => void;
}) {
  const h = lot?.holding;
  const title = lot ? lot.name : thesis ? plainTitle(thesis) : '';
  const kicker = h
    ? `${section.name} · ${h.life === 'closed' ? 'closed position' : 'open position'}`
    : `${section.name} · ${thesis?.live ? 'watching' : 'set aside'}`;
  const marked = ticket?.marked_at ?? markedAt;
  return (
    <article ref={ref} className="books-detail thesis-page" data-desk-nested-scroll="1" aria-label={title}>
      <button type="button" className="thesis-page-back" onClick={onClose}>
        Back to book
      </button>
      <p className="thesis-page-kicker">{kicker}</p>
      <h2>{title}</h2>
      {lot?.question ? <p className="books-question">{lot.question}</p> : null}
      {h ? (
        <>
          <dl className="books-facts">
            <Fact label="Size" value={h.size === null ? '—' : `${sizeNumber(h.size)} ${sizeUnit(h)}`} />
            <Fact label="Paid" value={h.cost === null ? '—' : formatAmount(h.cost, h.unit)} />
            <Fact label={h.life === 'closed' ? 'Last price' : 'Price now'} value={h.mark === null ? '—' : formatAmount(h.mark, h.unit)} />
            {h.life === 'live' ? <Fact label="Value" value={lotAmount(h)} /> : null}
            <Fact label="P/L" value={lotPnl(h).text} tone={pnlClass(lotPnl(h).sign)} />
            {lot?.exit ? <Fact label="Exit" value={lot.exit} /> : null}
            {marked ? (
              <Fact
                label="Priced"
                value={`${age(marked, now)} ago${isMarkStale(marked, now) ? ' (old)' : ''}`}
              />
            ) : null}
          </dl>
          {ticket?.drawable ? (
            <div className="books-chart" aria-label={`${title} price since entry`}>
              <DeskLiveline
                compact
                points={ticket.points}
                value={ticket.value}
                series={ticket.overlays}
                unit={ticket.unit}
                color={ticket.color}
                showValue={false}
                referenceLine={ticket.cost === null ? undefined : { value: ticket.cost, label: formatAmount(ticket.cost, ticket.unit) }}
                emptyText="not in ledger"
                className="book-open-line"
              />
            </div>
          ) : null}
          {h.invalidation?.note ? (
            <p className="books-note"><b>Exit plan</b> {h.invalidation.note}</p>
          ) : null}
          {h.note ? <p className="books-note">{h.note}</p> : null}
          {h.rules_in_force.length ? (
            <p className="books-note"><b>Rules in force</b> {h.rules_in_force.map(plainWords).join(' · ')}</p>
          ) : null}
          {h.life === 'closed' && lot?.lesson_waiting ? (
            <p className="books-note is-muted">No lesson written yet.</p>
          ) : null}
          {h.life === 'closed' && h.clip_note ? (
            <>
              <p className="books-note">
                <b>{h.clip_note.kind === 'lesson' ? 'Lesson' : 'Belief'}</b> {h.clip_note.summary}
              </p>
              {h.clip_note.belief ? (
                <p className="books-note"><b>Belief</b> {h.clip_note.belief.summary}</p>
              ) : null}
            </>
          ) : null}
          {h.life === 'closed' && !h.clip_note && !lot?.lesson_waiting ? (
            <p className="books-note is-muted">No lesson written on close.</p>
          ) : null}
          {!thesis ? (
            <p className="books-note is-muted">{lot?.why ? `${capitalize(lot.why)}.` : 'No thesis linked.'}</p>
          ) : null}
        </>
      ) : null}
      {thesis ? (
        <ThesisBody
          thesis={thesis}
          nested={Boolean(h)}
          track={lot?.track.label ?? trackFor(books, thesis.id)}
          backtest={lot?.track.backtest ?? backtestFor(books, thesis.id)}
          wins={scoreWins(books, thesis.id)}
          lots={lotsForThesis(books, thesis.id).filter((row) => row.holding.id !== h?.id)}
          lessons={books.lessons_by_thesis.get(thesis.id) ?? []}
          onOpenLot={onOpenLot}
        />
      ) : null}
    </article>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone}>{value}</dd>
    </div>
  );
}

function ThesisBody({
  thesis,
  nested,
  track,
  backtest,
  wins,
  lots,
  lessons,
  onOpenLot,
}: {
  thesis: ThesisRosterRow;
  nested: boolean;
  track: string;
  backtest: string | null;
  wins: number | null;
  lots: BooksLot[];
  lessons: LessonRow[];
  onOpenLot: (id: string) => void;
}) {
  const [allLessons, setAllLessons] = useState(false);
  const shown = allLessons ? lessons : lessons.slice(0, LESSONS_SHOWN);
  return (
    <section className="books-thesis" aria-label="Thesis">
      {nested ? (
        <>
          <p className="books-section-label">Why</p>
          <h3>{plainTitle(thesis)}</h3>
        </>
      ) : null}
      <p className="thesis-page-kicker">
        {statusText(thesis.status)} · {leanText(thesis.stance)} · {thesis.domain}
      </p>
      <p>{thesis.summary}</p>
      {thesis.falsifier ? (
        <p className="thesis-page-falsifier"><b>Wrong if</b> {thesis.falsifier}</p>
      ) : null}
      <p className="books-track">
        Track record: {track}
        {wins !== null ? ` · ${wins} ${wins === 1 ? 'win' : 'wins'}` : ''}
        {` · steward's own confidence ${Math.round(thesis.stated_confidence)}`}
      </p>
      {backtest ? <p className="books-track books-backtest">{backtest}</p> : null}
      {thesis.beliefs.length ? (
        <>
          <p className="books-section-label">Beliefs</p>
          <ul className="thesis-beliefs" aria-label="Beliefs">
            {thesis.beliefs.map((note) => (
              <li key={note.id}>
                <b>
                  {note.prior_confidence === null && note.new_confidence === null
                    ? beliefKindText(note.kind)
                    : `confidence ${note.prior_confidence ?? '—'} → ${note.new_confidence ?? '—'}`}
                </b>
                <span>
                  {note.prior_confidence === null && note.new_confidence === null ? '' : `${beliefKindText(note.kind)} · `}
                  {note.observed_at.slice(0, 10)}
                  {note.rules.length ? ` · ${note.rules.map(plainWords).join(' · ')}` : ''}
                </span>
                {note.rationale ? <p>{note.rationale}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {thesis.evidence.length ? (
        <>
          <p className="books-section-label">Evidence</p>
          <ul className="thesis-evidence">
            {thesis.evidence.map((note) => (
              <li key={note.id}>
                <b>{plainWords(note.direction)}</b>
                <span>{plainWords(note.evidence_type)} · confidence {note.confidence}</span>
                <p>{note.summary}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="books-section-label">Outcomes</p>
      {lots.length ? (
        <ul className="books-lots books-outcomes">
          {lots.map((lot) => (
            <li key={lot.holding.id}>
              <button
                type="button"
                className="books-lot"
                data-lot={lot.holding.id}
                data-life={lot.holding.life}
                onClick={() => onOpenLot(lot.holding.id)}
              >
                <span className="books-lot-top">
                  <b>{lot.name}</b>
                  <span className="books-lot-amt">{lot.holding.life === 'closed' ? 'closed' : 'open'}</span>
                  <span className={`books-lot-pnl ${pnlClass(lotPnl(lot.holding).sign)}`}>
                    {lotPnl(lot.holding).text}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="books-note is-muted">{nested ? 'No other positions on this idea.' : 'No positions on this idea yet.'}</p>
      )}
      {lessons.length ? (
        <>
          <p className="books-section-label">Lessons · {lessons.length}</p>
          <ul className="thesis-evidence books-lessons">
            {shown.map((row) => (
              <li key={row.id} data-lesson={row.id}>
                <span>
                  {plainWords(row.lesson_type)}
                  {row.market_regime ? ` · ${plainWords(row.market_regime)}` : ''}
                  {' · '}
                  {row.created_at.slice(0, 10)}
                  {row.incorporated ? ' · in the playbook' : ''}
                </span>
                <p>{row.summary}</p>
              </li>
            ))}
          </ul>
          {lessons.length > LESSONS_SHOWN ? (
            <button type="button" className="books-more" onClick={() => setAllLessons((value) => !value)}>
              {allLessons ? 'Show fewer' : `Show all ${lessons.length}`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function plainTitle(thesis: ThesisRosterRow): string {
  return plainThesisName(thesis.name, thesis.id);
}

function trackFor(books: StewardBooks, thesisId: string): string {
  for (const section of books.sections) {
    const hit = [...section.watching, ...section.set_aside].find((row) => row.thesis.id === thesisId);
    if (hit) return hit.track.label;
    const lot = [...section.open, ...section.closed].find((row) => row.holding.thesis_id === thesisId);
    if (lot) return lot.track.label;
  }
  return 'no track record yet';
}

function backtestFor(books: StewardBooks, thesisId: string): string | null {
  for (const section of books.sections) {
    const hit = [...section.watching, ...section.set_aside].find((row) => row.thesis.id === thesisId)
      ?? [...section.open, ...section.closed].find((row) => row.holding.thesis_id === thesisId);
    if (hit) return hit.track.backtest;
  }
  return null;
}

function scoreWins(books: StewardBooks, thesisId: string): number | null {
  for (const section of books.sections) {
    const hit = [...section.watching, ...section.set_aside].find((row) => row.thesis.id === thesisId)
      ?? [...section.open, ...section.closed].find((row) => row.holding.thesis_id === thesisId);
    if (hit && hit.track.trades > 0) return hit.track.wins;
  }
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
