#!/usr/bin/env python3
"""Start and finish durable scheduled-run recaps in the existing runs ledger."""
from __future__ import annotations

import argparse
import json

from thesisforge import db as database
from thesisforge.clock import utc_now_iso


def now() -> str:
    return utc_now_iso(zulu=False)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("run_type")
    finish = commands.add_parser("finish")
    finish.add_argument("run_type")
    finish.add_argument("--run-id", type=int)
    finish.add_argument("--headline", required=True)
    finish.add_argument("--summary", required=True)
    finish.add_argument("--insight", action="append", default=[])
    finish.add_argument("--learning", action="append", default=[])
    finish.add_argument("--action", action="append", default=[])
    finish.add_argument("--metric", action="append", default=[], metavar="KEY=VALUE")
    return root


def main() -> None:
    args = parser().parse_args()
    conn = database.connect()
    conn.execute("set local statement_timeout = '5s'")
    if args.command == "start":
        cursor = conn.execute(
            "INSERT INTO runs(run_type, started_at, notes) VALUES (?, ?, ?)",
            (args.run_type, now(), json.dumps({"version": 1, "status": "running"})),
        )
        run_id = cursor.lastrowid
        conn.commit()
        conn.close()
        print(run_id)
        return

    run_id = args.run_id
    if run_id is None:
        row = conn.execute(
            "SELECT id FROM runs WHERE run_type=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
            (args.run_type,),
        ).fetchone()
        if not row:
            raise SystemExit(f"No open {args.run_type!r} run found")
        run_id = row[0]
    metrics: dict[str, str] = {}
    for item in args.metric:
        if "=" not in item:
            raise SystemExit(f"Invalid --metric {item!r}; expected KEY=VALUE")
        key, value = item.split("=", 1)
        metrics[key.strip()] = value.strip()
    report = {
        "version": 1,
        "status": "complete",
        "headline": args.headline,
        "summary": args.summary,
        "insights": args.insight,
        "learnings": args.learning,
        "actions": args.action,
        "metrics": metrics,
    }
    cursor = conn.execute(
        "UPDATE runs SET completed_at=?, notes=? WHERE id=? AND run_type=? AND completed_at IS NULL",
        (now(), json.dumps(report, separators=(",", ":")), run_id, args.run_type),
    )
    if cursor.rowcount != 1:
        conn.rollback()
        raise SystemExit(f"Run {run_id} was not open or did not match {args.run_type!r}")
    conn.commit()
    conn.close()
    print(run_id)


if __name__ == "__main__":
    main()
