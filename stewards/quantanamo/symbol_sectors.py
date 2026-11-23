#!/usr/bin/env python3
"""Fill public.symbol_sectors from Financial Datasets company facts.

The ontology proposer reads that table. It does not guess a sector. This script
asks the same provider workers/knowledge already calls
(https://api.financialdatasets.ai/company/facts, header X-API-KEY, key
FINANCIAL_DATASETS_API_KEY). A stored company.facts row is written first so a
ticker already in the vault is not purchased again.

Usage (from /workspace/quantanamo, after the sector migration is applied):
  .venv/bin/python symbol_sectors.py            # vault, then the API, then upsert
  .venv/bin/python symbol_sectors.py --dry-run  # print what would be written; no upsert

A 200 with no sector, or a 404, stores skip_reason no_sector. A missing key, a
timeout, or HTTP 401/402/429/5xx stores nothing for that ticker: the next run
tries again. The key is never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

STEWARD = "quantanamo"
FACTS_URL = "https://api.financialdatasets.ai/company/facts"
SOURCE = "financialdatasets_company_facts"
TIMEOUT = 20
DEFAULT_SECRETS_FILE = "/home/box/sand-data/box-secrets.json"


class SourceError(RuntimeError):
    """The company-facts call did not return a usable payload. Not a sector."""


def _api_key() -> str | None:
    found = os.environ.get("FINANCIAL_DATASETS_API_KEY")
    if found and found.strip():
        return found.strip()
    path = os.environ.get("STEWARD_SECRETS_FILE") or DEFAULT_SECRETS_FILE
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    inner = data.get("secrets", data)
    if not isinstance(inner, dict) or not inner.get("FINANCIAL_DATASETS_API_KEY"):
        return None
    return str(inner["FINANCIAL_DATASETS_API_KEY"]).strip() or None


def facts_object(body: object) -> dict:
    """The flat company-facts object, or the one nested under company_facts."""
    if not isinstance(body, dict):
        return {}
    nested = body.get("company_facts")
    if isinstance(nested, dict):
        return nested
    return body


def text_field(facts: dict, key: str) -> str | None:
    value = facts.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def sector_from_payload(body: object, symbol: str) -> dict:
    """Sector and industry exactly as the payload names them.

    A different ticker in the payload is a source error, not a sector for `symbol`.
    A payload with no sector is an affirmative no_sector, not a guess.
    """
    facts = facts_object(body)
    got = text_field(facts, "ticker")
    if got and got.upper() != symbol.upper():
        raise SourceError(f"company facts ticker {got.upper()} is not {symbol.upper()}")
    return {
        "symbol": symbol.upper(),
        "sector": text_field(facts, "sector"),
        "industry": text_field(facts, "industry"),
        "source": SOURCE,
    }


def classify_http(status: int) -> str:
    """'none' stores no_sector. 'retry' stores nothing. Anything else is a hard error."""
    if status == 404:
        return "none"
    if status in (401, 402, 429, 500, 502, 503, 504) or status >= 500:
        return "retry"
    if status == 200:
        return "ok"
    return "retry"


def fetch_facts(symbol: str, api_key: str) -> dict:
    """GET /company/facts?ticker=. Raises SourceError when the call should be retried."""
    query = urllib.parse.urlencode({"ticker": symbol})
    req = urllib.request.Request(
        f"{FACTS_URL}?{query}",
        headers={
            "X-API-KEY": api_key,
            "accept": "application/json",
            "user-agent": "grasshopper-quantanamo/symbol_sectors",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceError(f"{type(exc).__name__}: {str(exc)[:200]}") from None
    kind = classify_http(status)
    if kind == "none":
        return {"symbol": symbol.upper(), "sector": None, "industry": None, "source": SOURCE}
    if kind == "retry":
        raise SourceError(f"financial datasets company facts HTTP {status}")
    try:
        body = json.loads(raw.decode() or "{}")
    except ValueError as exc:
        raise SourceError("company facts response is not JSON") from exc
    return sector_from_payload(body, symbol)


def _rows(payload: object, key: str) -> list:
    if not isinstance(payload, dict) or not isinstance(payload.get(key), list):
        raise SourceError(f"{key} missing from ledger reply")
    return payload[key]


def _default_caller(fn: str, args: dict):
    from steward_rpc import call
    if fn == "symbol_sector_gaps":
        return call(STEWARD, "symbol_sector_gaps", args)
    if fn == "symbol_sector_vault":
        return call(STEWARD, "symbol_sector_vault", args)
    if fn == "upsert_symbol_sector":
        return call(STEWARD, "upsert_symbol_sector", args)
    raise SourceError(f"unknown ledger function {fn}")


def populate(caller, api_key: str | None, *, dry_run: bool = False, limit: int | None = None) -> dict:
    """Vault first, then the API for whatever is still a gap. No hardcoded sectors."""
    gaps = _rows(caller("symbol_sector_gaps", {}), "symbols")
    if limit is not None:
        gaps = gaps[:limit]
    wanted = {str(symbol).upper() for symbol in gaps}
    wrote = []
    skipped = []
    retried = []
    for row in _rows(caller("symbol_sector_vault", {}), "rows"):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper()
        if symbol not in wanted:
            continue
        args = {
            "symbol": symbol,
            "sector": row.get("sector"),
            "industry": row.get("industry"),
            "source": SOURCE,
        }
        if dry_run:
            wrote.append({"symbol": symbol, "via": "vault", "sector": args["sector"], "dry_run": True})
        else:
            wrote.append({"symbol": symbol, "via": "vault", **(caller("upsert_symbol_sector", args) or {})})
        wanted.discard(symbol)
    if wanted and not api_key:
        return {
            "ok": False,
            "wrote": wrote,
            "retry": sorted(wanted),
            "error": "FINANCIAL_DATASETS_API_KEY not set",
        }
    for symbol in sorted(wanted):
        try:
            args = fetch_facts(symbol, api_key or "")
        except SourceError as exc:
            retried.append({"symbol": symbol, "error": str(exc)[:200]})
            continue
        if dry_run:
            wrote.append({"symbol": symbol, "via": "api", "sector": args["sector"], "dry_run": True})
            continue
        result = caller("upsert_symbol_sector", args) or {}
        wrote.append({"symbol": symbol, "via": "api", **result})
        if result.get("skip_reason") == "no_sector":
            skipped.append(symbol)
    return {"ok": not retried, "wrote": len(wrote), "no_sector": skipped, "retry": retried, "rows": wrote}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="fetch and print; do not upsert")
    parser.add_argument("--limit", type=int, default=None, help="cap tickers this run")
    args = parser.parse_args()
    report = populate(_default_caller, _api_key(), dry_run=args.dry_run, limit=args.limit)
    print(json.dumps(report, default=str))
    if not report.get("ok", True):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
