"""Review and manage the adaptive ontology catalog."""

from __future__ import annotations

import argparse
import json

from thesisforge import db as database
from thesisforge.clock import utc_now_iso
from thesisforge.ontology.learning import OntologyLearner, normalize_phrase


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("learn", help="Discover emerging themes and promote high-confidence associations")
    candidates = commands.add_parser("candidates", help="List reviewable ontology candidates")
    candidates.add_argument("--status", default="pending", choices=["pending", "promoted", "rejected"])
    candidates.add_argument("--limit", type=int, default=50)
    candidates.add_argument("--min-sources", type=int, default=2)

    approve = commands.add_parser("approve", help="Approve a pending theme, term, or membership candidate")
    approve.add_argument("candidate_id", type=int)
    approve.add_argument("--note", default="Manual review")

    reject = commands.add_parser("reject", help="Reject a pending candidate")
    reject.add_argument("candidate_id", type=int)
    reject.add_argument("--note", required=True)

    verify = commands.add_parser("verify-symbol", help="Mark a broker-validated symbol as verified")
    verify.add_argument("symbol")

    theme = commands.add_parser("add-theme", help="Add a database-defined theme or concept")
    theme.add_argument("theme_id")
    theme.add_argument("name")
    theme.add_argument("--description", default="")
    theme.add_argument("--kind", choices=["theme", "concept"], default="theme")
    theme.add_argument("--status", choices=["candidate", "active"], default="candidate")

    term = commands.add_parser("add-term", help="Add vocabulary to an existing theme")
    term.add_argument("theme_id")
    term.add_argument("term")
    term.add_argument("--type", choices=["keyword", "alias", "phrase", "entity", "negative"], default="keyword")
    term.add_argument("--weight", type=int, default=60, choices=range(1, 101), metavar="1..100")

    membership = commands.add_parser("add-membership", help="Associate a verified symbol with a theme")
    membership.add_argument("theme_id")
    membership.add_argument("symbol")
    membership.add_argument(
        "--relationship",
        choices=["member", "beneficiary", "supplier", "customer", "competitor", "proxy"],
        default="member",
    )
    membership.add_argument("--confidence", type=int, default=70, choices=range(0, 101), metavar="0..100")

    lexicon = commands.add_parser("add-lexicon", help="Add an operational token without changing code")
    lexicon.add_argument("token")
    lexicon.add_argument(
        "--type",
        choices=["ignored_symbol", "market_keyword", "market_context", "candidate_stopword"],
        required=True,
    )
    lexicon.add_argument("--weight", type=int, default=0, choices=range(0, 101), metavar="0..100")
    lexicon.add_argument("--reason", default="Manual catalog update")
    return root


def main() -> None:
    args = parser().parse_args()
    conn = database.connect()
    try:
        learner = OntologyLearner(conn)
        if args.command == "learn":
            learner.sync_theme_theses()
            learner.recalculate_candidate_stats()
            discovered = learner.discover_emerging_themes()
            promoted = learner.promote_ready_candidates()
            result = {
                "emerging_candidates": discovered,
                "auto_promoted": promoted,
                "pending": conn.execute(
                    """SELECT COUNT(*) FROM ontology_candidates c
                       WHERE status='pending' AND source_count >= 2
                         AND (
                           (candidate_type='membership' AND EXISTS (
                             SELECT 1 FROM symbols s WHERE s.symbol=c.proposed_label
                               AND s.status IN ('known', 'verified', 'active', 'public_comp')
                           ))
                           OR (candidate_type='term' AND lower(proposed_label)
                               !~ '(^| )(http|https|www|t[.]co)( |$)')
                           OR (candidate_type='theme' AND (
                             position(' ' in proposed_label) > 0
                             OR sample_context->>'feature_type'='hashtag'
                           ))
                         )"""
                ).fetchone()[0],
            }
        elif args.command == "candidates":
            rows = conn.execute(
                """SELECT id, candidate_type, candidate_key, proposed_theme_id, proposed_label,
                          proposed_description, score, evidence_count, source_count,
                          status, sample_context, first_seen_at, last_seen_at, review_note
                   FROM ontology_candidates c WHERE status=? AND source_count >= ?
                     AND (
                       (candidate_type='membership' AND EXISTS (
                         SELECT 1 FROM symbols s WHERE s.symbol=c.proposed_label
                           AND s.status IN ('known', 'verified', 'active', 'public_comp')
                       ))
                       OR (candidate_type='term' AND lower(proposed_label)
                           !~ '(^| )(http|https|www|t[.]co)( |$)')
                       OR (candidate_type='theme' AND (
                         position(' ' in proposed_label) > 0
                         OR sample_context->>'feature_type'='hashtag'
                       ))
                     )
                   ORDER BY source_count DESC, score DESC, id LIMIT ?""",
                (args.status, args.min_sources, args.limit),
            ).fetchall()
            print(json.dumps([dict(row) for row in rows], indent=2, default=str))
            return
        elif args.command == "approve":
            learner.approve_candidate(args.candidate_id, note=args.note)
            result = {"approved": args.candidate_id}
        elif args.command == "reject":
            learner.reject_candidate(args.candidate_id, note=args.note)
            result = {"rejected": args.candidate_id}
        elif args.command == "verify-symbol":
            learner.verify_symbol(args.symbol)
            result = {"verified_symbol": args.symbol.upper()}
        elif args.command == "add-theme":
            timestamp = utc_now_iso()
            conn.execute(
                """INSERT INTO ontology_themes(
                     id, kind, name, description, status, created_by, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
                     kind=excluded.kind, status=excluded.status, updated_at=excluded.updated_at""",
                (args.theme_id, args.kind, args.name, args.description, args.status, timestamp, timestamp),
            )
            result = {"theme": args.theme_id, "status": args.status}
        elif args.command == "add-term":
            timestamp = utc_now_iso()
            conn.execute(
                """INSERT INTO ontology_terms(
                     theme_id, term, normalized_term, term_type, weight, status,
                     evidence_count, source_count, created_by, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 'manual', ?, ?)
                   ON CONFLICT(theme_id, normalized_term) DO UPDATE SET
                     term=excluded.term, term_type=excluded.term_type, weight=excluded.weight,
                     status='active', updated_at=excluded.updated_at""",
                (args.theme_id, args.term, normalize_phrase(args.term), args.type, args.weight, timestamp, timestamp),
            )
            result = {"theme": args.theme_id, "term": args.term}
        elif args.command == "add-membership":
            symbol = args.symbol.upper()
            symbol_row = conn.execute("SELECT status FROM symbols WHERE symbol=?", (symbol,)).fetchone()
            if not symbol_row or symbol_row["status"] not in {"verified", "active", "public_comp"}:
                raise SystemExit(f"Symbol {symbol} must be broker-verified before adding membership")
            timestamp = utc_now_iso()
            conn.execute(
                """INSERT INTO symbol_theme_memberships(
                     symbol, theme_id, relationship, confidence, evidence_count, source_count,
                     status, learned_by, first_seen_at, last_seen_at
                   ) VALUES (?, ?, ?, ?, 1, 1, 'active', 'manual', ?, ?)
                   ON CONFLICT(symbol, theme_id) DO UPDATE SET relationship=excluded.relationship,
                     confidence=excluded.confidence, status='active', learned_by='manual',
                     last_seen_at=excluded.last_seen_at""",
                (symbol, args.theme_id, args.relationship, args.confidence, timestamp, timestamp),
            )
            result = {"theme": args.theme_id, "symbol": symbol, "relationship": args.relationship}
        else:
            timestamp = utc_now_iso()
            conn.execute(
                """INSERT INTO ontology_lexicon(
                     token, token_type, weight, status, reason, created_at, updated_at
                   ) VALUES (?, ?, ?, 'active', ?, ?, ?)
                   ON CONFLICT(token, token_type) DO UPDATE SET
                     weight=excluded.weight, status='active', reason=excluded.reason,
                     updated_at=excluded.updated_at""",
                (args.token, args.type, args.weight, args.reason, timestamp, timestamp),
            )
            result = {"token": args.token, "type": args.type, "weight": args.weight}
        conn.commit()
        print(json.dumps(result, indent=2))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
