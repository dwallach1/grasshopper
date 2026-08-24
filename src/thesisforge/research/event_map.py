"""Materialize a dynamic weekly event map from canonical Supabase research."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re

from thesisforge import db as database
from thesisforge.clock import utc_now_iso
from thesisforge.ontology.graph import upsert_edge, upsert_node
from thesisforge.ontology.learning import OntologyLearner
from thesisforge.ontology.refresh import theme_node_id


DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--week-start", type=dt.date.fromisoformat, help="Monday in YYYY-MM-DD; defaults to the current week")
    return root


def week_bounds(value: dt.date | None = None) -> tuple[dt.date, dt.date]:
    today = value or dt.datetime.now(dt.UTC).date()
    start = today - dt.timedelta(days=today.weekday())
    return start, start + dt.timedelta(days=6)


def event_date(value: str | None) -> dt.date | None:
    if not value:
        return None
    match = DATE_RE.search(value)
    if not match:
        return None
    try:
        return dt.date.fromisoformat(match.group(0))
    except ValueError:
        return None


def main() -> None:
    args = parser().parse_args()
    start, end = week_bounds(args.week_start)
    conn = database.connect()
    try:
        learner = OntologyLearner(conn)
        learner.sync_theme_theses()
        mapped = 0
        unresolved = 0

        for row in conn.execute(
            """SELECT id, event_type, label, event_date, status, source_url, summary, updated_at
               FROM research_events
               WHERE status IN ('watching', 'scheduled', 'observed')
               ORDER BY event_date, id"""
        ):
            parsed_date = event_date(row["event_date"])
            if parsed_date is not None and not (start <= parsed_date <= end):
                continue
            if parsed_date is None:
                unresolved += 1

            node_id = f"event:{row['id']}"
            upsert_node(
                conn,
                node_id,
                "event",
                row["label"],
                {
                    "event_type": row["event_type"],
                    "event_date": row["event_date"],
                    "status": row["status"],
                    "source_url": row["source_url"],
                    "week": f"{start.isoformat()}_to_{end.isoformat()}",
                },
            )
            text = f"{row['label']} {row['summary']}"
            symbols = learner.catalog.extract_symbols(text)
            matches = learner.catalog.classify(text, symbols)
            learner.record_source(
                source_type="research_event",
                source_key=str(row["id"]),
                text=text,
                symbols=symbols,
                matches=matches,
                observed_at=str(row["updated_at"]),
            )
            for match in matches:
                upsert_edge(
                    conn,
                    node_id,
                    theme_node_id(match.theme),
                    "catalyzes",
                    weight=max(1.0, match.score / 20),
                    props={"score": match.score, "week_start": start.isoformat()},
                )

            topic = f"{start.isoformat()}: verify {row['label']}"
            reason = (
                f"Confirm date, source evidence, affected symbols, activation conditions, and invalidation for "
                f"{row['label']} before the market-hours workflow."
            )
            existing = conn.execute(
                "SELECT id FROM research_queue WHERE topic=? AND status='open'",
                (topic,),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE research_queue SET reason=?, updated_at=? WHERE id=?",
                    (reason, utc_now_iso(), existing["id"]),
                )
            else:
                conn.execute(
                    """INSERT INTO research_queue(priority, topic, reason, source, created_at, updated_at)
                       VALUES (?, ?, ?, 'dynamic_event_map', ?, ?)""",
                    (80 if parsed_date else 60, topic, reason, utc_now_iso(), utc_now_iso()),
                )
            mapped += 1

        discovered = learner.discover_emerging_themes()
        promoted = learner.promote_ready_candidates()
        conn.commit()
        print(
            json.dumps(
                {
                    "week_start": start.isoformat(),
                    "week_end": end.isoformat(),
                    "events_mapped": mapped,
                    "events_with_unresolved_dates": unresolved,
                    "emerging_candidates": discovered,
                    "auto_promoted": promoted,
                },
                indent=2,
            )
        )
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
