"""Steward ledger calls over HTTPS (Supabase edge function `steward-rpc`).

The agent box egresses HTTPS only: the Supavisor pooler (5432/6543) resolves to the sandbox proxy and
times out, so the entry scripts no longer open a psycopg connection. Each call names one SQL function
from supabase/schemas/50_steward_entry_rpc.sql and runs it in one transaction AS the steward's worker
role (Basic auth with the worker's own DB password), so the grants, triggers and sizing gates are the
same ones the direct connection had.

  call("oddsborne", "steward_entry_guidance", {...}) -> parsed jsonb result (numerics as Decimal)

STEWARD_DB_TRANSPORT=pg runs the same functions through db_connect (psycopg) where raw Postgres works.
STEWARD_RPC_URL overrides the endpoint. The password is never printed or logged.
Keep this file identical in stewards/bandit and stewards/oddsborne (test_steward_scripts checks).
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from decimal import Decimal

REF = os.environ.get("SUPABASE_PROJECT_REF", "xqungxapqicdmboniezz")
FN_RE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")


class RpcError(RuntimeError):
    """A failed call. `refusal` is (gate, reason) when the SQL refused with 'refusal:<gate>: <reason>'."""

    def __init__(self, fn: str, status: int, code: str, message: str, sqlstate: str | None = None,
                 detail: str | None = None):
        super().__init__(f"{fn}: HTTP {status} {code}: {message}")
        self.fn, self.status, self.code, self.message = fn, status, code, message
        self.sqlstate, self.detail = sqlstate, detail

    @property
    def refusal(self) -> tuple[str, str] | None:
        m = re.match(r"^refusal:([a-z_]+): (.*)$", self.message or "", re.S)
        return (m.group(1), m.group(2)) if m else None

    @property
    def maybe_committed(self) -> bool:
        """True when the request may have reached the database (timeout / 5xx): do not blindly retry a write."""
        return self.code in ("timeout", "db_unreachable") or self.status >= 500 or self.status == 0


def _default(o):
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def dumps(o) -> str:
    return json.dumps(o, default=_default)


def loads(text: str):
    return json.loads(text, parse_float=Decimal)


def url() -> str:
    return os.environ.get("STEWARD_RPC_URL") or f"https://{REF}.supabase.co/functions/v1/steward-rpc"


def _password(steward: str) -> str:
    name = f"{steward.upper()}_WORKER_DB_PASSWORD"
    if os.environ.get(name):  # QUANTANAMO's isn't in either load_secrets NAMES list
        return os.environ[name]
    from load_secrets import require
    return require(name)[name]


def _call_https(steward: str, fn: str, args: dict, timeout: float) -> object:
    role = f"{steward}_worker"
    token = base64.b64encode(f"{role}:{_password(steward)}".encode()).decode()
    req = urllib.request.Request(
        url(), data=dumps({"fn": fn, "args": args}).encode(), method="POST",
        headers={"Authorization": "Basic " + token, "Content-Type": "application/json",
                 "User-Agent": f"grasshopper-steward/{steward}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, text = resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode(errors="replace")
    except TimeoutError as e:
        raise RpcError(fn, 0, "timeout", f"no reply in {timeout}s ({e})") from None
    except urllib.error.URLError as e:
        raise RpcError(fn, 0, "network", str(e.reason)[:300]) from None
    try:
        body = loads(text)
    except ValueError:
        raise RpcError(fn, status, "bad_reply", text[:300]) from None
    if status == 200 and isinstance(body, dict) and body.get("ok"):
        return body.get("result")
    err = (body or {}).get("error") or {} if isinstance(body, dict) else {}
    raise RpcError(fn, status, str(err.get("code") or "error"), str(err.get("message") or text[:300]),
                   err.get("sqlstate"), err.get("detail"))


def _call_pg(steward: str, fn: str, args: dict) -> object:
    from db_connect import connect
    with connect() as conn:
        with conn.cursor() as cur:
            try:
                if fn == "ping":
                    cur.execute("select jsonb_build_object('role', current_user, 'db_time', now(), 'fn', 'ping')::text")
                else:
                    cur.execute(f"select public.{fn}(%s::jsonb)::text", (dumps(args),))
                row = cur.fetchone()
            except Exception as e:  # psycopg.Error: keep the SQL message so refusals map the same way
                conn.rollback()
                diag = getattr(e, "diag", None)
                raise RpcError(fn, 422, "sql", (getattr(diag, "message_primary", None) or str(e)).strip(),
                               getattr(e, "sqlstate", None)) from None
        conn.commit()
    return loads(row[0]) if row and row[0] is not None else None


def log_decision(steward: str, *, decision: str, instrument: str, side: str, price,
                 probability=None, expected_move=None, thesis_id=None, reason=None,
                 source_id=None, decided_at=None, blocked_by=None, meta=None) -> object:
    """Record one enter or skip that can be scored later.

    A write missing the market, the side, or the price is refused (`refusal:unscoreable`).
    Prediction markets also need `probability` (0 to 1). Equity and meme passes may include
    `expected_move` as a fraction of price (0.08 = +8%). `meta` (a dict) is stored with the decision.
    This does not place or size an order.
    """
    args = {
        "steward": steward,
        "decision": decision,
        "instrument": instrument,
        "side": side,
        "price": price,
        "probability": probability,
        "expected_move": expected_move,
        "thesis_id": thesis_id,
        "reason": reason,
        "source_id": source_id,
        "decided_at": decided_at,
        "blocked_by": blocked_by,
        "meta": meta,
    }
    return call(steward, "steward_log_decision", {k: v for k, v in args.items() if v is not None})


def record_decision_mark(steward: str, *, decision_id: str, price=None, observed_at=None, source=None,
                         kind=None, event_start_at=None, no_price_reason=None, meta=None) -> object:
    """Record one real, sourced mark for a logged decision (public.steward_record_decision_mark).

    kind "horizon" (BANDIT, QUANTANAMO): the first price observed at or after the decision's horizon, which the
    database computes (meme: +4h; equity: 5th session close). Insert-once; the pass is then scored.
    kind "close" (ODDSBORNE): the mid of the logged side's book, observed after the decision and before
    `event_start_at` (and market close). A later observation replaces an earlier one (closing-line value).
    `no_price_reason` instead of a price flags a past-horizon pass unscoreable. Never send a made-up price.
    """
    args = {"steward": steward, "decision_id": decision_id, "price": price, "observed_at": observed_at,
            "source": source, "kind": kind, "event_start_at": event_start_at,
            "no_price_reason": no_price_reason, "meta": meta}
    return call(steward, "steward_record_decision_mark", {k: v for k, v in args.items() if v is not None})


def call(steward: str, fn: str, args: dict | None = None, *, idempotent: bool = False, timeout: float = 60.0):
    """Run public.<fn>(args::jsonb) as <steward>_worker. Reads (idempotent=True) retry network blips;
    writes never retry (a lost reply may still have committed)."""
    if fn != "ping" and not FN_RE.match(fn):
        raise ValueError(f"bad function name {fn!r}")
    args = args or {}
    if (os.environ.get("STEWARD_DB_TRANSPORT") or "https").lower() == "pg":
        return _call_pg(steward, fn, args)
    tries = 3 if idempotent else 1
    for i in range(tries):
        try:
            return _call_https(steward, fn, args, timeout)
        except RpcError as e:
            if i == tries - 1 or not e.maybe_committed or e.code == "sql":
                raise
            time.sleep(1.5 * 2 ** i)
    raise AssertionError("unreachable")  # pragma: no cover


if __name__ == "__main__":  # connectivity check: python steward_rpc.py <steward>
    import sys
    who = sys.argv[1] if len(sys.argv) > 1 else os.path.basename(os.path.dirname(os.path.abspath(__file__)))
    print(dumps(call(who, "ping", idempotent=True)))
