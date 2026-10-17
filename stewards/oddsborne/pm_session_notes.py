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
SKIP_BODY_MAX = 8000

# Thesis tagging (GRASSHOPPER ruling 2026-10-17):
# - a skip note carries the thesis of the bet it skips (weather -> weather_same_day_high,
#   sports maker -> sports_devig_maker_edge); a session that skips both writes one skip note per thesis;
# - session-wide scan/summary notes stay untagged (thesis_id null) and never set decision.
THESIS_SPORTS = "sports_devig_maker_edge"
THESIS_WX = "weather_same_day_high"
_GROUP_LABEL = {THESIS_WX: "weather", THESIS_SPORTS: "sports"}


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


def summary_note_args(*, note_type: str = "scan", title: str, body: str, meta=None) -> dict:
    """A session-wide scan/summary note: never thesis-tagged, never sets decision."""
    return note_args(thesis_id=None, note_type=note_type, title=title, body=body, decision=None, meta=meta)


def skip_note_args(*, title: str, groups, decision=None, meta=None) -> list:
    """One skip note per thesis. `groups` is an iterable of (thesis_id, lines, group_meta).

    Groups with no lines are dropped. When more than one thesis has skips, each note's title gets a
    " (weather)" / " (sports)" suffix so the split rows are distinguishable. Returns [] when nothing
    was skipped. thesis_id must be set on every group: a skip note is always about one thesis.
    """
    kept = []
    for thesis_id, lines, group_meta in groups:
        lines = [str(x) for x in (lines or [])]
        if not lines:
            continue
        if not thesis_id:
            raise ValueError("every skip-note group needs a thesis_id")
        kept.append((thesis_id, lines, group_meta or {}))
    if len({t for t, _, _ in kept}) != len(kept):
        raise ValueError("skip-note groups must have distinct thesis_ids")
    out = []
    for thesis_id, lines, group_meta in kept:
        t = title if len(kept) == 1 else f"{title} ({_GROUP_LABEL.get(thesis_id, thesis_id)})"
        m = dict(meta or {})
        m.update(group_meta)
        m["thesis_id"] = thesis_id
        out.append(note_args(thesis_id=thesis_id, note_type="skip", title=t,
                             body="\n".join(lines)[:SKIP_BODY_MAX], decision=decision, meta=m))
    return out


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


def write_session_notes(rpc, scan_args: dict, skip_args) -> dict:
    """Write the scan note, the skip note(s), then oddsborne_touch_heartbeat.

    skip_args is one note_args dict (partial["skip"] is its id) or a list of them, one per thesis
    (partial["skip"] is the list of ids, possibly empty). Each call is its own transaction. On failure,
    NotesWriteError.partial holds the ids that already committed and .stage is scan, skip, or heartbeat.
    Writes are not retried.
    """
    many = isinstance(skip_args, (list, tuple))
    partial = {"scan": None, "skip": [] if many else None, "heartbeat": None}
    try:
        partial["scan"] = _insert(rpc, scan_args)
    except NotesWriteError as e:
        e.stage = "scan"
        e.partial = dict(partial)
        raise
    for one in (skip_args if many else [skip_args]):
        try:
            nid = _insert(rpc, one)
        except NotesWriteError as e:
            e.stage = "skip"
            e.partial = dict(partial, skip=list(partial["skip"]) if many else None)
            raise
        if many:
            partial["skip"].append(nid)
        else:
            partial["skip"] = nid
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
