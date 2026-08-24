"""Unified command-line entry point for ThesisForge."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Sequence


COMMANDS = {
    ("automations", "defer-sync"): "thesisforge.automations.defer_sync",
    ("automations", "sync"): "thesisforge.automations.sync",
    ("articles", "fetch"): "thesisforge.articles.fetch",
    ("bookmarks", "ingest"): "thesisforge.bookmarks.ingest",
    ("dashboard", "publish"): "thesisforge.dashboard.publish",
    ("documents",): "thesisforge.research.documents",
    ("event-map", "sunday"): "thesisforge.research.event_map",
    ("financial",): "thesisforge.financial.service",
    ("ontology",): "thesisforge.ontology.manage",
    ("ontology", "refresh"): "thesisforge.ontology.refresh",
    ("ontology", "report"): "thesisforge.ontology.report",
    ("report", "run"): "thesisforge.reports.run",
    ("report", "thesis"): "thesisforge.reports.thesis",
    ("research", "capture"): "thesisforge.research.capture",
    ("supabase", "verify-worker"): "thesisforge.supabase.verify_worker",
}


def usage() -> str:
    commands = "\n".join(f"  {' '.join(parts)}" for parts in COMMANDS)
    return f"Usage: thesisforge <command> [options]\n\nCommands:\n{commands}"


def main(argv: Sequence[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print(usage())
        return

    for prefix, module_name in sorted(COMMANDS.items(), key=lambda item: len(item[0]), reverse=True):
        if tuple(args[: len(prefix)]) != prefix:
            continue
        module = importlib.import_module(module_name)
        original_argv = sys.argv
        sys.argv = [f"thesisforge {' '.join(prefix)}", *args[len(prefix) :]]
        try:
            module.main()
        finally:
            sys.argv = original_argv
        return

    raise SystemExit(f"Unknown command: {' '.join(args)}\n\n{usage()}")
