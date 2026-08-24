#!/usr/bin/env python3
"""Launch post-run automation reconciliation for the current Codex thread."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def current_thread_id() -> str:
    thread_id = os.environ.get("CODEX_THREAD_ID", "").strip()
    if not thread_id:
        raise RuntimeError("CODEX_THREAD_ID is required to defer automation synchronization")
    return thread_id


def reconciler_command(thread_id: str, timeout_seconds: float) -> list[str]:
    return [
        sys.executable,
        "-m",
        "thesisforge.automations.reconcile",
        "--thread-id",
        thread_id,
        "--timeout-seconds",
        f"{timeout_seconds:g}",
    ]


def launch_reconciler(thread_id: str, *, timeout_seconds: float = 14_400) -> int:
    """Detach a worker that can observe this command's later task-complete event."""
    log_path = Path(tempfile.gettempdir()) / "thesisforge-automation-reconcile.log"
    with log_path.open("ab", buffering=0) as log:
        process = subprocess.Popen(
            reconciler_command(thread_id, timeout_seconds),
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    return process.pid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thread-id", default=None)
    parser.add_argument("--timeout-seconds", type=float, default=14_400)
    args = parser.parse_args()
    thread_id = args.thread_id or current_thread_id()
    pid = launch_reconciler(thread_id, timeout_seconds=args.timeout_seconds)
    print(f"Armed post-run automation reconciliation for {thread_id} (worker {pid})")


if __name__ == "__main__":
    main()
