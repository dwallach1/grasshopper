#!/usr/bin/env python3
"""Print a compact ThesisForge state report from the canonical database."""
from __future__ import annotations

try:
    from scripts import database
except ModuleNotFoundError:
    import database

conn = database.connect()

print("# ThesisForge State\n")
run = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
if run:
    print(f"Last run: {run['completed_at'] or run['started_at']} ({run['notes']})\n")

print("## Theses")
for thesis in conn.execute("SELECT * FROM theses ORDER BY confidence DESC, id ASC"):
    symbols = conn.execute(
        "SELECT symbol FROM thesis_symbols WHERE thesis_id = ? ORDER BY weight_hint DESC, symbol ASC LIMIT 12",
        (thesis["id"],),
    ).fetchall()
    symbols_text = ", ".join(row["symbol"] for row in symbols) or "none"
    print(f"- {thesis['name']} [{thesis['status']}, confidence {thesis['confidence']}]: {symbols_text}")

print("\n## Top Symbols")
for row in conn.execute("SELECT symbol, source_count FROM symbols ORDER BY source_count DESC, symbol ASC LIMIT 20"):
    print(f"- {row['symbol']}: {row['source_count']} bookmark(s)")

print("\n## Trade Proposals")
for row in conn.execute("SELECT * FROM trade_proposals ORDER BY created_at DESC LIMIT 20"):
    print(f"- {row['created_at']} {row['side']} {row['symbol']} ${row['notional']:.2f} [{row['status']}]: {row['rationale']}")

conn.close()
