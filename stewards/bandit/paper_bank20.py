#!/usr/bin/env python3
"""Paper rule 'bank at +20%' (GRASSHOPPER 2026-09-26). For a closed clip, find the first 5-min venue mark
>= +20% vs entry; paper exit = that mark's pct, else the real exit pct. Writes meme_positions.meta.paper_bank20.
Usage: paper_bank20.py <position_id> [...]   (run after every close; no trading)."""
import json, os, sys
from decimal import Decimal


def _require_runtime(steward: str, modules: tuple[str, ...]) -> None:
    """Fail fast, before any venue or DB call, when the steward venv is missing or broken.

    The box's durable store never keeps `.venv/`, so a box refresh wipes it; sync_box.sh rebuilds it.
    """
    broken = []
    for module in modules:
        try:
            __import__(module)
        except Exception as exc:  # ImportError, or a broken binary wheel
            broken.append(f"{module} ({type(exc).__name__})")
    if broken:
        repo = os.environ.get("GRASSHOPPER_REPO") or os.path.join(os.sep, "workspace", "grasshopper")
        sys.stderr.write(
            f"{steward}: Python env not ready: {', '.join(broken)} (interpreter {sys.executable}).\n"
            f"Nothing was sent. Run:  bash {os.path.join(repo, 'stewards', 'sync_box.sh')}\n"
            f"then retry with {os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), '.venv', 'bin', 'python')}.\n"
        )
        raise SystemExit(3)


_require_runtime("bandit", ("psycopg",))

from db_connect import connect  # noqa: E402
TH = Decimal(20)
def run(pid):
    with connect() as c:
        cur = c.cursor()
        cur.execute("select p.opened_at, p.status, t.symbol from meme_positions p join meme_tokens t on t.id=p.token_id where p.id=%s::uuid", (pid,))
        opened, status, sym = cur.fetchone()
        cur.execute("""select as_of, (payload->>'pnl_pct_vs_entry')::numeric from meme_pnl
            where payload->>'position_id'=%s and payload ? 'pnl_pct_vs_entry' order by as_of""", (pid,))
        marks = cur.fetchall()
        if not marks:
            return {"symbol": sym, "error": "no marks"}
        hit = next((m for m in marks if m[1] >= TH), None)
        real = marks[-1][1]
        out = {"rule": "bank_at_+20pct", "source": "5min venue marks (meme_pnl pnl_pct_vs_entry)",
               "real_exit_pct": str(round(real, 2)),
               "paper_exit_pct": str(round(hit[1] if hit else real, 2)),
               "triggered": bool(hit),
               "trigger_minute": round((hit[0]-opened).total_seconds()/60) if hit else None,
               "delta_pct_pts": str(round((hit[1] if hit else real) - real, 2)),
               "note": "real_exit_pct = last watch mark before exit, not fill; compare in pct points"}
        cur.execute("update meme_positions set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('paper_bank20', %s::jsonb) where id=%s::uuid",
                    (json.dumps(out), pid))
        c.commit()
        out["symbol"] = sym
        return out
if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(run(p)))
