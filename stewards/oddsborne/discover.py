#!/usr/bin/env python3
"""ODDSBORNE public market discovery (read-only) -> deepdive_raw/sweep_<YYYYMMDD>[_pm]_p2.json.

Usage: discover.py [--date YYYY-MM-DD] [--session am|pm] [--force] [--max-age-hours H]
  --date defaults to ODDS_DATE or today in America/New_York (same convention as session_daily.py / session_pm.py).
  Without --force an existing fresh output (as_of within --max-age-hours, n_seen > 0) is reused.

Replaces the hand-built dated sweep_<date>_discover.py scripts. Only Polymarket US read endpoints are called
(search.query, events.list, events.retrieve_by_slug); the only write is the local JSON output file.
session_daily.py / session_pm.py call ensure() in-process when the dated output is missing or stale.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

RAW_DIR = Path(os.environ.get("ODDS_RAW_DIR", "/workspace/oddsborne/deepdive_raw"))
MAX_AGE_HOURS = 6.0

QUERIES = [
    "Fed", "FOMC", "CPI", "PCE", "inflation", "interest rate", "payrolls", "NFP", "GDP", "recession", "tariff",
    "unemployment", "Banxico", "Bank of Japan", "BoJ", "ECB", "rate decision",
    "election", "Senate", "House", "midterms", "governor", "primary", "Trump", "Supreme Court", "Congress",
    "Bitcoin", "Ethereum", "crypto", "BTC", "ETH", "Solana",
    "NFL", "NBA", "MLB", "soccer", "tennis", "UFC", "Commanders", "Cowboys",
    "Oscars", "Emmy", "Nobel", "Pope", "celebrity", "Box Office", "Grammy",
    "temperature", "highest temperature", "LAX", "NYC", "Miami", "San Francisco",
]
CATS = [["Politics"], ["Econ"], ["Economics"], ["Crypto"], ["Sports"], ["US Politics"], ["US Econ"], ["Culture"],
        ["Entertainment"], ["Climate"]]
TAGS = ["politics", "elections", "midterms", "crypto", "economics", "econ", "sports", "fed", "macro", "us-econ",
        "culture", "entertainment", "climate", "weather"]
KNOWN_STATIC = [
    "usfed-fomc-2026-10-28", "usfed-2026", "fed-gt25bps", "liscook-fedgov", "jerpowgov",
    "usse-midterms-2026-11-03", "usho-midterms-2026-11-03",
    "uscpi-september-yoy-2026-10-14", "uscpi-september-mom-2026-10-14",
    "uscpicore-september-yoy-2026-10-14", "uscpicore-september-mom-2026-10-14",
    "btc-hitprice-high-yr-12-31-2026", "btc-above-yr-12-31-2026",
]
WX_CITIES = ("lax", "nyc", "mia", "sfo", "mdw")
SPORTS_TAGS = ("nfl", "mlb")  # league tags paged in full as a fallback so game events never depend on window paging
PAGE_LIMIT = 50
MAX_PAGES = 200  # safety stop (10k events per listing); hitting it is recorded as a blocker


def iso_z(dt: datetime) -> str:
    """RFC 3339 UTC timestamp. The gateway does not honour date-only (YYYY-MM-DD) endDateMin/endDateMax:
    it silently returns the stale backlog of never-closed 2025 events instead of the requested window."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def session_date(argv=None) -> str:
    """--date YYYY-MM-DD or ODDS_DATE, else today in America/New_York."""
    argv = sys.argv if argv is None else argv
    if "--date" in argv:
        i = argv.index("--date")
        if i + 1 < len(argv):
            return argv[i + 1]
    return os.environ.get("ODDS_DATE") or datetime.now(ZoneInfo("America/New_York")).date().isoformat()


def output_path(day: str, session: str = "am", raw_dir: Path | None = None) -> Path:
    stamp = day.replace("-", "")
    return Path(raw_dir or RAW_DIR) / f"sweep_{stamp}{'_pm' if session == 'pm' else ''}_p2.json"


def known_slugs(day: str) -> list:
    d0 = _date.fromisoformat(day)
    days = [d0.isoformat(), (d0 + timedelta(days=1)).isoformat()]
    return KNOWN_STATIC + [f"temp-{city}high-{d}" for city in WX_CITIES for d in days]


def is_sports_event(slug: str, ev: dict) -> bool:
    """Same NFL/MLB game filter the session scripts match against (props/fantasy excluded)."""
    sl = slug.lower()
    if not (sl.startswith("nfl-") or sl.startswith("mlb-") or "nfl" in sl or "mlb" in sl):
        return False
    return not any(x in sl for x in ("rec-", "most", "fp-", "fantasy", "lastundefeated", "nextteam", "wk4", "race", "margin"))


def count_sports(events: dict) -> int:
    return sum(1 for s, ev in (events or {}).items() if not ev.get("closed") and is_sports_event(s, ev))


def load(path: Path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def staleness(path: Path, now: datetime | None = None, max_age_hours: float = MAX_AGE_HOURS):
    """None when the output is usable, else a reason string (missing / unreadable / empty / old)."""
    now = now or datetime.now(timezone.utc)
    if not Path(path).exists():
        return "missing"
    d = load(path)
    if not isinstance(d, dict):
        return "unreadable"
    if not d.get("events") or not d.get("n_seen"):
        return "empty (n_seen=0)"
    try:
        as_of = datetime.fromisoformat(str(d.get("as_of")).replace("Z", "+00:00"))
    except Exception:
        return "no as_of"
    age = (now - as_of).total_seconds() / 3600
    if age > max_age_hours:
        return f"stale ({age:.1f}h old > {max_age_hours}h)"
    return None


class Sweep:
    def __init__(self, client, now: datetime | None = None, sleep=time.sleep, log=print):
        self.c, self.now, self.sleep, self.log = client, now or datetime.now(timezone.utc), sleep, log
        self.seen, self.blockers = {}, []

    def put(self, ev):
        if not isinstance(ev, dict):
            return
        if isinstance(ev.get("event"), dict):
            ev = ev["event"]
        slug = ev.get("slug")
        if not slug:
            return
        mkts = ev.get("markets") or []
        mslugs = [m.get("slug") for m in mkts if isinstance(m, dict) and m.get("slug")]
        entry = {"slug": slug, "id": ev.get("id"), "title": ev.get("title"), "endDate": ev.get("endDate"),
                 "category": ev.get("category"), "tags": ev.get("tags"), "closed": ev.get("closed"),
                 "archived": ev.get("archived"), "active": ev.get("active"), "n_markets": len(mkts),
                 "market_slugs": mslugs, "volume": ev.get("volume"), "liquidity": ev.get("liquidity")}
        old = self.seen.get(slug)
        if old is None:
            self.seen[slug] = entry
            return
        if len(mslugs) > len(old.get("market_slugs") or []):
            old["market_slugs"], old["n_markets"] = mslugs, len(mslugs)
        for k in ("title", "endDate", "category", "volume", "liquidity"):
            if entry.get(k) and not old.get(k):
                old[k] = entry[k]

    def call(self, fn, label, pause=0.45):
        for i in range(6):
            try:
                r = fn()
                self.sleep(pause)
                return r
            except Exception as e:
                msg = f"{type(e).__name__} {e}".lower()
                if "ratelimit" in msg or "1015" in msg or "429" in msg or " rate" in msg:
                    w = 22 * (i + 1)
                    self.log(f"rate {label} sleep {w}s", flush=True)
                    self.blockers.append(f"{label}: {type(e).__name__} retry {i + 1}")
                    self.sleep(w)
                    continue
                self.blockers.append(f"{label}: {type(e).__name__}: {str(e)[:100]}")
                self.log(f"ERR {label}: {type(e).__name__}: {str(e)[:100]}", flush=True)
                return None
        return None

    def page(self, params: dict, label: str, pause: float = 0.55) -> int:
        """Page events.list until a short/empty page (or a page with nothing new); returns events seen."""
        n, slugs = 0, set()
        for i in range(MAX_PAGES):
            off = i * PAGE_LIMIT
            r = self.call(lambda off=off: self.c.events.list({**params, "limit": PAGE_LIMIT, "offset": off}), f"{label}[{off}]", pause)
            evs = (r or {}).get("events") or []
            new = {(ev.get("event") or ev).get("slug") for ev in evs if isinstance(ev, dict)} - slugs
            for ev in evs:
                self.put(ev)
            n += len(evs)
            slugs |= new
            if len(evs) < PAGE_LIMIT or not new:
                return n
        self.blockers.append(f"{label}: stopped at MAX_PAGES={MAX_PAGES} ({n} events); window not fully paged")
        return n

    def run(self, day: str) -> dict:
        c, now = self.c, self.now
        cut21, cut120 = now + timedelta(days=21), now + timedelta(days=120)
        end_min = iso_z((now - timedelta(days=2)).replace(hour=0, minute=0, second=0, microsecond=0))
        e21, e120 = iso_z(cut21), iso_z(cut120)
        for q in QUERIES:
            r = self.call(lambda q=q: c.search.query({"query": q, "limit": 40, "status": "active"}), f"search[{q}]")
            for ev in (r or {}).get("events") or []:
                self.put(ev)
        base = {"limit": 50, "active": True, "closed": False}
        for cats in CATS:
            r = self.call(lambda cats=cats: c.events.list({**base, "categories": cats, "endDateMin": end_min, "endDateMax": e120}), f"cat{cats}")
            for ev in (r or {}).get("events") or []:
                self.put(ev)
        for tag in TAGS:
            r = self.call(lambda tag=tag: c.events.list({**base, "tagSlug": tag, "endDateMin": end_min, "endDateMax": e120}), f"tag[{tag}]")
            for ev in (r or {}).get("events") or []:
                self.put(ev)
        for lo, hi, lab in ((end_min, e21, "near"), (e21, e120, "long")):
            self.page({**base, "endDateMin": lo, "endDateMax": hi}, lab)
        for tag in SPORTS_TAGS:
            self.page({**base, "tagSlug": tag, "endDateMin": end_min, "endDateMax": e21}, f"sports[{tag}]")
        for slug in known_slugs(day):
            r = self.call(lambda slug=slug: c.events.retrieve_by_slug(slug), f"get[{slug}]")
            if r:
                self.put(r)
        self.log(f"discover seen={len(self.seen)}", flush=True)
        return self.result()

    def result(self) -> dict:
        now = self.now
        near, longer = [], []
        for slug, ev in self.seen.items():
            if ev.get("closed") or ev.get("archived"):
                continue
            try:
                dt = datetime.fromisoformat(str(ev.get("endDate")).replace("Z", "+00:00")) if ev.get("endDate") else None
            except Exception:
                dt = None
            if dt is None:
                longer.append(slug)
            elif dt < now - timedelta(days=3):
                continue
            elif dt <= now + timedelta(days=21):
                near.append(slug)
            else:
                longer.append(slug)
        return {"as_of": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "n_seen": len(self.seen), "n_near": len(near),
                "n_longer": len(longer), "n_sports": count_sports(self.seen), "near_slugs": near,
                "longer_slugs": longer, "events": self.seen, "blockers": self.blockers}


def discovery_error(p2: dict, n_sports: int, n_games: int, name: str = "discovery output"):
    """Loud ERROR text when discovery found nothing at all, or no sports events while games are scheduled; else None."""
    p2 = p2 or {}
    if not p2.get("n_seen") or not p2.get("events"):
        return f"ERROR: discovery returned zero events overall ({name}); market universe unknown"
    if n_sports == 0 and n_games > 0:
        return (f"ERROR: zero sports events discovered with {n_games} games scheduled on Bovada "
                f"(discovery n_seen={p2.get('n_seen')}, {name}); sports sweep did not run")
    return None


def make_client():
    sys.path.insert(0, "/workspace/oddsborne")
    from load_secrets import load_secrets
    from polymarket_us import PolymarketUS
    sec = load_secrets()
    return PolymarketUS(key_id=sec["POLYMARKET_US_KEY_ID"], secret_key=sec["POLYMARKET_US_SECRET_KEY"], timeout=45.0)


def discover(day: str, session: str = "am", client=None, raw_dir: Path | None = None, now=None, sleep=time.sleep, log=print) -> dict:
    out = Sweep(client or make_client(), now=now, sleep=sleep, log=log).run(day)
    path = output_path(day, session, raw_dir)
    path.write_text(json.dumps(out, indent=2, default=str))
    log(f"discover wrote {path} seen={out['n_seen']} near={out['n_near']} sports={out['n_sports']} blockers={len(out['blockers'])}", flush=True)
    return out


def ensure(day: str, session: str = "am", client=None, raw_dir: Path | None = None, max_age_hours: float = MAX_AGE_HOURS,
           force: bool = False, now=None, sleep=time.sleep, log=print) -> dict:
    """Return the dated discovery output, regenerating it in-process when missing/stale/empty (or force)."""
    path = output_path(day, session, raw_dir)
    why = "forced" if force else staleness(path, now, max_age_hours)
    if why is None:
        d = load(path)
        log(f"discover reuse {path.name} as_of={d.get('as_of')} seen={d.get('n_seen')}", flush=True)
        return d
    log(f"discover: {path.name} {why}; running discovery", flush=True)
    return discover(day, session, client, raw_dir, now=now, sleep=sleep, log=log)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--date", default=None)
    ap.add_argument("--session", choices=("am", "pm"), default="am")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-age-hours", type=float, default=MAX_AGE_HOURS)
    a = ap.parse_args(argv)
    day = a.date or session_date([])
    out = ensure(day, a.session, max_age_hours=a.max_age_hours, force=a.force)
    print(json.dumps({k: out.get(k) for k in ("as_of", "n_seen", "n_near", "n_longer", "n_sports")}), flush=True)
    if not out.get("n_seen") or not count_sports(out.get("events")):
        print(f"ERROR: discovery found n_seen={out.get('n_seen')} sports={count_sports(out.get('events'))}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
