"""ODDSBORNE session pm_notes over HTTPS (steward_rpc -> public.oddsborne_insert_note).

The box cannot reach the Postgres pooler, so session_daily.py and session_pm.py no longer INSERT
pm_notes themselves. Each call writes one note as oddsborne_worker. A failure raises NotesWriteError
and is not retried (a lost reply may have committed). Callers log it and continue: this does not
place an order and does not block an exit.
"""
from __future__ import annotations

import json
import re

NOTE_TYPES = frozenset({"scan", "skip", "idea", "thesis", "kill", "postmortem", "lesson", "other"})
DECISIONS = frozenset({"skip", "watch", "enter", "exit", "hold"})
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
TITLE_MAX = 500
BODY_MAX = 32000


class NotesWriteError(RuntimeError):
    """A note or the follow-up heartbeat did not land. `partial` holds ids that already committed."""

    def __init__(self, stage: str, message: str, partial: dict | None = None):
        super().__init__(message)
        self.stage = stage
        self.partial = partial or {"scan": None, "skip": None, "heartbeat": None}


def _ready(value):
    """JSON-safe copy. datetime and Decimal become strings, matching the old default=str insert."""
    return json.loads(json.dumps(value, default=str))


def _probability(name: str, value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be numeric") from None
    if not 0 <= number <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return value


def note_args(*, thesis_id=None, note_type: str, title: str, body: str, decision=None, meta=None,
              market_id=None, my_probability=None, book_probability=None) -> dict:
    """Build the jsonb payload for oddsborne_insert_note. Raises ValueError on a bad field."""
    if note_type not in NOTE_TYPES:
        raise ValueError(f"note_type {note_type!r} is not a pm_notes note_type")
    if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX:
        raise ValueError(f"title is required (1..{TITLE_MAX} chars)")
    if not isinstance(body, str) or len(body) > BODY_MAX:
        raise ValueError(f"body is required (at most {BODY_MAX} chars)")
    if decision is not None and decision not in DECISIONS:
        raise ValueError(f"decision {decision!r} is not a pm_notes decision")
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        raise ValueError("meta must be a JSON object")
    if market_id is not None and not _UUID.match(str(market_id)):
        raise ValueError("market_id must be a uuid")
    my_probability = _probability("my_probability", my_probability)
    book_probability = _probability("book_probability", book_probability)
    args = {"note_type": note_type, "title": title, "body": body, "meta": _ready(meta)}
    if thesis_id:
        args["thesis_id"] = thesis_id
    if decision is not None:
        args["decision"] = decision
    if market_id is not None:
        args["market_id"] = str(market_id)
    if my_probability is not None:
        args["my_probability"] = my_probability
    if book_probability is not None:
        args["book_probability"] = book_probability
    return args


def _insert(rpc, args: dict) -> str:
    try:
        res = rpc("oddsborne_insert_note", args)
    except NotesWriteError:
        raise
    except Exception as e:
        raise NotesWriteError(
            "insert", f"oddsborne_insert_note failed: {type(e).__name__}: {str(e)[:300]}", {}
        ) from e
    if not isinstance(res, dict) or not res.get("pm_note_id"):
        raise NotesWriteError("insert", f"oddsborne_insert_note returned no pm_note_id: {str(res)[:300]}", {})
    return str(res["pm_note_id"])


def write_session_notes(rpc, scan_args: dict, skip_args: dict) -> dict:
    """Write the scan note, the skip note, then oddsborne_touch_heartbeat.

    Each call is its own transaction. On failure, NotesWriteError.partial holds the ids that
    already committed and .stage is scan, skip, or heartbeat. Writes are not retried.
    """
    partial = {"scan": None, "skip": None, "heartbeat": None}
    try:
        partial["scan"] = _insert(rpc, scan_args)
    except NotesWriteError as e:
        e.stage = "scan"
        e.partial = dict(partial)
        raise
    try:
        partial["skip"] = _insert(rpc, skip_args)
    except NotesWriteError as e:
        e.stage = "skip"
        e.partial = dict(partial)
        raise
    try:
        hb = rpc("oddsborne_touch_heartbeat", {})
    except Exception as e:
        raise NotesWriteError(
            "heartbeat",
            f"oddsborne_touch_heartbeat failed: {type(e).__name__}: {str(e)[:300]}",
            dict(partial),
        ) from e
    if not isinstance(hb, dict) or not hb.get("heartbeat_at"):
        raise NotesWriteError(
            "heartbeat",
            f"oddsborne_touch_heartbeat returned no heartbeat_at: {str(hb)[:300]}",
            dict(partial),
        )
    partial["heartbeat"] = str(hb["heartbeat_at"])
    return partial
