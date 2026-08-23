"""Shared UTC clock helpers."""

from __future__ import annotations

import datetime as dt


def utc_now() -> dt.datetime:
    """Return the current UTC time without microseconds."""
    return dt.datetime.now(dt.UTC).replace(microsecond=0)


def utc_now_iso(*, zulu: bool = True) -> str:
    """Return the current UTC time as ISO 8601, using ``Z`` by default."""
    value = utc_now().isoformat()
    return value.replace("+00:00", "Z") if zulu else value
