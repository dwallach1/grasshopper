'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import {
  closeBeliefForLesson,
  closeMoveLine,
  earningsBoundLessonIds,
  lessonNeedsDecision,
  lessonWithBelief,
  rulesInForceByDomain,
  scoredCloseLessonIds,
  type BeliefUpdateRow,
  type RulesInForceGroup,
} from '../../lib/beliefs';
import { holdingTicket } from '../../lib/book-holdings';
import { assembleBookOpen, type BookOpenTicket } from '../../lib/book-open-strip';
import { blurFocusWithin } from '../../lib/desk-focus';
import { isMarkStale } from '../../lib/desk-freshness';
import type { DeskPayload, LessonRow } from '../../lib/ledger-types';
import {
  cameBackCounts,
  cameBackLine,
  ontologyFreshnessLine,
  researchIdSequenceLine,
  ruleNotTakingLead,
  type RuleNotTaking,
} from '../../lib/ledger-watchdog';
import {
  lessonAgeDays,
  lessonAgeLine,
  lessonWaitLine,
  openLessonGroup,
  OPEN_LESSON_STALE_DAYS,
  type LessonWait,
} from '../../lib/lesson-waits';
import { shadowTallyLine, type ShadowCandidate } from '../../lib/shadow-tally';
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
import type { BacktestArtifactRow, StrategyTestRow } from '../../lib/ledger-types';
import {
  measuredForTest,
  testStatusText,
  testsForThesis,
} from '../../lib/strategy-tests-public';
import { waitingBlurb, waitingTestsForThesis, type WaitingTest } from '../../lib/waiting-tests';
import { CandidateReviewQueue } from './candidate-review';
import { DeskLiveline } from './desk-liveline';
import { age, pnlClass } from './format';
import { LessonQueue } from './lesson-queue';

/** What a tap opened: a position (with its thesis) or a thesis on its own. */
type Reading =
  | { kind: 'lot'; id: string }
  | { kind: 'idea'; id: string };

const LESSONS_SHOWN = 5;

function thesisPlainName(desk: DeskPayload, thesisId: string): string {
  const row = (desk.theses ?? []).find((thesis) => thesis.id === thesisId);
  return plainThesisName(row?.name ?? '', thesisId);
}

function RulesNotTakingList({
  rows,
  thesisName,
  thesisId,
  withSummary = false,
}: {
  rows: readonly RuleNotTaking[];
  thesisName: (thesisId: string) => string;
  thesisId?: string;
  withSummary?: boolean;
}) {
  const shown = thesisId ? rows.filter((row) => row.thesis_id === thesisId) : rows;
  if (!shown.length) return null;
  return (
    <section className="books-rules-not-taking" aria-label="Rules not taking" data-rules-not-taking={shown.length}>
      <p className="books-section-label">Rules not taking</p>
      <ul className="books-waiting">
        {shown.map((row) => {
          const ids = row.lesson_ids.join(', ');
          return (
            <li key={ids} data-rule-chain={ids}>
              <p className="books-note">{ruleNotTakingLead(thesisName(row.thesis_id), row.came_back)}</p>
              <p className="books-note">Lessons {ids}.</p>
              {withSummary ? <p className="books-note">{row.summary}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CameBack({ id, counts }: { id: number; counts: ReadonlyMap<number, number> }) {
  const line = cameBackLine(counts.get(id));
  if (!line) return null;
  return <p className="books-lesson-wait" data-came-back={counts.get(id)}>{line}</p>;
}

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
  const ontologyLine = ontologyFreshnessLine(desk.watchdog?.ontology_freshness ?? null);
  const sequenceLine = researchIdSequenceLine(desk.watchdog?.research_id_sequences ?? null);
  const rulesNotTaking = desk.watchdog?.rules_not_taking ?? [];
  const cameBack = useMemo(
    () => cameBackCounts(desk.watchdog?.lesson_came_back),
    [desk.watchdog?.lesson_came_back],
  );
  const books = useMemo(() => assembleStewardBooks(desk, nowMs), [desk, nowMs]);
  const waitingByThesis = useMemo(() => {
    const ids = new Set<string>();
    for (const section of books.sections) {
      for (const idea of [...section.watching, ...section.set_aside]) ids.add(idea.thesis.id);
      for (const lot of [...section.open, ...section.closed]) {
        if (lot.holding.thesis_id) ids.add(lot.holding.thesis_id);
      }
    }
    const map = new Map<string, string>();
    for (const id of ids) {
      const line = waitingBlurb(waitingTestsForThesis({
        thesisId: id,
        tests: desk.tests ?? [],
        cycles: desk.cycles ?? [],
        lessons: books.lessons_by_thesis.get(id) ?? [],
        lessonWaits: desk.lesson_waits ?? [],
        nowMs,
      }));
      if (line) map.set(id, line);
    }
    return map;
  }, [books, desk.cycles, desk.lesson_waits, desk.tests, nowMs]);
  const tickets = useMemo(() => assembleBookOpen(desk).rows.flatMap((row) => row.tickets), [desk]);
  const [reading, setReading] = useState<Reading | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const booksRef = useRef<HTMLDivElement>(null);

  function openReading(next: Reading) {
    blurFocusWithin(booksRef.current);
    setReading(next);
  }

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
        ref={booksRef}
        className="books"
        data-desk-nested-scroll="1"
        aria-hidden={open ? true : undefined}
      >
        <h1 className="visually-hidden">Book</h1>
        <header className="books-mast">
          <p className="paper-title">Book</p>
          {ontologyLine ? (
            <p className="thesis-lede" data-ontology-freshness={desk.watchdog?.ontology_freshness?.starved || desk.watchdog?.ontology_freshness?.lagging ? 'stale' : 'fresh'}>
              {ontologyLine}
            </p>
          ) : null}
          {sequenceLine ? (
            <p className="thesis-lede" data-research-id-sequence="lagging">{sequenceLine}</p>
          ) : null}
          <RulesNotTakingList rows={rulesNotTaking} thesisName={(id) => thesisPlainName(desk, id)} />
        </header>
        {books.sections.map((section) => (
          <StewardSection
            key={section.slug}
            section={section}
            shadows={desk.shadows}
            waitingByThesis={waitingByThesis}
            onOpenLot={(id) => openReading({ kind: 'lot', id })}
            onOpenIdea={(id) => openReading({ kind: 'idea', id })}
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
          tests={desk.tests ?? []}
          cycles={desk.cycles ?? []}
          artifacts={desk.backtest_artifacts ?? []}
          lessonWaits={desk.lesson_waits ?? []}
          beliefs={desk.beliefs ?? []}
          domains={desk.team?.domains ?? []}
          rulesNotTaking={rulesNotTaking}
          cameBack={cameBack}
          thesisName={(id) => thesisPlainName(desk, id)}
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
          tests={desk.tests ?? []}
          cycles={desk.cycles ?? []}
          artifacts={desk.backtest_artifacts ?? []}
          lessonWaits={desk.lesson_waits ?? []}
          beliefs={desk.beliefs ?? []}
          domains={desk.team?.domains ?? []}
          rulesNotTaking={rulesNotTaking}
          cameBack={cameBack}
          thesisName={(id) => thesisPlainName(desk, id)}
          onClose={() => setReading(null)}
          onOpenLot={(id) => setReading({ kind: 'lot', id })}
        />
      ) : null}
    </div>
  );
}

function StewardSection({
  section,
  shadows,
  waitingByThesis,
  onOpenLot,
  onOpenIdea,
}: {
  section: BooksSection;
  shadows?: ShadowCandidate[];
  waitingByThesis: ReadonlyMap<string, string>;
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
        {section.forecast ? (
          <p className="books-line" data-forecast="">{section.forecast}</p>
        ) : null}
      </header>
      {(shadows ?? []).filter((row) => row.steward === section.slug).map((row) => {
        const text = shadowTallyLine(row);
        if (!text) return null;
        return (
          <p key={row.candidate_key} className="books-line" data-shadow={row.candidate_key}>{text}</p>
        );
      })}
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
          <li><IdeaRow idea={watched} onOpen={onOpenIdea} watch waiting={waitingByThesis.get(watched.thesis.id)} /></li>
        </ul>
      ) : section.watching.length > 1 ? (
        <Fold label={`Watching · ${section.watching.length} ideas`}>
          <ul className="books-ideas">
            {section.watching.map((idea) => (
              <li key={idea.thesis.id}><IdeaRow idea={idea} onOpen={onOpenIdea} waiting={waitingByThesis.get(idea.thesis.id)} /></li>
            ))}
          </ul>
        </Fold>
      ) : null}
      {section.set_aside.length ? (
        <Fold label={`Not watching · ${section.set_aside.length} ${section.set_aside.length === 1 ? 'idea' : 'ideas'}`}>
          <ul className="books-ideas is-aside">
            {section.set_aside.map((idea) => (
              <li key={idea.thesis.id}><IdeaRow idea={idea} onOpen={onOpenIdea} waiting={waitingByThesis.get(idea.thesis.id)} /></li>
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
  waiting,
}: {
  idea: BooksIdea;
  onOpen: (id: string) => void;
  watch?: boolean;
  waiting?: string;
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
      {waiting ? <span className="books-idea-wait">{waiting}</span> : null}
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
  tests,
  cycles,
  artifacts,
  lessonWaits,
  beliefs,
  domains,
  rulesNotTaking,
  cameBack,
  thesisName,
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
  tests: StrategyTestRow[];
  cycles: { id: number; thesis_id?: string | null; hypothesis?: string | null; preregistered_outcome?: string | null }[];
  artifacts: BacktestArtifactRow[];
  lessonWaits: LessonWait[];
  beliefs: readonly BeliefUpdateRow[];
  domains: readonly { id: string; name: string; sort_order?: number | null }[];
  rulesNotTaking: readonly RuleNotTaking[];
  cameBack: ReadonlyMap<number, number>;
  thesisName: (thesisId: string) => string;
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
          {h.life === 'closed' && lot?.lesson_waiting ? (
            <p className="books-note is-muted">No lesson written yet.</p>
          ) : null}
          {h.life === 'closed' && h.clip_note ? (
            <>
              <p className="books-note">
                <b>{h.clip_note.kind === 'lesson' ? 'Lesson' : 'Belief'}</b> {h.clip_note.summary}
              </p>
              {h.clip_note.move ? (
                <p className="books-note books-close-move">{h.clip_note.move}</p>
              ) : null}
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
          beliefs={beliefs}
          domains={domains}
          lessons={books.lessons_by_thesis.get(thesis.id) ?? []}
          tests={tests}
          cycles={cycles}
          artifacts={artifacts}
          lessonWaits={lessonWaits}
          now={now}
          rulesNotTaking={rulesNotTaking}
          cameBack={cameBack}
          thesisName={thesisName}
          onOpenLot={onOpenLot}
        />
      ) : null}
    </article>
  );
}

function RulesInForce({ groups }: { groups: readonly RulesInForceGroup[] }) {
  return (
    <div className="book-rules-in-force">
      <p className="books-section-label">Rules in force</p>
      {groups.map((group) => (
        <section key={group.key} className="book-rules-group" aria-label={group.label}>
          <p className="book-rules-domain">{group.label}</p>
          <ul className="book-rules">
            {group.rules.map((rule) => {
              const name = rule.rules.map(plainWords).filter(Boolean).join(' · ');
              const moved = rule.prior_confidence !== null || rule.new_confidence !== null;
              return (
                <li key={rule.id} data-rule={rule.id}>
                  {name ? <b>{name}</b> : null}
                  <span>
                    {rule.observed_at.slice(0, 10)}
                    {moved ? ` · confidence ${rule.prior_confidence ?? '—'} → ${rule.new_confidence ?? '—'}` : ''}
                  </span>
                  {rule.rationale ? <p>{rule.rationale}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
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
  beliefs,
  domains,
  lessons,
  tests,
  cycles,
  artifacts,
  lessonWaits,
  now,
  rulesNotTaking,
  cameBack,
  thesisName,
  onOpenLot,
}: {
  thesis: ThesisRosterRow;
  nested: boolean;
  track: string;
  backtest: string | null;
  wins: number | null;
  lots: BooksLot[];
  beliefs: readonly BeliefUpdateRow[];
  domains: readonly { id: string; name: string; sort_order?: number | null }[];
  lessons: LessonRow[];
  tests: StrategyTestRow[];
  cycles: { id: number; external_key?: string | null; thesis_id?: string | null; hypothesis?: string | null; preregistered_outcome?: string | null }[];
  artifacts: BacktestArtifactRow[];
  lessonWaits: LessonWait[];
  now: number;
  rulesNotTaking: readonly RuleNotTaking[];
  cameBack: ReadonlyMap<number, number>;
  thesisName: (thesisId: string) => string;
  onOpenLot: (id: string) => void;
}) {
  const [allReady, setAllReady] = useState(false);
  const [allWaiting, setAllWaiting] = useState(false);
  const ruleGroups = rulesInForceByDomain({ thesisId: thesis.id, beliefs, domains });
  const trail = thesis.beliefs.filter((note) => note.kind !== 'playbook_rule');
  const scoredIds = scoredCloseLessonIds(beliefs);
  const earningsBound = earningsBoundLessonIds(beliefs, lessons, cycles);
  const openLessons = lessons
    .filter((row) => lessonNeedsDecision(row, scoredIds, earningsBound))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const scoredLessons = lessons.filter((row) => scoredIds.has(String(row.id)));
  const playbookLessons = lessons.filter((row) => lessonWithBelief(row, scoredIds, earningsBound));
  const linkedCycles = cycles.filter((row): row is { id: number; thesis_id: string; hypothesis?: string | null; preregistered_outcome?: string | null } =>
    typeof row.thesis_id === 'string');
  const scoped = testsForThesis(thesis.id, tests, linkedCycles, lessons);
  const finished = scoped.filter((row) => row.status !== 'queued');
  const waiting = waitingTestsForThesis({
    thesisId: thesis.id,
    tests,
    cycles: linkedCycles,
    lessons,
    lessonWaits,
    nowMs: now,
  });
  const byId = new Map(scoped.map((row) => [row.id, row]));
  const waits = new Map(lessonWaits.map((row) => [row.lesson_id, row]));
  const readyLessons = openLessons.filter((row) => openLessonGroup(waits.get(row.id)) === 'ready');
  const waitingLessons = openLessons.filter((row) => openLessonGroup(waits.get(row.id)) === 'waiting');
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
      {ruleGroups.length ? (
        <RulesInForce groups={ruleGroups} />
      ) : null}
      {trail.length ? (
        <>
          <p className="books-section-label">Beliefs</p>
          <ul className="thesis-beliefs" aria-label="Beliefs">
            {trail.map((note) => (
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
      {waiting.length ? (
        <>
          <p className="books-section-label">Still waiting</p>
          <ul className="books-waiting" aria-label="Tests still waiting">
            {waiting.map((row) => (
              <WaitingTestLine key={row.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
      {finished.length ? (
        <>
          <p className="books-section-label">Tests · {finished.length}</p>
          <ul className="thesis-evidence books-tests" aria-label="Strategy tests">
            {finished.map((row) => (
              <li key={row.id} data-test={row.id} data-status={row.status}>
                <TestOutcome test={row} cycles={cycles} artifacts={artifacts} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <RulesNotTakingList
        rows={rulesNotTaking}
        thesisName={thesisName}
        thesisId={thesis.id}
        withSummary
      />
      <OpenLessonGroup
        label="Ready to write into the playbook"
        lane="ready"
        lessons={readyLessons}
        expanded={allReady}
        onToggle={() => setAllReady((value) => !value)}
        waits={waits}
        byId={byId}
        cycles={cycles}
        artifacts={artifacts}
        now={now}
        cameBack={cameBack}
      />
      <OpenLessonGroup
        label="Still waiting on a test"
        lane="waiting"
        lessons={waitingLessons}
        expanded={allWaiting}
        onToggle={() => setAllWaiting((value) => !value)}
        waits={waits}
        byId={byId}
        cycles={cycles}
        artifacts={artifacts}
        now={now}
        cameBack={cameBack}
      />
      {scoredLessons.length ? (
        <>
          <p className="books-section-label">Already moved confidence · {scoredLessons.length}</p>
          <ul className="thesis-evidence books-lessons books-scored">
            {scoredLessons.map((row) => {
              const move = closeMoveLine(closeBeliefForLesson(row.id, beliefs) ?? {
                prior_confidence: null,
                new_confidence: null,
              });
              return (
                <li key={row.id} data-lesson={row.id} data-scored="1">
                  <span>
                    {plainWords(row.lesson_type)}
                    {' · '}
                    {row.created_at.slice(0, 10)}
                  </span>
                  <p>{row.summary}</p>
                  <CameBack id={row.id} counts={cameBack} />
                  {move ? <p className="books-close-move">{move}</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {playbookLessons.length ? (
        <>
          <p className="books-section-label">In the playbook · {playbookLessons.length}</p>
          <ul className="thesis-evidence books-lessons books-playbook">
            {playbookLessons.map((row) => {
              const bound = earningsBound.has(String(row.id));
              return (
                <li key={row.id} data-lesson={row.id} data-playbook="1" data-earnings-bound={bound ? '1' : undefined}>
                  <span>
                    {plainWords(row.lesson_type)}
                    {row.market_regime ? ` · ${plainWords(row.market_regime)}` : ''}
                    {' · '}
                    {row.created_at.slice(0, 10)}
                    {bound ? ' · belief already written' : ' · in the playbook'}
                  </span>
                  <p>{row.summary}</p>
                  <CameBack id={row.id} counts={cameBack} />
                  {bound ? <p className="books-lesson-wait">Belief already written. Confidence stays.</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function WaitingTestLine({ row }: { row: WaitingTest }) {
  return (
    <li data-waiting-test={row.id}>
      {row.check ? <p className="books-waiting-check">{row.check}</p> : null}
      <p className="books-note">
        {row.daysLine}
        {row.why ? ` ${row.why}` : ''}
      </p>
      {row.lessonsLine ? <p className="books-note">{row.lessonsLine}</p> : null}
    </li>
  );
}

function OpenLessonGroup({
  label,
  lane,
  lessons,
  expanded,
  onToggle,
  waits,
  byId,
  cycles,
  artifacts,
  now,
  cameBack,
}: {
  label: string;
  lane: 'ready' | 'waiting';
  lessons: LessonRow[];
  expanded: boolean;
  onToggle: () => void;
  waits: Map<number, LessonWait>;
  byId: Map<number, StrategyTestRow>;
  cycles: { id: number; preregistered_outcome?: string | null }[];
  artifacts: BacktestArtifactRow[];
  now: number;
  cameBack: ReadonlyMap<number, number>;
}) {
  if (!lessons.length) return null;
  const shown = expanded ? lessons : lessons.slice(0, LESSONS_SHOWN);
  return (
    <>
      <p className="books-section-label">{label} · {lessons.length}</p>
      <ul className="thesis-evidence books-lessons" data-lesson-lane={lane}>
        {shown.map((row) => {
          const waiting = lessonWaitLine(waits.get(row.id));
          const age = lessonAgeLine(row.created_at, now);
          const ageDays = lessonAgeDays(row.created_at, now);
          const stale = ageDays !== null && ageDays >= OPEN_LESSON_STALE_DAYS;
          const linked = row.test_id === null ? undefined : byId.get(row.test_id);
          return (
            <li
              key={row.id}
              data-lesson={row.id}
              data-lesson-lane={lane}
              data-open-lesson="1"
              data-stale={stale ? '1' : undefined}
            >
              <span>
                {plainWords(row.lesson_type)}
                {row.market_regime ? ` · ${plainWords(row.market_regime)}` : ''}
                {' · '}
                {row.created_at.slice(0, 10)}
              </span>
              {age ? (
                <span className={stale ? 'books-lesson-age is-stale' : 'books-lesson-age'}>{age}</span>
              ) : null}
              <p>{row.summary}</p>
              <CameBack id={row.id} counts={cameBack} />
              {waiting ? <p className="books-lesson-wait">{waiting}</p> : null}
              {linked ? <TestOutcome test={linked} cycles={cycles} artifacts={artifacts} linked /> : null}
            </li>
          );
        })}
      </ul>
      {lessons.length > LESSONS_SHOWN ? (
        <button type="button" className="books-more" data-lesson-lane={lane} onClick={onToggle}>
          {expanded ? 'Show fewer' : `Show all ${lessons.length}`}
        </button>
      ) : null}
    </>
  );
}

function TestOutcome({
  test,
  cycles,
  artifacts,
  linked = false,
}: {
  test: StrategyTestRow;
  cycles: { id: number; preregistered_outcome?: string | null }[];
  artifacts: BacktestArtifactRow[];
  linked?: boolean;
}) {
  const measured = measuredForTest(test, artifacts, cycles);
  return (
    <p className={linked ? 'books-test-link' : undefined} data-linked-test={linked ? test.id : undefined}>
      {measured.result ? <span className="books-test-measured">{measured.result}</span> : null}
      {measured.result ? ' · ' : ''}
      {plainWords(test.variant_label)}
      {' · '}
      {testStatusText(test.status)}
      {measured.book ? <span className="books-test-book">{` · ${measured.book}`}</span> : null}
    </p>
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
