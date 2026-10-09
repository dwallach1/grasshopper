#!/usr/bin/env python3
"""ODDSBORNE closing-mid (CLV) sweeper: run every 20 minutes; marks each logged sports pass once, in its close window.

For every target decision (close_targets.json + every deepdive_raw/session_*_pass_log.json) whose game starts
5 to 60 minutes from now and that this script has not yet marked, read the live Polymarket US BBO for the slug
and record a kind="close" mark of the logged side's mid (NO mid = 1 - YES mid) through
steward_rpc.record_decision_mark (source polymarket_us_bbo_mid, provisional=False). Marks taken > 60 min out
are provisional and excluded from CLV, so this script never records outside the window.

  .venv/bin/python close_sweep.py [--dry-run] [--add DECISION_ID:SLUG:SIDE ...] [--no-pass-logs] [--verbose]

Targets / state: close_targets.json next to this file. Each entry: decision_id, slug, side, origin, plus state
the sweeper maintains: event_start_at (the venue's gameStartTime, never guessed), start_checked_at, marked_at,
mark_price, minutes_before_start, status. EVERY SESSION THAT LOGS SPORTS PASSES MUST APPEND ITS DECISIONS,
either by writing deepdive_raw/session_<id>_pass_log.json in the usual shape ([{"m": slug, "side": ..,
"r": {"id": decision_id}}], picked up automatically) or by running `close_sweep.py --add ID:SLUG:SIDE ...`.
The steward RPC has no oddsborne read that lists decision ids, hence this sidecar.

Never invents a price or a start time: a missing mid is retried once and otherwise skipped; a slug with no venue
gameStartTime is skipped. --dry-run reads the venue but writes neither the ledger nor close_targets.json.
Prints a one-line summary and always exits 0.
"""
from __future__ import annotations

import fcntl
import glob
import json
import os
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

TARGETS = os.path.join(HERE, "close_targets.json")
LOCK = TARGETS + ".lock"
PASS_LOG_GLOB = os.path.join(HERE, "deepdive_raw", "session_*_pass_log.json")
WIN_MIN, WIN_MAX = 5.0, 60.0          # minutes before start
REFRESH_NEAR_H = 3.0                  # always re-read gameStartTime when the cached start is this close
REFRESH_EVERY_H = 2.0                 # otherwise re-read it at most this often
DONE_AFTER_H = 6.0                    # stop re-checking a start that passed this long ago
PRUNE_AFTER_D = 3.0                   # drop finished targets from the sidecar after this long
DOC = ("Targets for close_sweep.py (ODDSBORNE close/CLV marks). Every session that logs sports passes must append "
       "its decisions: write deepdive_raw/session_<id>_pass_log.json (auto-merged) or run "
       "close_sweep.py --add DECISION_ID:SLUG:SIDE. event_start_at is the venue gameStartTime (never guessed); "
       "marked_at is set only after a non-provisional close mark was recorded by close_sweep.py.")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def parse_ts(v) -> datetime | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- venue (BBO retry inlined, no deepdive_raw)
def _money(v):
    if isinstance(v, dict):
        v = v.get("value")
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def _bbo_sum(bbo):
    if not isinstance(bbo, dict):
        return {"error": "non-dict"}
    if bbo.get("error"):
        return bbo
    md = bbo.get("marketData") or bbo
    bid, ask = _money(md.get("bestBid")), _money(md.get("bestAsk"))
    mid = round((ask + bid) / 2.0, 4) if bid is not None and ask is not None else None
    return {"bid": bid, "ask": ask, "mid": mid, "last": _money(md.get("lastTradePx"))}


def bbo_with_retry(c, slug, tries=4):
    """Live Polymarket US BBO with backoff; treats Cloudflare/HTML bodies as a flake. Never fabricates a quote."""
    last = None
    for i in range(tries):
        try:
            b = c.markets.bbo(slug)
            raw = json.dumps(b, default=str)[:200].lower()
            if "cloudflare" in raw or "<html" in raw:
                raise RuntimeError("cloudflare/html flake")
            return b, _bbo_sum(b), i
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:120]}"
            time.sleep(0.4 * (2 ** i))
    return {"error": last}, {"error": last}, tries


def game_start(c, slug, tries=4):
    """(start datetime | None, error | None) from the venue market's gameStartTime, as the session scripts read it."""
    last = None
    for i in range(tries):
        try:
            r = c.markets.retrieve_by_slug(slug)
            raw = json.dumps(r, default=str)[:200].lower()
            if "cloudflare" in raw or "<html" in raw:
                raise RuntimeError("cloudflare/html flake")
            m = r.get("market", r) if isinstance(r, dict) else {}
            if m.get("slug") not in (None, slug):
                return None, f"venue returned slug {m.get('slug')!r}"
            gst = parse_ts(m.get("gameStartTime"))
            return (gst, None) if gst else (None, "no gameStartTime in market metadata")
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:120]}"
            time.sleep(0.4 * (2 ** i))
    return None, last


def side_mid(sb: dict, side: str):
    mid = sb.get("mid")
    if mid is None:
        return None
    return round(mid if side == "yes" else 1 - mid, 6)


# ---------------------------------------------------------------- targets / state
def load_state() -> dict:
    if not os.path.exists(TARGETS):
        return {"_doc": DOC, "targets": []}
    with open(TARGETS) as f:
        st = json.load(f)
    st.setdefault("targets", [])
    st["_doc"] = DOC
    return st


def save_state(st: dict) -> None:
    st["updated_at"] = iso(utcnow())
    fd, tmp = tempfile.mkstemp(dir=HERE, prefix=".close_targets.", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(st, f, indent=1, default=str)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, TARGETS)


def add_target(st: dict, did: str, slug: str, side: str, origin: str) -> bool:
    side = (side or "").lower()
    if not did or not slug or side not in ("yes", "no"):
        return False
    if any(t["decision_id"] == did for t in st["targets"]) or did in st.setdefault("retired_ids", []):
        return False
    st["targets"].append({"decision_id": did, "slug": slug, "side": side, "origin": origin,
                          "added_at": iso(utcnow()), "event_start_at": None, "start_checked_at": None,
                          "marked_at": None, "status": "pending"})
    return True


def merge_pass_logs(st: dict) -> int:
    n = 0
    for p in sorted(glob.glob(PASS_LOG_GLOB)):
        try:
            rows = json.load(open(p))
        except Exception:
            continue
        for x in rows if isinstance(rows, list) else []:
            did = ((x or {}).get("r") or {}).get("id")
            slug = x.get("m")
            if slug and str(slug).startswith("aec-") and add_target(st, did, slug, x.get("side"), os.path.basename(p)):
                n += 1
    return n


def prune(st: dict, now: datetime) -> None:
    keep = []
    for t in st["targets"]:
        s = parse_ts(t.get("event_start_at"))
        if t.get("status") in ("marked", "started_unmarked") and s and now - s > timedelta(days=PRUNE_AFTER_D):
            st.setdefault("retired_ids", []).append(t["decision_id"])  # so pass logs don't re-add it
            continue
        keep.append(t)
    st["targets"] = keep


# ---------------------------------------------------------------- sweep
def sweep(dry: bool, adds: list[str], use_pass_logs: bool, verbose: bool) -> str:
    now = utcnow()
    st = load_state()
    added = merge_pass_logs(st) if use_pass_logs else 0
    for spec in adds:
        parts = spec.split(":")
        if len(parts) == 3 and add_target(st, parts[0], parts[1], parts[2], "cli_add"):
            added += 1
        elif len(parts) != 3:
            print(f"bad --add {spec!r} (want DECISION_ID:SLUG:SIDE)", file=sys.stderr)

    pending = [t for t in st["targets"] if not t.get("marked_at") and t.get("status") != "started_unmarked"]
    c = None
    if pending:
        from pm_enter import make_client
        c = make_client()

    # refresh venue gameStartTime per distinct slug (never guessed)
    starts: dict[str, datetime | None] = {}
    errs: dict[str, str] = {}
    for slug in sorted({t["slug"] for t in pending}):
        cached = [t for t in pending if t["slug"] == slug]
        cs = parse_ts(cached[0].get("event_start_at"))
        chk = parse_ts(cached[0].get("start_checked_at"))
        need = (cs is None or (cs - now) < timedelta(hours=REFRESH_NEAR_H)
                or chk is None or (now - chk) > timedelta(hours=REFRESH_EVERY_H))
        if cs is not None and now - cs > timedelta(hours=DONE_AFTER_H):
            need = False
        if need:
            gst, err = game_start(c, slug)
            if gst is None:
                errs[slug] = err or "unknown"
                starts[slug] = cs if cs and not err.startswith("venue returned") else None
            else:
                starts[slug] = gst
                for t in cached:
                    t["event_start_at"], t["start_checked_at"] = iso(gst), iso(utcnow())
        else:
            starts[slug] = cs

    marked, skipped, waiting, notes = 0, 0, 0, []
    bbo_cache: dict[str, dict] = {}
    for t in pending:
        slug, side = t["slug"], t["side"]
        start = starts.get(slug)
        if start is None:
            skipped += 1
            notes.append(f"{slug}: no start ({errs.get(slug)})")
            continue
        mins = (start - utcnow()).total_seconds() / 60
        if mins <= 0:
            if now - start > timedelta(hours=DONE_AFTER_H):
                t["status"] = "started_unmarked"
            else:
                t["status"] = "started"
            skipped += 1
            continue
        if mins > WIN_MAX:
            t["status"] = "pending"
            waiting += 1
            continue
        if mins < WIN_MIN:
            skipped += 1
            t["status"] = "missed_window"
            notes.append(f"{slug}:{side}: {mins:.1f} min to start (< {WIN_MIN:g})")
            continue
        # in window: live BBO, missing mid retried once, otherwise skip
        if slug not in bbo_cache:
            _, sb, _ = bbo_with_retry(c, slug)
            if sb.get("mid") is None:
                time.sleep(2.0)
                _, sb, _ = bbo_with_retry(c, slug)
            bbo_cache[slug] = sb
        sb = bbo_cache[slug]
        px = side_mid(sb, side)
        observed = utcnow()
        mins = (start - observed).total_seconds() / 60
        if px is None:
            skipped += 1
            t["status"] = "no_mid"
            notes.append(f"{slug}:{side}: no mid ({sb.get('error') or 'bid/ask %s/%s' % (sb.get('bid'), sb.get('ask'))})")
            continue
        if mins <= 0 or mins > WIN_MAX:
            skipped += 1
            notes.append(f"{slug}:{side}: left window during read ({mins:.1f} min)")
            continue
        yes_bbo = {k: sb.get(k) for k in ("bid", "ask", "mid", "last")}
        meta = {"slug": slug, "side": side, "yes_bbo": yes_bbo, "minutes_before_start": round(mins),
                "provisional": False, "by": "close_sweep"}
        if dry:
            marked += 1
            notes.append(f"DRY {t['decision_id'][:8]} {slug}:{side} px={px} mins={mins:.1f}")
            continue
        try:
            import steward_rpc as S
            S.record_decision_mark("oddsborne", decision_id=t["decision_id"], price=px, observed_at=iso(observed),
                                   source="polymarket_us_bbo_mid", kind="close", event_start_at=iso(start), meta=meta)
            t.update(marked_at=iso(observed), mark_price=px, minutes_before_start=round(mins, 1),
                     yes_bbo=yes_bbo, status="marked")
            marked += 1
        except Exception as e:  # close marks replace earlier ones, so a failed/uncertain write is retried next run
            skipped += 1
            t["status"] = "rpc_error"
            t["last_error"] = f"{type(e).__name__}: {str(e)[:200]}"
            notes.append(f"{slug}:{side}: rpc {t['last_error']}")

    prune(st, now)
    if not dry:
        save_state(st)

    fut = sorted((s, sl) for sl, s in starts.items() if s and s > utcnow()
                 and any(not t.get("marked_at") for t in pending if t["slug"] == sl))
    if fut:
        s, sl = fut[0]
        dt = s - utcnow()
        h, m = divmod(int(dt.total_seconds() // 60), 60)
        pt = s.astimezone(ZoneInfo("America/Los_Angeles")).strftime("%m-%d %H:%M %Z")
        nxt = f"next start {iso(s)} ({pt}, {sl}, in {h}h{m:02d}m)"
    else:
        nxt = "next start none"
    if verbose or dry:
        for n in notes:
            print("  " + n)
    tag = "DRY-RUN " if dry else ""
    extra = f", waiting {waiting}, targets {len(st['targets'])} (+{added} new)"
    return f"{tag}close_sweep: marked {marked}, skipped {skipped}, {nxt}{extra}"


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    verbose = "--verbose" in argv
    use_pl = "--no-pass-logs" not in argv
    adds, i = [], 0
    while i < len(argv):
        if argv[i] == "--add":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                adds.append(argv[i]); i += 1
            continue
        i += 1
    lockf = open(LOCK, "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("close_sweep: marked 0, skipped 0, next start unknown (another sweep holds the lock)")
        return 0
    try:
        print(sweep(dry, adds, use_pl, verbose), flush=True)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(f"close_sweep: marked 0, skipped 0, next start unknown (error {type(e).__name__}: {str(e)[:160]})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
