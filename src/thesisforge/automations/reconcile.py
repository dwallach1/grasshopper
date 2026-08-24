#!/usr/bin/env python3
"""Reconcile one Codex automation after its rollout reaches a terminal event."""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from thesisforge.automations.sync import codex_home, read_rollout, sync, thread_metadata


def rollout_path_for_thread(thread_id: str, root: Path) -> Path | None:
    """Return the current rollout path recorded for a Codex thread."""
    value = thread_metadata(root).get(thread_id, {}).get("rollout_path")
    return Path(value) if value else None


def wait_for_terminal_rollout(
    thread_id: str,
    *,
    root: Path | None = None,
    timeout_seconds: float = 900,
    poll_seconds: float = 2,
) -> dict[str, object]:
    """Wait until Codex appends a terminal event for the specified thread."""
    root = root or codex_home()
    deadline = time.monotonic() + timeout_seconds
    while True:
        rollout_path = rollout_path_for_thread(thread_id, root)
        result = read_rollout(str(rollout_path) if rollout_path else None)
        if result["task_complete"] or result["task_failed"] or result["task_cancelled"]:
            return result
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"Codex thread {thread_id} did not reach a terminal event within "
                f"{timeout_seconds:g} seconds"
            )
        time.sleep(poll_seconds)


def sync_with_retries(*, attempts: int = 4, retry_seconds: float = 5) -> None:
    """Publish after transient database or network failures without hiding the last error."""
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    for attempt in range(attempts):
        try:
            sync()
            return
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(retry_seconds * (2**attempt))


def reconcile(
    thread_id: str,
    *,
    timeout_seconds: float = 14_400,
    poll_seconds: float = 2,
    settle_seconds: float = 1,
) -> None:
    """Wait for terminal state, then republish canonical automation observability."""
    wait_for_terminal_rollout(
        thread_id,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
    )
    # The rollout terminal event can land just before the automation registry's
    # final updated_at value. Let that authoritative duration settle first.
    time.sleep(settle_seconds)
    sync_with_retries()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=14_400)
    parser.add_argument("--poll-seconds", type=float, default=2)
    parser.add_argument("--settle-seconds", type=float, default=1)
    args = parser.parse_args()
    reconcile(
        args.thread_id,
        timeout_seconds=args.timeout_seconds,
        poll_seconds=args.poll_seconds,
        settle_seconds=args.settle_seconds,
    )
    print(f"Reconciled completed Codex automation thread {args.thread_id}")


if __name__ == "__main__":
    main()
