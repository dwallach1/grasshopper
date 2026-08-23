#!/usr/bin/env python3
"""Cache-first Financial Datasets ingestion for the ThesisForge Supabase vault.

Every network response is retained as compressed JSON before it is normalized.
The API key is read from the environment and is never written to the database.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts import database
except ModuleNotFoundError:
    import database

BASE_URL = "https://api.financialdatasets.ai"
PROVIDER = "financialdatasets.ai"



@dataclass(frozen=True)
class RequestSpec:
    endpoint: str
    params: dict[str, Any]
    method: str = "GET"
    body: dict[str, Any] | None = None


def now() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(microsecond=0)


def iso(value: dt.datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def request_fingerprint(spec: RequestSpec) -> str:
    material = canonical_json({
        "provider": PROVIDER,
        "method": spec.method.upper(),
        "endpoint": "/" + spec.endpoint.lstrip("/"),
        "params": spec.params,
        "body": spec.body,
    })
    return hashlib.sha256(material.encode()).hexdigest()


def ttl_for(spec: RequestSpec) -> tuple[dt.timedelta, str]:
    endpoint = "/" + spec.endpoint.lstrip("/")
    today = now().date()
    if endpoint == "/prices" and spec.params.get("end_date"):
        try:
            if dt.date.fromisoformat(str(spec.params["end_date"])) < today:
                return dt.timedelta(days=3650), "historical_range_immutable"
        except ValueError:
            pass
    policies = (
        ("/prices/snapshot", dt.timedelta(minutes=15), "market_snapshot_15m"),
        ("/prices", dt.timedelta(hours=6), "daily_prices_6h"),
        ("/news", dt.timedelta(hours=1), "news_1h"),
        ("/earnings", dt.timedelta(hours=6), "earnings_6h"),
        ("/filings", dt.timedelta(hours=6), "filings_6h"),
        ("/insider", dt.timedelta(hours=12), "insider_12h"),
        ("/institutional", dt.timedelta(days=1), "institutional_1d"),
        ("/financial-metrics/snapshot", dt.timedelta(hours=6), "metrics_snapshot_6h"),
        ("/financial-metrics", dt.timedelta(days=1), "metrics_1d"),
        ("/financials", dt.timedelta(days=7), "statements_7d"),
        ("/company/facts", dt.timedelta(days=30), "company_facts_30d"),
    )
    for prefix, duration, label in policies:
        if endpoint.startswith(prefix):
            return duration, label
    return dt.timedelta(days=1), "default_1d"


def cached_request(conn, fingerprint: str):
    return conn.execute(
        """SELECT r.* FROM financial_request_cache c
           JOIN financial_api_requests r ON r.id=c.request_id
           WHERE c.request_fingerprint=? AND c.expires_at>? AND r.status_code BETWEEN 200 AND 299""",
        (fingerprint, iso(now())),
    ).fetchone()


def decode_response(row) -> Any:
    raw = bytes(row["response_body"])
    if row["response_encoding"] == "gzip":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def records_from_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates: list[list[dict[str, Any]]] = []
    for value in payload.values():
        if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
            candidates.append(value)
    if candidates:
        return max(candidates, key=len)
    return [payload]


def normalize_records(conn, spec: RequestSpec, payload: Any, request_id: int, fetched_at: str) -> int:
    dataset = spec.endpoint.strip("/").replace("/", ".")
    fallback_ticker = str(spec.params.get("ticker", "")).upper() or None
    inserted = 0
    for index, record in enumerate(records_from_payload(payload)):
        ticker = str(record.get("ticker") or record.get("symbol") or fallback_ticker or "").upper() or None
        report_period = record.get("report_period") or record.get("report_date") or record.get("date")
        filing_date = record.get("filing_date") or record.get("accepted_date")
        period = record.get("period") or spec.params.get("period")
        stable_identity = {
            key: record.get(key)
            for key in (
                "ticker", "symbol", "cik", "accession_number", "report_period", "report_date",
                "filing_date", "date", "period", "fiscal_period", "transaction_date", "title", "url",
            )
            if record.get(key) is not None
        }
        if not stable_identity:
            stable_identity = {"index": index, "query": request_fingerprint(spec)}
        record_key = hashlib.sha256(canonical_json(stable_identity).encode()).hexdigest()
        payload_json = canonical_json(record)
        record_sha = hashlib.sha256(payload_json.encode()).hexdigest()
        result = conn.execute(
            """INSERT INTO financial_records(
                 provider, dataset, ticker, record_key, period, report_period, filing_date,
                 fetched_at, record_sha256, payload_json, source_request_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(provider, dataset, record_key, record_sha256) DO NOTHING""",
            (PROVIDER, dataset, ticker, record_key, str(period) if period else None,
             str(report_period) if report_period else None, str(filing_date) if filing_date else None,
             fetched_at, record_sha, payload_json, request_id),
        )
        inserted += result.rowcount
    return inserted


def fetch(conn, spec: RequestSpec, *, force: bool = False) -> tuple[Any, str, int]:
    fingerprint = request_fingerprint(spec)
    if not force:
        cached = cached_request(conn, fingerprint)
        if cached:
            conn.execute(
                "INSERT INTO financial_access_log(request_fingerprint, request_id, access_type, accessed_at, detail) VALUES (?, ?, 'cache', ?, 'fresh Supabase response')",
                (fingerprint, cached["id"], iso(now())),
            )
            conn.commit()
            return decode_response(cached), "cache", int(cached["id"])

    api_key = os.environ.get("FINANCIAL_DATASETS_API_KEY")
    if not api_key:
        conn.execute(
            "INSERT INTO financial_access_log(request_fingerprint, access_type, accessed_at, detail) VALUES (?, 'blocked', ?, 'missing FINANCIAL_DATASETS_API_KEY')",
            (fingerprint, iso(now())),
        )
        conn.commit()
        raise RuntimeError("FINANCIAL_DATASETS_API_KEY is not set")

    query = urllib.parse.urlencode(sorted((str(k), str(v).lower() if isinstance(v, bool) else str(v)) for k, v in spec.params.items()))
    url = BASE_URL + "/" + spec.endpoint.lstrip("/") + ("?" + query if query else "")
    body_bytes = canonical_json(spec.body).encode() if spec.body is not None else None
    request = urllib.request.Request(
        url, data=body_bytes, method=spec.method.upper(),
        headers={"X-API-KEY": api_key, "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "ThesisForge/0.1"},
    )
    started = iso(now())
    status = 0
    headers: dict[str, str] = {}
    raw = b""
    error_text = None
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            status = response.status
            headers = dict(response.headers.items())
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        headers = dict(error.headers.items()) if error.headers else {}
        raw = error.read()
        error_text = f"HTTP {error.code}: {error.reason}"
    except urllib.error.URLError as error:
        raise RuntimeError(f"Financial Datasets request failed before a response was received: {error.reason}") from error

    completed = now()
    response_sha = hashlib.sha256(raw).hexdigest()
    compressed = gzip.compress(raw)
    cursor = conn.execute(
        """INSERT INTO financial_api_requests(
             provider, request_fingerprint, method, endpoint, params_json, body_json,
             requested_at, completed_at, status_code, response_headers_json,
             response_sha256, response_encoding, response_body, error_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gzip', ?, ?)""",
        (PROVIDER, fingerprint, spec.method.upper(), "/" + spec.endpoint.lstrip("/"), canonical_json(spec.params),
         canonical_json(spec.body) if spec.body is not None else None, started, iso(completed), status,
         canonical_json(headers), response_sha, compressed, error_text),
    )
    request_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO financial_access_log(request_fingerprint, request_id, access_type, accessed_at, detail) VALUES (?, ?, 'network', ?, ?)",
        (fingerprint, request_id, iso(completed), f"HTTP {status}"),
    )
    # Commit the purchased bytes before parsing. A future normalizer bug must
    # never make us lose a response that already consumed a paid request.
    conn.commit()

    payload: Any
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = {"raw_text": raw.decode("utf-8", errors="replace")}

    if 200 <= status < 300:
        duration, policy = ttl_for(spec)
        conn.execute(
            """INSERT INTO financial_request_cache(request_fingerprint, request_id, cached_at, expires_at, freshness_policy)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(request_fingerprint) DO UPDATE SET request_id=excluded.request_id,
                 cached_at=excluded.cached_at, expires_at=excluded.expires_at, freshness_policy=excluded.freshness_policy""",
            (fingerprint, request_id, iso(completed), iso(completed + duration), policy),
        )
        normalize_records(conn, spec, payload, request_id, iso(completed))
    conn.commit()
    if not 200 <= status < 300:
        raise RuntimeError(error_text or f"Financial Datasets returned HTTP {status}")
    return payload, "network", request_id


def import_mcp_response(conn, spec: RequestSpec, payload: Any, *, tool_name: str) -> tuple[int, int]:
    """Persist a paid MCP result using the same cache identity as the HTTP API."""
    fingerprint = request_fingerprint(spec)
    completed = now()
    raw = canonical_json(payload).encode("utf-8")
    response_sha = hashlib.sha256(raw).hexdigest()
    cursor = conn.execute(
        """INSERT INTO financial_api_requests(
             provider, request_fingerprint, method, endpoint, params_json, body_json,
             requested_at, completed_at, status_code, response_headers_json,
             response_sha256, response_encoding, response_body, error_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, 'gzip', ?, NULL)""",
        (PROVIDER, fingerprint, spec.method.upper(), "/" + spec.endpoint.lstrip("/"),
         canonical_json(spec.params), canonical_json(spec.body) if spec.body is not None else None,
         iso(completed), iso(completed), canonical_json({"transport": "mcp", "tool": tool_name}),
         response_sha, gzip.compress(raw)),
    )
    request_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO financial_access_log(request_fingerprint, request_id, access_type, accessed_at, detail) VALUES (?, ?, 'network', ?, ?)",
        (fingerprint, request_id, iso(completed), f"MCP {tool_name}"),
    )
    # Preserve purchased bytes even if a later parser revision fails.
    conn.commit()
    duration, policy = ttl_for(spec)
    conn.execute(
        """INSERT INTO financial_request_cache(request_fingerprint, request_id, cached_at, expires_at, freshness_policy)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(request_fingerprint) DO UPDATE SET request_id=excluded.request_id,
             cached_at=excluded.cached_at, expires_at=excluded.expires_at, freshness_policy=excluded.freshness_policy""",
        (fingerprint, request_id, iso(completed), iso(completed + duration), policy),
    )
    inserted = normalize_records(conn, spec, payload, request_id, iso(completed))
    conn.commit()
    return request_id, inserted


def parse_value(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("parameters must use key=value")
    return tuple(value.split("=", 1))  # type: ignore[return-value]


def pilot_specs(ticker: str, start_date: str, end_date: str) -> list[RequestSpec]:
    ticker = ticker.upper()
    return [
        RequestSpec("/company/facts", {"ticker": ticker}),
        RequestSpec("/financial-metrics", {"ticker": ticker, "period": "quarterly", "limit": 4}),
        RequestSpec("/financials/income-statements", {"ticker": ticker, "period": "quarterly", "limit": 4}),
        RequestSpec("/financials/balance-sheets", {"ticker": ticker, "period": "quarterly", "limit": 4}),
        RequestSpec("/financials/cash-flow-statements", {"ticker": ticker, "period": "quarterly", "limit": 4}),
        RequestSpec("/earnings", {"ticker": ticker, "limit": 4}),
        RequestSpec("/filings", {"ticker": ticker, "limit": 8}),
        RequestSpec("/insider-trades", {"ticker": ticker, "limit": 25}),
        RequestSpec("/institutional-holdings", {"ticker": ticker, "limit": 10}),
        RequestSpec("/news", {"ticker": ticker, "limit": 10}),
        RequestSpec("/prices", {"ticker": ticker, "interval": "day", "start_date": start_date, "end_date": end_date}),
    ]


def database_stats(conn) -> dict[str, Any]:
    row = conn.execute(
        """SELECT
          (SELECT COUNT(*) FROM financial_api_requests) AS network_requests,
          (SELECT COUNT(*) FROM financial_access_log WHERE access_type='cache') AS cache_hits,
          (SELECT COUNT(*) FROM financial_records) AS records,
          (SELECT COUNT(DISTINCT ticker) FROM financial_records WHERE ticker IS NOT NULL) AS tickers,
          (SELECT COALESCE(SUM(length(response_body)), 0) FROM financial_api_requests) AS compressed_bytes"""
    ).fetchone()
    return dict(row)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    fetch_parser = sub.add_parser("fetch", help="Fetch one endpoint through the Supabase cache")
    fetch_parser.add_argument("endpoint")
    fetch_parser.add_argument("--param", action="append", default=[], type=parse_value)
    fetch_parser.add_argument("--force", action="store_true", help="Refresh even when the local copy is fresh")

    import_parser = sub.add_parser("import-mcp", help="Capture one MCP JSON response from standard input")
    import_parser.add_argument("endpoint")
    import_parser.add_argument("--param", action="append", default=[], type=parse_value)
    import_parser.add_argument("--tool-name", required=True)
    import_parser.add_argument("--input", type=Path, help="JSON file to import; defaults to standard input")

    pilot = sub.add_parser("pilot", help="Plan or execute the bounded trial enrichment")
    pilot.add_argument("tickers", nargs="+", help="Ticker symbols to enrich")
    pilot.add_argument("--execute", action="store_true", help="Allow paid network requests; otherwise this is a dry run")
    pilot.add_argument("--max-paid-requests", type=int, default=100, help="Hard cap for this invocation")
    pilot.add_argument("--force", action="store_true", help="Refresh fresh requests; normally leave this off")

    sub.add_parser("stats", help="Show the Supabase vault and cache statistics")
    args = parser.parse_args()
    conn = database.connect()

    if args.command == "stats":
        print(json.dumps(database_stats(conn), indent=2))
        return

    if args.command == "fetch":
        payload, source, request_id = fetch(conn, RequestSpec(args.endpoint, dict(args.param)), force=args.force)
        print(json.dumps({"source": source, "request_id": request_id, "records": len(records_from_payload(payload))}, indent=2))
        return

    if args.command == "import-mcp":
        try:
            if args.input:
                with args.input.open() as source:
                    payload = json.load(source)
            else:
                payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Invalid MCP JSON on standard input: {error}") from error
        request_id, inserted = import_mcp_response(
            conn, RequestSpec(args.endpoint, dict(args.param)), payload, tool_name=args.tool_name
        )
        print(json.dumps({"request_id": request_id, "records_inserted": inserted}, indent=2))
        return

    end = now().date()
    start = end - dt.timedelta(days=365)
    specs = [spec for ticker in dict.fromkeys(t.upper() for t in args.tickers) for spec in pilot_specs(ticker, start.isoformat(), end.isoformat())]
    paid_needed = sum(1 for spec in specs if args.force or cached_request(conn, request_fingerprint(spec)) is None)
    print(f"Pilot plan: {len(args.tickers)} tickers, {len(specs)} datasets, {paid_needed} paid requests needed, {len(specs) - paid_needed} cache hits")
    if paid_needed > args.max_paid_requests:
        raise SystemExit(f"Blocked: {paid_needed} paid requests exceeds --max-paid-requests={args.max_paid_requests}")
    if not args.execute:
        ts = iso(now())
        conn.executemany(
            "INSERT INTO financial_access_log(request_fingerprint, access_type, accessed_at, detail) VALUES (?, 'dry_run', ?, 'pilot plan only')",
            [(request_fingerprint(spec), ts) for spec in specs],
        )
        conn.commit()
        print("Dry run only. Re-run with --execute after reviewing the plan.")
        return

    failures: list[str] = []
    network = cache = 0
    for number, spec in enumerate(specs, 1):
        ticker = spec.params.get("ticker", "MARKET")
        try:
            _, source, _ = fetch(conn, spec, force=args.force)
            network += source == "network"
            cache += source == "cache"
            print(f"[{number:03}/{len(specs):03}] {ticker:<6} {spec.endpoint:<38} {source}")
        except RuntimeError as error:
            failures.append(f"{ticker} {spec.endpoint}: {error}")
            print(f"[{number:03}/{len(specs):03}] {ticker:<6} {spec.endpoint:<38} ERROR", file=sys.stderr)
    print(json.dumps({"network_requests": network, "cache_hits": cache, "failures": failures, "vault": database_stats(conn)}, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
