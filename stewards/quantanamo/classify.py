#!/usr/bin/env python3
"""Classify bookmark posts and emit SQL for public.bookmarks (+ symbols/urls)."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PROMPT_VERSION = "quantanamo-bucket-v1"
MODEL = "quantanamo-classifier"

CASHTAG = re.compile(r"\$([A-Z]{1,6}(?:\.[A-Z]{1,2})?)\b")
URL_RE = re.compile(r"https?://[^\s]+")

NEOCLOUD_SKIP = {"IREN", "CRWV", "NBIS", "CIFR", "APLD", "CORZ"}
SYMBOL_SKIP = NEOCLOUD_SKIP | {"PLTR"}

FALSE_TICKERS = {
    "A", "I", "THE", "FOR", "AND", "OR", "TO", "IN", "ON", "AT", "IT", "BE", "SO",
    "IF", "AI", "US", "UK", "EU", "CEO", "CFO", "IPO", "ETF", "GDP", "CPI", "PPI",
    "FOMC", "OTM", "ITM", "ATM", "YTD", "EPS", "ATH", "ATL", "IMO", "FYI", "TLDR",
    "LOL", "OMG", "WTF", "API", "GPU", "CPU", "USD", "NLP", "LLM", "BOT", "APP",
    "WEB", "DAY", "YEAR", "Q1", "Q2", "Q3", "Q4", "FY", "YOY", "MOM", "PE", "PS",
    "ROI", "IRR", "ARR", "MRR", "KPI", "NFT", "DAO", "DEX", "CEX", "TVL", "APY",
    "APR", "BTFD", "HODL", "FOMO", "FUD", "DYOR", "NFA", "WSB", "OTC", "ADR",
    "JUST", "HERE", "THIS", "THAT", "FROM", "WITH", "HAVE", "WILL", "YOUR",
}

GROK_RE = re.compile(r"\bgrok\s*bot\b|\bgrokbot\b|\bgrok-bot\b", re.I)
PNL_RE = re.compile(
    r"turned \$\d|\bmade \$\d|into \$\d[\d,]*|sitting on \$\d|woke up to a \$\d|\$\d[\d,]* profit",
    re.I,
)
PELOSI_RE = re.compile(r"pelosi|pelisi|politician[s]?\s+(is\s+)?buy", re.I)
PICKLIST_RE = re.compile(
    r"\d+\s+stocks|stocks to watch|top (stock )?picks|could 10x|10x:|500%\+|generational.wealth|watchlist",
    re.I,
)
EARNINGS_RE = re.compile(r"\bearnings\b|\beps\b|\brevenue:|\bbeat\b.*\best\b|\bmiss\b.*\best\b", re.I)
FLOW_RE = re.compile(
    r"purchased .{0,40}calls|bought calls|13f|disclosed (new )?position|shorted|added \d|calls for",
    re.I,
)
SUPPLY_RE = re.compile(
    r"supply chain|data center|compute|turbine|power demand|nscale|foundry|capex",
    re.I,
)
DESK_RE = re.compile(
    r"bloomberg terminal|grajeda|three\.js|threejs|exploded-view|dashboard|terminal on grok",
    re.I,
)
PROCESS_RE = re.compile(
    r"pre-event|position siz|autopsy|how i (trade|research|scan)|playbook|checklist before",
    re.I,
)
CODING_RE = re.compile(r"cyclomatic|lint|centering a div|compound engineering|chief of staff agent", re.I)


def extract_symbols(text: str) -> list[str]:
    out = []
    seen = set()
    for m in CASHTAG.findall(text or ""):
        if m in FALSE_TICKERS or len(m) > 6:
            continue
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


def extract_urls(post: dict) -> list[dict]:
    urls = []
    seen = set()
    text = post.get("text") or ""
    for u in URL_RE.findall(text):
        u = u.rstrip(".,);]")
        if u not in seen:
            seen.add(u)
            urls.append({"url": u, "expanded_url": None, "display_url": None})
    if post.get("url") and post["url"] not in seen:
        urls.append({"url": post["url"], "expanded_url": post["url"], "display_url": "x.com"})
    return urls


def one_line(text: str, n: int = 160) -> str:
    s = " ".join((text or "").split())
    return s[:n]


def classify(post: dict) -> dict:
    text = post.get("text") or ""
    pid = str(post["id"])
    symbols = extract_symbols(text)
    excerpt = one_line(text, 180)

    bucket = "noise"
    claim_type = "none"
    claim_summary = excerpt[:140]
    claim_confidence = 45
    market_relevance = 15
    themes: list[str] = []
    candidates: list[str] = []

    is_grok = bool(GROK_RE.search(text))
    is_pnl = bool(PNL_RE.search(text))
    is_pelosi = bool(PELOSI_RE.search(text))
    is_pick = bool(PICKLIST_RE.search(text))
    is_earn = bool(EARNINGS_RE.search(text))
    is_flow = bool(FLOW_RE.search(text))
    is_supply = bool(SUPPLY_RE.search(text))
    is_desk = bool(DESK_RE.search(text))
    is_process = bool(PROCESS_RE.search(text))
    is_coding = bool(CODING_RE.search(text))

    # Priority: noise traps first, then ops/ux/process, then investment seed
    if is_pelosi:
        bucket = "noise"
        claim_type = "pelosi_list"
        claim_summary = "Politician/Pelosi holdings list — engagement bait, not a thesis."
        market_relevance = 20
        claim_confidence = 80
        themes = ["noise"]
    elif is_pnl and is_grok:
        bucket = "noise"
        claim_type = "unverified_pnl"
        claim_summary = "Unverified Grok Bot P/L flex; not a tradeable claim."
        market_relevance = 15
        claim_confidence = 70
        themes = ["noise", "agent_ops"]
    elif (is_pick or len(symbols) >= 6) and not is_earn and not is_flow:
        bucket = "noise"
        claim_type = "engagement_bait"
        claim_summary = "Generic pick-list / 10x bait without a grounded claim."
        market_relevance = 25
        claim_confidence = 60
        themes = ["noise"]
        if symbols:
            # still capture names for later skip-scan; low relevance
            pass
    elif is_desk:
        bucket = "desk_ux"
        claim_type = "ux_inspiration"
        claim_summary = one_line(text, 140)
        market_relevance = 35
        claim_confidence = 75
        themes = ["desk_ux"]
    elif is_coding or (is_grok and not is_earn):
        bucket = "agent_ops"
        claim_type = "agent_tactic"
        claim_summary = one_line(text, 140)
        market_relevance = 30
        claim_confidence = 75
        themes = ["agent_ops"]
    elif is_process:
        bucket = "process_strategy"
        claim_type = "process"
        claim_summary = one_line(text, 140)
        market_relevance = 55
        claim_confidence = 70
        themes = ["process"]
    elif is_earn or is_flow or is_supply or (symbols and not is_pick):
        bucket = "investment_seed"
        if is_earn:
            claim_type = "earnings"
            market_relevance = 75
        elif is_flow:
            claim_type = "flow"
            market_relevance = 70
        elif is_supply:
            claim_type = "supply_chain"
            market_relevance = 70
        else:
            claim_type = "ticker_mention"
            market_relevance = 55
        claim_confidence = 65
        claim_summary = one_line(text, 140)
        themes = ["markets"]
        candidates = symbols[:10]
    else:
        bucket = "noise"
        claim_type = "none"
        claim_summary = one_line(text, 140)
        market_relevance = 10
        themes = ["noise"]

    is_market = bucket == "investment_seed" or market_relevance >= 50
    return {
        "classification_output": {
            "bookmark_id": pid,
            "bucket": bucket,
            "themes": themes,
            "symbols": symbols,
            "candidates": candidates,
            "claim_type": claim_type,
            "claim_summary": claim_summary,
            "claim_confidence": int(claim_confidence),
            "market_relevance": int(market_relevance),
            "claim_evidence_excerpt": excerpt,
        },
        "market_score": int(market_relevance),
        "is_market_related": bool(is_market),
        "symbols": symbols,
        "urls": extract_urls(post),
    }


def dollar_quote(s: str, tag: str) -> str:
    # ensure tag not in s
    t = tag
    i = 0
    while f"${t}$" in s:
        i += 1
        t = f"{tag}{i}"
    return f"${t}${s}${t}$"


def sql_str(s: str | None) -> str:
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def emit_sql(posts: list[dict], page_tag: str) -> str:
    rows = []
    symbol_rows = []
    url_rows = []
    summary = []
    for post in posts:
        pid = str(post["id"])
        cls = classify(post)
        raw = json.dumps(post, ensure_ascii=False, separators=(",", ":"))
        out = json.dumps(cls["classification_output"], ensure_ascii=False, separators=(",", ":"))
        text = post.get("text") or ""
        author = post.get("author_id")
        created = post.get("created_at")
        created_sql = sql_str(created) + "::timestamptz" if created else "NULL"
        market = "TRUE" if cls["is_market_related"] else "FALSE"
        rows.append(
            "("
            + ", ".join(
                [
                    sql_str(pid),
                    sql_str(author),
                    created_sql,
                    "now()",
                    dollar_quote(text, "t"),
                    dollar_quote(raw, "j") + "::jsonb",
                    str(cls["market_score"]),
                    market,
                    sql_str(MODEL),
                    sql_str(PROMPT_VERSION),
                    dollar_quote(out, "c") + "::jsonb",
                    "now()",
                ]
            )
            + ")"
        )
        for sym in cls["symbols"]:
            if sym in SYMBOL_SKIP:
                continue
            source = "cashtag" if f"${sym}" in text else "text"
            symbol_rows.append((pid, sym, source))
        for u in cls["urls"]:
            url_rows.append((pid, u))
        summary.append(
            {
                "id": pid,
                "bucket": cls["classification_output"]["bucket"],
                "claim": cls["classification_output"]["claim_summary"],
                "symbols": cls["symbols"],
                "market_score": cls["market_score"],
            }
        )

    ins = f"""
WITH ins AS (
INSERT INTO bookmarks (
  id, author_id, created_at, fetched_at, text, raw_json,
  market_score, is_market_related,
  classification_model, classification_prompt_version, classification_output, classified_at
) VALUES
{','.join(rows)}
ON CONFLICT (id) DO NOTHING
RETURNING id
)
SELECT id FROM ins;
"""
    # symbols/urls inserted in a second statement using only returned ids
    # we emit a follow-up SQL that joins against bookmarks that exist
    # caller will run returning first, then this with the new ids
    return ins, symbol_rows, url_rows, summary


def emit_child_sql(new_ids: list[str], symbol_rows, url_rows) -> str:
    new = set(new_ids)
    parts = []
    svals = []
    for pid, sym, source in symbol_rows:
        if pid in new:
            svals.append(f"({sql_str(pid)}, {sql_str(sym)}, {sql_str(source)})")
    if svals:
        parts.append(
            "INSERT INTO bookmark_symbols (bookmark_id, symbol, source) VALUES\n"
            + ",\n".join(svals)
            + "\nON CONFLICT (bookmark_id, symbol) DO NOTHING;"
        )
    uvals = []
    for pid, u in url_rows:
        if pid in new:
            uvals.append(
                f"({sql_str(pid)}, {sql_str(u['url'])}, {sql_str(u.get('expanded_url'))}, {sql_str(u.get('display_url'))})"
            )
    if uvals:
        parts.append(
            "INSERT INTO bookmark_urls (bookmark_id, url, expanded_url, display_url) VALUES\n"
            + ",\n".join(uvals)
            + "\nON CONFLICT (bookmark_id, url) DO NOTHING;"
        )
    return "\n".join(parts) if parts else "SELECT 1;"


SWEEP_SELECT_SQL = (
    "SELECT id, text, raw_json FROM public.bookmarks "
    "WHERE classified_at IS NULL ORDER BY created_at;"
)


def emit_sweep_sql(rows: list[dict]) -> str | None:
    """UPDATE every given (unclassified) row. Guarded by classified_at IS NULL;
    never touches fetched_at or already-classified rows. Returns None if no rows."""
    if not rows:
        return None
    recs = []
    for r in rows:
        post = dict(r.get("raw_json") or {})
        post["id"] = str(r["id"])
        post["text"] = r.get("text") or post.get("text") or ""
        cls = classify(post)
        recs.append({"id": post["id"], "s": cls["market_score"],
                     "m": cls["is_market_related"], "o": cls["classification_output"]})
    blob = dollar_quote(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), "p")
    return f"""UPDATE public.bookmarks b SET
  market_score = (r->>'s')::smallint,
  is_market_related = (r->>'m')::boolean,
  classification_output = r->'o',
  classification_model = {sql_str(MODEL)},
  classification_prompt_version = {sql_str(PROMPT_VERSION)},
  classified_at = now()
FROM jsonb_array_elements({blob}::jsonb) r
WHERE b.id = r->>'id' AND b.classified_at IS NULL
RETURNING b.id, b.classification_output->>'bucket' AS bucket;
"""


def sweep_main(argv: list[str]) -> None:
    """sweep            -> print the SELECT to run (step 1)
    sweep rows.json  -> rows.json = result of that SELECT; writes sql/sweep_update.sql
                        or reports nothing to do when there are zero rows."""
    if len(argv) < 1:
        print(json.dumps({"step": "run this SELECT via Supabase execute_sql, save rows as JSON, then: classify.py sweep rows.json", "sql": SWEEP_SELECT_SQL}))
        return
    rows = json.loads(Path(argv[0]).read_text())
    if isinstance(rows, dict) and "result" in rows:
        rows = rows["result"]
    sql = emit_sweep_sql(rows)
    out = Path("/workspace/bookmark-ingest/sql/sweep_update.sql")
    if sql is None:
        if out.exists():
            out.unlink()
        print(json.dumps({"unclassified": 0, "write": False, "msg": "nothing to classify; no SQL emitted"}))
        return
    out.write_text(sql)
    print(json.dumps({"unclassified": len(rows), "write": True, "sql": str(out)}))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "sweep":
        return sweep_main(sys.argv[2:])
    path = Path(sys.argv[1])
    data = json.loads(path.read_text())
    posts = data["posts"] if isinstance(data, dict) and "posts" in data else data
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
        posts = data["data"]
    ins, symbol_rows, url_rows, summary = emit_sql(posts, path.stem)
    outdir = Path("/workspace/bookmark-ingest/sql")
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"{path.stem}_insert.sql").write_text(ins)
    meta = {
        "n_posts": len(posts),
        "ids": [p["id"] for p in posts],
        "summary": summary,
        "symbol_rows": symbol_rows,
        "url_rows": [{"bookmark_id": pid, **u} for pid, u in url_rows],
    }
    Path("/workspace/bookmark-ingest/out").mkdir(parents=True, exist_ok=True)
    Path(f"/workspace/bookmark-ingest/out/{path.stem}_meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False)
    )
    print(json.dumps({"wrote": str(outdir / f"{path.stem}_insert.sql"), "n": len(posts), "ids": meta["ids"],
                      "next": "ALWAYS run the backlog sweep too: classify.py sweep", "sweep_select": SWEEP_SELECT_SQL}))


if __name__ == "__main__":
    main()
