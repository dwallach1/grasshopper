#!/usr/bin/env python3
"""close_lesson: write the closed-trade lesson for a lot (one belief_updates row), so the close counts in
public.v_learning_loop_gaps and the thesis confidence moves (belief_update_sync_thesis).

Usage (from /workspace/bandit or /workspace/oddsborne; the steward is the directory name):
  .venv/bin/python close_lesson.py --position-id <uuid> --rationale "<what this close taught>" --new-confidence 42
      [--kind trade_close_lesson|playbook_rule|autopsy] [--thesis <id>] [--prior 45] [--meta-json '{...}'] [--dry-run]

public.steward_close_lesson (over HTTPS as <steward>_worker) refuses unless the lot is this steward's, closed,
and the thesis is the lot's; confidence is on the 1-100 scale; the rationale must say something (>= 20 chars).
prior_confidence defaults to the thesis's latest belief update. --dry-run shows the lot and the call; no write.
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

STEWARDS = ("bandit", "oddsborne")


def steward_from_path(path: str = _HERE) -> str | None:
    name = os.path.basename(os.path.normpath(path))
    return name if name in STEWARDS else None


def lesson_args(steward: str, a) -> dict:
    args = {"steward": steward, "position_id": a.position_id, "rationale": a.rationale, "kind": a.kind}
    if a.new_confidence is not None:
        args["new_confidence"] = a.new_confidence
    if a.prior is not None:
        args["prior_confidence"] = a.prior
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
    ap.add_argument("--prior", type=float, default=None)
    ap.add_argument("--meta-json", default=None)
    ap.add_argument("--steward", default=steward_from_path(), choices=STEWARDS)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if not a.steward:
        ap.error("--steward is required outside /workspace/{bandit,oddsborne}")
    if a.new_confidence is not None and not (1 <= a.new_confidence <= 100):
        ap.error("--new-confidence is on the 1-100 scale")
    from steward_rpc import RpcError, call, dumps
    args = lesson_args(a.steward, a)
    if a.dry_run:
        lot = call(a.steward, f"{a.steward}_position_get", {"position_id": a.position_id}, idempotent=True)
        keep = ("id", "status", "thesis_id", "closed_at", "quantity", "invalidation_price")
        print(dumps({"decision": "DRY_RUN_OK", "lot": {k: (lot or {}).get(k) for k in keep} if lot else None,
                     "would_write": {"fn": "steward_close_lesson", "args": args},
                     "would_refuse": None if lot and lot.get("status") == "closed" else "lot missing or not closed"}))
        return 0
    try:
        res = call(a.steward, "steward_close_lesson", args)
    except RpcError as e:
        if e.refusal:
            print(dumps({"decision": "REFUSED", "gate": e.refusal[0], "reason": e.refusal[1]}))
            return 2
        raise
    print(dumps({"decision": "WRITTEN", **res}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
