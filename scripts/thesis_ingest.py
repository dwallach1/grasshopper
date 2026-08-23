#!/usr/bin/env python3
"""Build and update persistent ThesisForge memory from fetched X bookmarks.

It writes private bookmark data to the configured canonical database, then
leaves Robinhood enrichment to Codex scheduled runs.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

try:
    from scripts import database
except ModuleNotFoundError:
    import database

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BOOKMARKS = ROOT / "data" / "x-bookmarks.json"

STOP_TICKERS = {
    "A", "AI", "AM", "AN", "AND", "API", "ARE", "ATH", "BE", "BEST", "BUT", "CAD", "CEO", "CLI",
    "CPI", "DD", "DM", "DOM", "EPS", "ETF", "EV", "FCF", "FIB", "FOMC", "FOR", "FYI", "GDP", "GPU",
    "GPT", "HDD", "HTTP", "HTTPS", "I", "IMO", "IP", "MCP", "MIT", "OF", "OUT", "PE", "PM", "RL",
    "RSI", "RUN", "SAVE", "SDK", "SEC", "THE", "THIS", "TS", "UI", "US", "USA", "USD", "WAL", "WE",
    "YOU", "YOUR",
}

THEMES = {
    "ai_power_nuclear": ["power", "electric", "nuclear", "uranium", "grid", "energy", "data center", "datacenter"],
    "neocloud_compute": ["neocloud", "gpu", "compute", "cloud", "datacenter", "data center", "cluster"],
    "semis_photonics": ["semiconductor", "semis", "photonics", "optical", "memory", "chip", "chips"],
    "defense_drones_space": ["drone", "drones", "defense", "space", "rocket", "satellite"],
    "quantum": ["quantum"],
    "biotech_royalty": ["biotech", "drug", "royalty", "pharma", "trial"],
    "crypto": ["crypto", "bitcoin", "btc", "ethereum", "tao"],
    "software_ai_apps": ["software", "agent", "agents", "model", "models", "saas", "app", "apps"],
}

THESIS_TEMPLATES = {
    "ai_power_nuclear": {
        "name": "AI power bottleneck beneficiaries",
        "horizon": "days_to_weeks",
        "summary": "AI compute demand is pulling electricity, nuclear, uranium, and grid names into a tradable scarcity narrative.",
    },
    "neocloud_compute": {
        "name": "Neocloud and GPU compute burst basket",
        "horizon": "days_to_weeks",
        "summary": "Bookmarks point to high-beta AI infrastructure names that can move quickly on capacity, financing, and earnings narratives.",
    },
    "semis_photonics": {
        "name": "AI semiconductor and photonics second derivative",
        "horizon": "days_to_weeks",
        "summary": "AI capex may spill into networking, optical, memory, and ASIC suppliers beyond the obvious GPU leaders.",
    },
    "defense_drones_space": {
        "name": "Defense, drones, and space momentum basket",
        "horizon": "days_to_weeks",
        "summary": "Defense autonomy and space infrastructure names show bookmark momentum and may respond to contract/catalyst headlines.",
    },
    "quantum": {
        "name": "Quantum momentum burst basket",
        "horizon": "days",
        "summary": "Quantum names are more momentum/speculation than fundamentals, requiring tighter sizing and faster invalidation.",
    },
    "biotech_royalty": {
        "name": "Biotech royalty asymmetric setup",
        "horizon": "weeks_to_months",
        "summary": "A bookmarked biotech royalty idea may offer asymmetric upside, but needs specialized evidence before sizing.",
    },
    "crypto": {
        "name": "Crypto and decentralized AI optionality",
        "horizon": "days_to_weeks",
        "summary": "Crypto bookmarks suggest lottery-ticket optionality; evidence must be separated from ideology.",
    },
    "software_ai_apps": {
        "name": "AI software and developer tooling watchlist",
        "horizon": "weeks",
        "summary": "Developer tooling and AI-app bookmarks may reveal private-market direction but need tradable public proxies.",
    },
}



def now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def extract_symbols(text: str) -> set[str]:
    cashtags = {m.group(1).replace(".", "-").upper() for m in re.finditer(r"\$([A-Z][A-Z0-9.]{0,5})\b", text)}
    uppercase = {m.group(0).upper() for m in re.finditer(r"\b[A-Z]{2,5}\b", text)}
    return {s for s in cashtags | uppercase if s not in STOP_TICKERS and not s.isdigit()}


def market_score(text: str, symbols: set[str], annotations: list[dict]) -> int:
    lower = text.lower()
    score = min(len(symbols) * 12, 48)
    keywords = [
        "stock", "stocks", "market", "earnings", "valuation", "multiple", "revenue", "margin",
        "cash flow", "buyback", "guidance", "shares", "short", "long", "calls", "puts", "options",
        "portfolio", "fed", "rates", "inflation", "tariff", "crypto", "bitcoin", "semis", "datacenter",
        "data center", "power", "nuclear", "uranium", "price target", "13f",
    ]
    score += sum(8 for k in keywords if k in lower)
    for item in annotations or []:
        blob = json.dumps(item).lower()
        if any(k in blob for k in ["financial", "investments", "stocks", "business", "data centers"]):
            score += 8
    return min(score, 100)


def classify_themes(text: str, symbols: set[str]) -> set[str]:
    lower = text.lower()
    themes = {theme for theme, keys in THEMES.items() if any(k in lower for k in keys)}
    nuclear = {"CEG", "LEU", "OKLO", "SMR", "CCJ", "VST", "TLN", "GEV", "UUUU"}
    neocloud = {"IREN", "NBIS", "HUT", "CORZ", "CRWV"}
    photonics = {"AAOI", "LITE", "COHR", "AEHR", "MRVL", "NVDA", "AVGO", "MU", "SNDK"}
    defense = {"ONDS", "AVAV", "KTOS", "MRCY", "RKLB", "ASTS", "PL", "RDW", "RCAT"}
    quantum = {"IONQ", "RGTI", "QBTS"}
    biotech = {"OABI", "LGND", "LLY", "IBRX", "HIMS"}
    if symbols & nuclear:
        themes.add("ai_power_nuclear")
    if symbols & neocloud:
        themes.add("neocloud_compute")
    if symbols & photonics:
        themes.add("semis_photonics")
    if symbols & defense:
        themes.add("defense_drones_space")
    if symbols & quantum:
        themes.add("quantum")
    if symbols & biotech:
        themes.add("biotech_royalty")
    return themes


def extract_urls(bookmark: dict) -> list[tuple[str, str | None, str | None]]:
    urls = []
    for url in bookmark.get("entities", {}).get("urls", []) or []:
        urls.append((url.get("url"), url.get("expanded_url"), url.get("display_url")))
    return [(u, e, d) for u, e, d in urls if u]


def claim_type(text: str) -> str:
    lower = text.lower()
    if "price target" in lower or "%" in lower or "+" in lower:
        return "price_target_or_momentum"
    if "earnings" in lower or "quarter" in lower:
        return "earnings_catalyst"
    if "13f" in lower or "portfolio" in lower:
        return "investor_positioning"
    if "deal" in lower or "contract" in lower or "announced" in lower:
        return "company_event"
    if "cheap" in lower or "valuation" in lower or "multiple" in lower:
        return "valuation"
    return "opinion_or_theme"


def upsert_symbol(conn, symbol: str, seen_at: str, bookmark_id: str) -> None:
    row = conn.execute("SELECT mention_count, source_count FROM symbols WHERE symbol = ?", (symbol,)).fetchone()
    if row:
        existing_source = conn.execute(
            "SELECT 1 FROM bookmark_symbols WHERE bookmark_id = ? AND symbol = ?", (bookmark_id, symbol)
        ).fetchone()
        conn.execute(
            "UPDATE symbols SET last_seen_at = ?, mention_count = mention_count + ?, source_count = source_count + ? WHERE symbol = ?",
            (seen_at, 0 if existing_source else 1, 0 if existing_source else 1, symbol),
        )
    else:
        conn.execute(
            "INSERT INTO symbols(symbol, first_seen_at, last_seen_at, mention_count, source_count) VALUES (?, ?, ?, 1, 1)",
            (symbol, seen_at, seen_at),
        )


def ingest(bookmarks_path: Path) -> dict:
    payload = json.loads(bookmarks_path.read_text())
    fetched_at = payload.get("fetched_at") or now_iso()
    bookmarks = payload.get("bookmarks", [])

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = database.connect()

    started_at = now_iso()
    cur = conn.execute("INSERT INTO runs(run_type, started_at, notes) VALUES (?, ?, ?)", ("bookmark_ingest", started_at, None))
    run_id = cur.lastrowid

    symbol_to_themes: dict[str, Counter] = defaultdict(Counter)
    theme_to_bookmarks: dict[str, list[str]] = defaultdict(list)
    market_count = 0

    for bookmark in bookmarks:
        text = bookmark.get("text") or ""
        symbols = extract_symbols(text)
        score = market_score(text, symbols, bookmark.get("context_annotations") or [])
        is_market = score >= 35
        market_count += is_market
        created_at = bookmark.get("created_at") or fetched_at
        bookmark_id = bookmark["id"]

        conn.execute(
            """
            INSERT INTO bookmarks(id, author_id, created_at, fetched_at, text, raw_json, market_score, is_market_related)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              fetched_at=excluded.fetched_at,
              text=excluded.text,
              raw_json=excluded.raw_json,
              market_score=excluded.market_score,
              is_market_related=excluded.is_market_related
            """,
            (
                bookmark_id,
                bookmark.get("author_id"),
                created_at,
                fetched_at,
                text,
                json.dumps(bookmark, sort_keys=True),
                score,
                is_market,
            ),
        )

        for url, expanded, display in extract_urls(bookmark):
            conn.execute(
                """INSERT INTO bookmark_urls(bookmark_id, url, expanded_url, display_url)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(bookmark_id, url) DO UPDATE SET
                     expanded_url=excluded.expanded_url, display_url=excluded.display_url""",
                (bookmark_id, url, expanded, display),
            )

        for symbol in sorted(symbols):
            upsert_symbol(conn, symbol, created_at, bookmark_id)
            source = "cashtag_or_uppercase"
            conn.execute(
                """INSERT INTO bookmark_symbols(bookmark_id, symbol, source) VALUES (?, ?, ?)
                   ON CONFLICT(bookmark_id, symbol) DO NOTHING""",
                (bookmark_id, symbol, source),
            )

        themes = classify_themes(text, symbols)
        if is_market:
            conn.execute(
                "INSERT INTO claims(bookmark_id, claim_text, claim_type, created_at, confidence) VALUES (?, ?, ?, ?, ?)",
                (bookmark_id, text[:500], claim_type(text), started_at, min(70, max(30, score))),
            )
        for theme in themes:
            theme_to_bookmarks[theme].append(bookmark_id)
            for symbol in symbols:
                symbol_to_themes[symbol][theme] += 1

    for thesis_id, template in THESIS_TEMPLATES.items():
        if thesis_id not in theme_to_bookmarks:
            continue
        evidence_count = len(set(theme_to_bookmarks[thesis_id]))
        confidence = min(75, 35 + evidence_count * 5)
        status = "forming" if confidence < 60 else "hardening"
        conn.execute(
            """
            INSERT INTO theses(id, name, summary, status, confidence, time_horizon, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              summary=excluded.summary,
              status=excluded.status,
              confidence=excluded.confidence,
              updated_at=excluded.updated_at
            """,
            (thesis_id, template["name"], template["summary"], status, confidence, template["horizon"], started_at, started_at),
        )

        thesis_symbols = [
            (symbol, counts[thesis_id]) for symbol, counts in symbol_to_themes.items() if counts[thesis_id] > 0
        ]
        total = sum(count for _, count in thesis_symbols) or 1
        for symbol, count in sorted(thesis_symbols, key=lambda item: (-item[1], item[0])):
            conn.execute(
                """INSERT INTO thesis_symbols(thesis_id, symbol, role, weight_hint) VALUES (?, ?, ?, ?)
                   ON CONFLICT(thesis_id, symbol) DO UPDATE SET
                     role=excluded.role, weight_hint=excluded.weight_hint""",
                (thesis_id, symbol, "candidate", round(count / total, 4)),
            )

        for bookmark_id in sorted(set(theme_to_bookmarks[thesis_id])):
            text = conn.execute("SELECT text FROM bookmarks WHERE id = ?", (bookmark_id,)).fetchone()[0]
            conn.execute(
                """
                INSERT INTO thesis_evidence(thesis_id, bookmark_id, evidence_type, direction, summary, confidence, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (thesis_id, bookmark_id, "x_bookmark", "supporting", text[:350], 35, started_at),
            )

        conn.execute(
            """
            INSERT INTO thesis_scores(thesis_id, scored_at, confidence, momentum, evidence_quality, catalyst_strength, portfolio_fit, risk, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                thesis_id,
                started_at,
                confidence,
                min(80, 35 + evidence_count * 8),
                30,
                25,
                50,
                65,
                "Initial score from X bookmark clustering only. Needs Robinhood and article enrichment.",
            ),
        )

    conn.execute("UPDATE runs SET completed_at = ?, notes = ? WHERE id = ?", (now_iso(), f"Ingested {len(bookmarks)} bookmarks", run_id))
    conn.commit()

    top_symbols = conn.execute(
        "SELECT symbol, source_count FROM symbols ORDER BY source_count DESC, symbol ASC LIMIT 20"
    ).fetchall()
    theses = conn.execute(
        "SELECT id, name, status, confidence FROM theses ORDER BY confidence DESC, id ASC"
    ).fetchall()
    conn.close()

    return {
        "bookmarks": len(bookmarks),
        "market_related": market_count,
        "database": "supabase",
        "top_symbols": top_symbols,
        "theses": theses,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bookmarks", type=Path, default=DEFAULT_BOOKMARKS)
    args = parser.parse_args()

    result = ingest(args.bookmarks)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
