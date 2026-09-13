'use client';

import { useMemo, useState } from 'react';

import {
  leanPendingCandidates,
  liveThesesForLink,
  reviewOntologyCandidate,
  suggestedThesisId,
  type ReviewAction,
} from '../../lib/candidate-review';
import type { DeskPayload, OntologyCandidateRow } from '../../lib/ledger-types';

export function CandidateReviewQueue({
  desk,
  canReview = false,
  onReviewed,
}: {
  desk: DeskPayload;
  canReview?: boolean;
  onReviewed?: () => void;
}) {
  const queue = useMemo(
    () => leanPendingCandidates(desk.ontology_candidates ?? []),
    [desk.ontology_candidates],
  );
  const theses = useMemo(() => liveThesesForLink(desk.theses ?? []), [desk.theses]);

  return (
    <section className="review-queue" aria-label="Ontology candidates to review">
      <header className="review-mast">
        <p className="paper-title">To review</p>
        <p className="thesis-lede">
          {queue.length
            ? `${queue.length} pending · ledger score, not invented`
            : 'No pending candidates on this desk.'}
          {canReview
            ? ' Promote, reject, or merge writes the ledger.'
            : ' Public phone is read-only.'}
        </p>
      </header>
      {queue.length ? (
        <ul className="review-list">
          {queue.map((row) => (
            <CandidateReviewCard
              key={row.id}
              row={row}
              desk={desk}
              theses={theses}
              canReview={canReview}
              onReviewed={onReviewed}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CandidateReviewCard({
  row,
  desk,
  theses,
  canReview,
  onReviewed,
}: {
  row: OntologyCandidateRow;
  desk: DeskPayload;
  theses: ReturnType<typeof liveThesesForLink>;
  canReview: boolean;
  onReviewed?: () => void;
}) {
  const suggested = suggestedThesisId(row, desk.ontology_themes ?? [], theses);
  const [thesisId, setThesisId] = useState(suggested ?? '');
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const theme = (desk.ontology_themes ?? []).find((item) => item.id === row.proposed_theme_id);
  const suggestedName = theses.find((item) => item.id === suggested)?.name;

  async function act(action: ReviewAction) {
    if (!canReview || busy) return;
    const chosen = thesisId || suggested || null;
    if (action === 'merge' && !chosen) {
      setNotice('Pick a thesis to merge into.');
      return;
    }
    setBusy(action);
    setNotice(null);
    try {
      await reviewOntologyCandidate({
        candidate_id: row.id,
        action,
        thesis_id: chosen,
        note: null,
      });
      onReviewed?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Review failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="review-card" data-candidate={row.id} data-status={row.status}>
      <span className="review-card-copy">
        <b>{row.proposed_label}</b>
        <i>
          {row.candidate_type}
          {theme?.name ? ` · ${theme.name}` : row.proposed_theme_id ? ` · ${row.proposed_theme_id}` : ''}
        </i>
        {row.proposed_description ? <p>{row.proposed_description}</p> : null}
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">{row.status}</span>
        <span className="thesis-conf" title="ledger score">{row.score}</span>
        <span className="review-src">{row.source_count} src</span>
      </span>
      {canReview ? (
        <div className="review-actions">
          {theses.length ? (
            <label className="review-thesis">
              <span>Thesis</span>
              <select
                value={thesisId}
                onChange={(event) => setThesisId(event.target.value)}
                disabled={busy !== null}
              >
                <option value="">{suggestedName ? `Suggested · ${suggestedName}` : 'Link if one fits'}</option>
                {theses.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="review-buttons">
            <button type="button" disabled={busy !== null} onClick={() => void act('promote')}>
              {busy === 'promote' ? 'Promoting…' : 'Promote'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act('reject')}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act('merge')}>
              {busy === 'merge' ? 'Merging…' : 'Merge'}
            </button>
          </div>
          {notice ? <p className="review-notice" role="status">{notice}</p> : null}
        </div>
      ) : suggestedName ? (
        <p className="review-hint">Fits {suggestedName}</p>
      ) : null}
    </li>
  );
}
