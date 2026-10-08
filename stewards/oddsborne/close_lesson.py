#!/usr/bin/env python3
"""close_lesson: write the closed-trade lesson for a lot (one belief_updates row), so the close counts in
public.v_learning_loop_gaps and the thesis confidence moves (belief_update_sync_thesis).

Usage (from /workspace/bandit or /workspace/oddsborne; the steward is the directory name):
  .venv/bin/python close_lesson.py --position-id <uuid> --rationale "<what this close taught>" --confidence-delta -3
      [--new-confidence 42] [--kind trade_close_lesson|playbook_rule|autopsy] [--thesis <id>] [--meta-json '{...}'] [--dry-run]
QUANTANAMO (equity lots, public.position_episodes) passes --steward quantanamo and needs
QUANTANAMO_WORKER_DB_PASSWORD in its environment (stdlib only, any python3):
  python3 close_lesson.py --steward quantanamo --position-id <position_episodes.id> --rationale "..." --confidence-delta -3

public.steward_close_lesson (over HTTPS as <steward>_worker) refuses unless the lot is this steward's, closed,
and the thesis is the lot's; confidence is on the 1-100 scale; the rationale must say something (>= 20 chars).
The prior is always the ledger's current value (results_confidence, else stated; set in the database,
not here); --confidence-delta moves from it, and a losing close can never raise it (clamped, meta.clamped).
--dry-run runs the same checks and arithmetic in the database (dry_run: true) and prints the result; no write.
Keep this file identical in stewards/bandit and stewards/oddsborne (test_steward_scripts checks).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

STEWARDS = ("bandit", "oddsborne", "quantanamo")


def steward_from_path(path: str = _HERE) -> str | None:
    name = os.path.basename(os.path.normpath(path))
    return name if name in STEWARDS else None


def lesson_args(steward: str, a) -> dict:
    args = {"steward": steward, "position_id": a.position_id, "rationale": a.rationale, "kind": a.kind}
    if a.new_confidence is not None:
        args["new_confidence"] = a.new_confidence
    if a.confidence_delta is not None:
        args["confidence_delta"] = a.confidence_delta
    if a.thesis:
        args["thesis_id"] = a.thesis
    if a.meta_json:
        meta = json.loads(a.meta_json)
        if not isinstance(meta, dict):
            raise SystemExit("--meta-json must be a JSON object")
        args["meta"] = meta
    return args


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="close_lesson.py", description=__doc__.split("\n")[0])
    ap.add_argument("--position-id", required=True)
    ap.add_argument("--rationale", required=True)
    ap.add_argument("--new-confidence", type=float, default=None, help="1-100")
    ap.add_argument("--kind", default="trade_close_lesson", choices=["trade_close_lesson", "playbook_rule", "autopsy"])
    ap.add_argument("--thesis", default=None)
    ap.add_argument("--confidence-delta", type=float, default=None,
                    help="move confidence by this much from the ledger's current value (e.g. -5)")
    ap.add_argument("--meta-json", default=None)
    ap.add_argument("--steward", default=steward_from_path(), choices=STEWARDS)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if not a.steward:
        ap.error("--steward is required outside /workspace/{bandit,oddsborne} (QUANTANAMO: --steward quantanamo)")
    if a.new_confidence is not None and a.confidence_delta is not None:
        ap.error("pass --new-confidence or --confidence-delta, not both")
    if a.new_confidence is not None and not (1 <= a.new_confidence <= 100):
        ap.error("--new-confidence is on the 1-100 scale")
    from steward_rpc import RpcError, call, dumps
    args = lesson_args(a.steward, a)
    if a.dry_run:
        args["dry_run"] = True
    try:
        res = call(a.steward, "steward_close_lesson", args, idempotent=a.dry_run)
    except RpcError as e:
        if e.refusal:
            print(dumps({"decision": "REFUSED", "gate": e.refusal[0], "reason": e.refusal[1]}))
            return 2
        raise
    if a.dry_run:
        if not (isinstance(res, dict) and res.get("dry_run") is True):  # a database without 65 would have written
            print(dumps({"decision": "DRY_RUN_NOT_HONORED", "result": res}))
            return 3
        print(dumps({"decision": "DRY_RUN_OK", "would_write": {"fn": "steward_close_lesson", "args": args}, **res}))
        return 0
    print(dumps({"decision": "WRITTEN", **res}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
