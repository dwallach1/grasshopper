
import json, base64, sys
from pathlib import Path
sys.path.insert(0,"/workspace/bookmark-ingest")
import classify

PROMPT_VERSION = "quantanamo-bucket-v1"
MODEL = classify.MODEL

def rows_payload(posts):
    out = []
    symbol_rows = []
    url_rows = []
    summary = []
    for post in posts:
        cls = classify.classify(post)
        pid = str(post["id"])
        rec = {
            "id": pid,
            "author_id": post.get("author_id"),
            "created_at": post.get("created_at"),
            "text": post.get("text") or "",
            "raw_json": post,
            "market_score": cls["market_score"],
            "is_market_related": cls["is_market_related"],
            "classification_model": MODEL,
            "classification_prompt_version": PROMPT_VERSION,
            "classification_output": cls["classification_output"],
        }
        out.append(rec)
        text = rec["text"]
        for sym in cls["symbols"]:
            if sym in getattr(classify, 'SYMBOL_SKIP', classify.NEOCLOUD_SKIP):
                continue
            source = "cashtag" if f"${sym}" in text else "text"
            symbol_rows.append((pid, sym, source))
        for u in cls["urls"]:
            url_rows.append((pid, u))
        summary.append({
            "id": pid,
            "bucket": cls["classification_output"]["bucket"],
            "claim": cls["classification_output"]["claim_summary"],
            "symbols": [s for s in cls["symbols"] if s not in getattr(classify, 'SYMBOL_SKIP', classify.NEOCLOUD_SKIP)],
            "market_score": cls["market_score"],
        })
    return out, symbol_rows, url_rows, summary

def emit_b64_sql(posts):
    recs, symbol_rows, url_rows, summary = rows_payload(posts)
    blob = json.dumps(recs, ensure_ascii=False, separators=(",", ":")).encode()
    b64 = base64.b64encode(blob).decode()
    sql = f"""
WITH payload AS (
  SELECT convert_from(decode('{b64}', 'base64'), 'utf8')::jsonb AS j
),
ins AS (
  INSERT INTO bookmarks (
    id, author_id, created_at, fetched_at, text, raw_json,
    market_score, is_market_related,
    classification_model, classification_prompt_version, classification_output, classified_at
  )
  SELECT
    rec->>'id',
    rec->>'author_id',
    NULLIF(rec->>'created_at','')::timestamptz,
    now(),
    rec->>'text',
    rec->'raw_json',
    (rec->>'market_score')::smallint,
    (rec->>'is_market_related')::boolean,
    rec->>'classification_model',
    rec->>'classification_prompt_version',
    rec->'classification_output',
    now()
  FROM payload, jsonb_array_elements(payload.j) rec
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT id FROM ins;
"""
    return sql, symbol_rows, url_rows, summary
