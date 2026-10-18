#!/usr/bin/env python3
"""ODDSBORNE sports line sources + multi-book fair value (read-only; no orders, no ledger).

Why: Bovada was the only line source, so a game was unscoreable until Bovada hung a line. This module adds
more books and combines them. Every source is a public read; a source that fails or has no line for a game
simply contributes nothing (never a fabricated price).

Sources (book name -> how it is fetched):
  bovada       Bovada coupon JSON (public; unchanged URLs).
  pinnacle     Pinnacle guest "arcadia" JSON (public, no key, no sign-in):
               guest.api.arcadia.pinnacle.com/0.1/leagues/<id>/matchups + /markets/straight.
  draftkings   DraftKings moneylines as republished on ESPN's public scoreboard JSON (no key):
               site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard?dates=YYYYMMDD (one call per day).
               The ESPN provider name becomes the book name (normally "draftkings").
  oddsapi:*    Optional: The Odds API v4 (needs ODDS_API_KEY; skipped when unset). Each bookmaker it returns is
               its own book (pinnacle, draftkings, fanduel, ...), deduped against the direct feeds above.

Fair value (per market, after the per-book date guard):
  1. De-vig each book separately with maker_fee.devig_methods (prop / power / Shin).
  2. Drop stale quotes (fetched more than ODDS_LINE_MAX_AGE_MIN minutes ago, default 30) and live quotes.
  3. Weighted mean of each method across the remaining books (BOOK_WEIGHTS: pinnacle 2.0, every other book 1.0),
     then the existing conservative rule (min of prop/power/Shin for the side bought).
  4. Disagreement: if the books' proportional fairs for the same team differ by more than DISAGREE_PP (0.03),
     log it and use the MOST conservative book for the side bought (the min of each book's conservative fair).
  5. One book -> that book alone (identical to the old Bovada-only number). Zero books -> no fair, no score.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:  # box: /workspace/oddsborne/maker_fee.py; repo/tests: sibling file
    import maker_fee as MF
except ImportError:  # pragma: no cover
    import importlib.util as _ilu
    _s = _ilu.spec_from_file_location("maker_fee", Path(__file__).resolve().parent / "maker_fee.py")
    MF = _ilu.module_from_spec(_s)
    _s.loader.exec_module(MF)

# Sharp book weighted double: Pinnacle is the low-margin, high-limit market maker whose closing line is the
# usual "true price" benchmark; Bovada / DraftKings / other retail books shade lines and carry more vig.
BOOK_WEIGHTS = {"pinnacle": 2.0}
DEFAULT_WEIGHT = 1.0
DISAGREE_PP = 0.03            # books' proportional fairs differ by > 3pp -> use the most conservative book
DATE_TOL_S = 3 * 3600         # 10-05 lesson: a book's start must be within 3h of the venue gameStartTime
MAX_AGE_MIN = float(os.environ.get("ODDS_LINE_MAX_AGE_MIN") or 30)
BOOK_ORDER = ("bovada", "pinnacle", "draftkings")  # canonical team names come from the first book listed

PINNACLE_LEAGUES = {"mlb": 246, "nfl": 889}
PINNACLE_BASE = "https://guest.api.arcadia.pinnacle.com/0.1"
ESPN_PATHS = {"mlb": "baseball/mlb", "nfl": "football/nfl"}
ESPN_DAYS = int(os.environ.get("ODDS_ESPN_DAYS") or 8)
ODDS_API_SPORTS = {"mlb": "baseball_mlb", "nfl": "americanfootball_nfl"}
BOVADA_URLS = {
    "mlb": "https://www.bovada.lv/services/sports/event/v2/events/A/description/baseball?marketFilterId=def&preMatchOnly=true&lang=en",
    "nfl": "https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl?marketFilterId=def&preMatchOnly=true&lang=en",
}
STOP = ("city", "york", "los", "angeles", "san", "bay", "new")


def weight(book: str) -> float:
    b = (book or "").lower().split(":")[-1]
    return BOOK_WEIGHTS.get(b, DEFAULT_WEIGHT)


def book_key(book: str) -> str:
    """Dedup identity: 'oddsapi:pinnacle' and 'pinnacle' are the same book."""
    return (book or "").lower().split(":")[-1]


def team_token(name: str) -> str:
    """Same token rule the session matcher has always used (last word > 3 chars, minus city words)."""
    toks = [t for t in (name or "").lower().replace(".", "").split() if len(t) > 3 and t not in STOP]
    return toks[-1] if toks else ((name or "").lower().split() or [""])[-1]


def _american(x):
    s = str(x).strip().upper().replace("\u2212", "-")
    if s in ("EVEN", "EV", "PK"):
        return "+100"
    try:
        v = float(s.replace("+", ""))
    except Exception:
        return None
    if v == 0 or -100 < v < 100:
        return None
    return f"+{int(v)}" if v > 0 else str(int(v))


def _ml(pairs):
    """[(team, american)] -> {team: {american, p}} or {} unless exactly two clean prices."""
    out = {}
    for name, am in pairs:
        a = _american(am)
        p = MF.am_to_implied(a) if a else None
        if name and p is not None and 0 < p < 1:
            out[name] = {"american": a, "p": round(p, 6)}
    return out if len(out) == 2 else {}


def _pdt(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return datetime.fromtimestamp(x / 1000, tz=timezone.utc)
    try:
        d = datetime.fromisoformat(str(x).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _quote(book, sport, desc, ml, start, live, fetched_at, as_of=None):
    return {"book": book, "sport": sport, "desc": desc, "ml": ml, "start": start, "live": bool(live),
            "fetched_at": fetched_at, "as_of": as_of or fetched_at}


# ----------------------------------------------------------------------------- parsers (pure)
def parse_bovada(raw, sport, fetched_at):
    """Bovada coupon -> quotes (main-period two-way Moneyline; same rules as session parse_bovada_ts)."""
    out = []
    for block in (raw if isinstance(raw, list) else [raw]):
        if not isinstance(block, dict):
            continue
        for ev in block.get("events") or []:
            pairs = None
            for dg in ev.get("displayGroups") or []:
                for m in dg.get("markets") or []:
                    if (m.get("description") or "").strip().lower() != "moneyline":
                        continue
                    per = m.get("period") or {}
                    if per and not per.get("main", True):
                        continue
                    pp = []
                    for o in m.get("outcomes") or []:
                        name = o.get("description") or ""
                        if " - " in name:
                            continue
                        pr = o.get("price")
                        am = pr.get("american") if isinstance(pr, dict) else None
                        if name and am is not None:
                            pp.append((name, am))
                    if len(pp) == 2:
                        pairs = pp
                        break
                if pairs:
                    break
            ml = _ml(pairs or [])
            if ml:
                out.append(_quote("bovada", sport, ev.get("description") or "", ml, _pdt(ev.get("startTime")),
                                  ev.get("live"), fetched_at))
    return out


def parse_pinnacle(matchups, straight, sport, fetched_at):
    """Pinnacle guest matchups + straight markets -> full-game moneyline quotes (no alternates, no specials)."""
    games = {}
    for x in matchups or []:
        if not isinstance(x, dict) or x.get("type") != "matchup" or x.get("units") != "Regular" or x.get("special"):
            continue
        sides = {p.get("alignment"): p.get("name") for p in x.get("participants") or []}
        if sides.get("home") and sides.get("away"):
            games[x.get("id")] = (x, sides)
    out = []
    for mk in straight or []:
        if not isinstance(mk, dict) or mk.get("type") != "moneyline" or mk.get("period") != 0:
            continue
        if mk.get("isAlternate") or (mk.get("status") not in (None, "open")) or mk.get("matchupId") not in games:
            continue
        x, sides = games[mk["matchupId"]]
        pairs = [(sides.get(p.get("designation")), p.get("price")) for p in mk.get("prices") or []]
        ml = _ml(pairs)
        if ml:
            out.append(_quote("pinnacle", sport, f"{sides['away']} @ {sides['home']}", ml, _pdt(x.get("startTime")),
                              x.get("isLive") or x.get("status") == "started", fetched_at))
    return out


def parse_espn(scoreboard, sport, fetched_at):
    """ESPN scoreboard -> one quote per odds provider (normally DraftKings) with a current two-way moneyline."""
    out = []
    for e in (scoreboard or {}).get("events") or []:
        comp = (e.get("competitions") or [{}])[0]
        teams = {c.get("homeAway"): ((c.get("team") or {}).get("displayName")) for c in comp.get("competitors") or []}
        if not (teams.get("home") and teams.get("away")):
            continue
        state = ((e.get("status") or {}).get("type") or {}).get("state")
        for o in comp.get("odds") or []:
            book = ((o.get("provider") or {}).get("name") or "espn").lower().replace(" ", "")
            mlo = o.get("moneyline") or {}
            def cur(side):
                s = mlo.get(side) or {}
                v = (s.get("close") or {}).get("odds") or (s.get("current") or {}).get("odds")
                if v is None:
                    v = (o.get(f"{side}TeamOdds") or {}).get("moneyLine")
                return v
            ml = _ml([(teams["home"], cur("home")), (teams["away"], cur("away"))])
            if ml:
                out.append(_quote(book, sport, f"{teams['away']} @ {teams['home']}", ml, _pdt(e.get("date")),
                                  state not in (None, "pre"), fetched_at))
    return out


def parse_odds_api(events, sport, fetched_at):
    """The Odds API v4 /odds (markets=h2h, oddsFormat=american) -> one quote per bookmaker, as_of = last_update."""
    out = []
    for e in events or []:
        home, away = e.get("home_team"), e.get("away_team")
        for bm in e.get("bookmakers") or []:
            for m in bm.get("markets") or []:
                if m.get("key") != "h2h":
                    continue
                ml = _ml([(o.get("name"), o.get("price")) for o in m.get("outcomes") or []])
                if ml and home in ml and away in ml:
                    out.append(_quote(f"oddsapi:{bm.get('key')}", sport, f"{away} @ {home}", ml,
                                      _pdt(e.get("commence_time")), False, fetched_at,
                                      as_of=_pdt(m.get("last_update") or bm.get("last_update")) or fetched_at))
    return out


# ----------------------------------------------------------------------------- fetch (network)
UA = "Mozilla/5.0 (compatible; oddsborne/1.0)"


def http_get(url, timeout=30, headers=None):
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return r.read()


def _save(path: Path, raw: bytes):
    path.write_bytes(raw)
    return path


def _mtime(path: Path):
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)


def fetch_all(out_dir: Path, session: str, today: str, blockers: list, get=http_get, sleep=time.sleep,
              sports=("mlb", "nfl"), log=print):
    """Fetch every source, save raw JSON to out_dir/session_raw_<session>_<book>_<sport>*.json, return quotes.
    A failed fetch keeps the previous file if any (its mtime then marks the quotes stale) and logs a blocker."""
    out_dir = Path(out_dir)
    quotes = []

    def grab(path, url, headers=None, empty_retry=None):
        try:
            raw = get(url, headers=headers) if headers else get(url)
            if empty_retry and raw.strip() in (b"", b"{}"):
                raw = get(empty_retry)
            _save(path, raw)
        except Exception as e:
            blockers.append(f"{path.stem.split('_', 3)[-1]}: {type(e).__name__}: {str(e)[:120]}")
            log("line_fetch_err", path.name, type(e).__name__, str(e)[:120], flush=True)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text() or "null")
        except Exception:
            return None

    for sport in sports:
        p = out_dir / f"session_raw_{session}_bovada_{sport}.json"
        raw = grab(p, BOVADA_URLS[sport], empty_retry=BOVADA_URLS[sport].split("?")[0] + "?lang=en")
        if raw is not None:
            quotes += parse_bovada(raw, sport, _mtime(p))
        if sport in PINNACLE_LEAGUES:
            lg = PINNACLE_LEAGUES[sport]
            pm = out_dir / f"session_raw_{session}_pinnacle_{sport}_matchups.json"
            ps = out_dir / f"session_raw_{session}_pinnacle_{sport}_straight.json"
            mu = grab(pm, f"{PINNACLE_BASE}/leagues/{lg}/matchups")
            sleep(0.3)
            st = grab(ps, f"{PINNACLE_BASE}/leagues/{lg}/markets/straight")
            if mu is not None and st is not None:
                quotes += parse_pinnacle(mu, st, sport, min(_mtime(pm), _mtime(ps)))
        d0 = datetime.fromisoformat(today).date()
        for i in range(ESPN_DAYS):
            day = (d0 + timedelta(days=i)).strftime("%Y%m%d")
            pe = out_dir / f"session_raw_{session}_espn_{sport}_{day}.json"
            sb = grab(pe, f"https://site.api.espn.com/apis/site/v2/sports/{ESPN_PATHS[sport]}/scoreboard?dates={day}")
            if sb is not None:
                quotes += parse_espn(sb, sport, _mtime(pe))
            sleep(0.2)
        key = os.environ.get("ODDS_API_KEY")
        if key:
            po = out_dir / f"session_raw_{session}_oddsapi_{sport}.json"
            url = (f"https://api.the-odds-api.com/v4/sports/{ODDS_API_SPORTS[sport]}/odds?apiKey={key}"
                   f"&regions=us,eu&markets=h2h&oddsFormat=american")
            ev = grab(po, url)
            if isinstance(ev, list):
                quotes += parse_odds_api(ev, sport, _mtime(po))
    by_book = {}
    for q in quotes:
        by_book.setdefault(q["book"], 0)
        by_book[q["book"]] += 1
    log("line_quotes_by_book", json.dumps(by_book, sort_keys=True), flush=True)
    return quotes


# ----------------------------------------------------------------------------- grouping + date guard
def group_games(quotes):
    """Cluster quotes by (sport, team tokens). Start times are NOT merged here: the per-market date guard
    (eligible_quotes) decides which quotes describe the venue's game."""
    rank = {b: i for i, b in enumerate(BOOK_ORDER)}
    games = {}
    for q in sorted(quotes, key=lambda q: rank.get(book_key(q["book"]), 99)):
        toks = tuple(sorted(team_token(n) for n in q["ml"]))
        if len(set(toks)) != 2:
            continue
        g = games.setdefault((q["sport"], toks), {"sport": q["sport"], "tokens": list(toks), "quotes": [],
                                                    "names": {}})
        for n in q["ml"]:
            g["names"].setdefault(team_token(n), n)  # canonical name = first (Bovada-first) book's spelling
        g["quotes"].append(q)
    return list(games.values())


def eligible_quotes(game, gst, now=None, max_age_min=None):
    """Per-book date guard for one venue market. Returns (eligible, rejected) where rejected rows carry a reason:
    date_mismatch (start not within 3h of gameStartTime, e.g. today's TB@CLE vs the CLE-TB 10-19 market),
    live, stale (older than max age), duplicate (second quote from the same book)."""
    now = now or datetime.now(timezone.utc)
    max_age = timedelta(minutes=MAX_AGE_MIN if max_age_min is None else max_age_min)
    ok, rej, seen = [], [], set()
    for q in game["quotes"]:
        st = q.get("start")
        base = {"book": q["book"], "desc": q.get("desc"), "start": st.isoformat() if st else None}
        if gst is None or st is None or abs((gst - st).total_seconds()) > DATE_TOL_S:
            rej.append({**base, "reason": "date_mismatch"})
            continue
        if q.get("live"):
            rej.append({**base, "reason": "live"})
            continue
        age = now - (q.get("as_of") or q.get("fetched_at") or now)
        if age > max_age:
            rej.append({**base, "reason": "stale", "age_min": round(age.total_seconds() / 60, 1)})
            continue
        bk = book_key(q["book"])
        if bk in seen:
            rej.append({**base, "reason": "duplicate"})
            continue
        seen.add(bk)
        ok.append(q)
    return ok, rej


# ----------------------------------------------------------------------------- combine
def combine(game, quotes):
    """De-vig each book, then weight. Returns combo (teams keyed by canonical name) or None with zero books."""
    per_book = {}
    for q in quotes:
        dm = MF.devig_methods(q["ml"])
        if not dm:
            continue
        canon = {}
        for n, v in dm.items():
            canon[game["names"].get(team_token(n), n)] = v
        if len(canon) == 2:
            per_book[q["book"]] = {"dm": canon, "q": q}
    if not per_book:
        return None
    teams = list(next(iter(per_book.values()))["dm"].keys())
    per_book = {b: v for b, v in per_book.items() if set(v["dm"]) == set(teams)}
    wsum = sum(weight(b) for b in per_book)
    combined = {}
    for t in teams:
        combined[t] = {m: round(sum(weight(b) * v["dm"][t][m] for b, v in per_book.items()) / wsum, 6)
                       for m in ("prop", "power", "shin")}
    props = [v["dm"][teams[0]]["prop"] for v in per_book.values()]
    spread = round(max(props) - min(props), 6)
    return {"teams": teams, "combined": combined, "per_book": per_book, "books": sorted(per_book),
            "weights": {b: weight(b) for b in sorted(per_book)}, "disagree_pp": spread,
            "disagreement": len(per_book) > 1 and spread > DISAGREE_PP}


def fair_map(combo):
    """{team: proportional fair} for match_fair_to_market (combined across books)."""
    return {t: round(v["prop"], 4) for t, v in (combo or {}).get("combined", {}).items()}


def side_fair(combo, team, side):
    """Conservative fair for buying `side` of the market whose YES team is `team`. Same shape as
    maker_fee.conservative_fair plus books/weights/disagreement. None if team unknown or no books."""
    if not combo or team not in combo["combined"]:
        return None
    c = combo["combined"][team]
    out = MF.conservative_fair(side, c["power"], c["shin"], c["prop"])
    per = {}
    for b, v in combo["per_book"].items():
        d = v["dm"][team]
        per[b] = MF.conservative_fair(side, d["power"], d["shin"], d["prop"])["used"]
    out.update({"books": combo["books"], "weights": combo["weights"], "per_book_used": per,
                "disagree_pp": combo["disagree_pp"], "disagreement": combo["disagreement"]})
    if combo["disagreement"]:
        b, used = min(per.items(), key=lambda kv: kv[1])
        out["weighted_used"] = out["used"]
        out["used"] = round(used, 6)
        out["method"] = f"most_conservative_book:{b}"
    return out


def book_meta(combo):
    """Per-book audit trail for comps rows: american prices, start, fetch time, de-vig."""
    rows = {}
    for b, v in (combo or {}).get("per_book", {}).items():
        q = v["q"]
        rows[b] = {"desc": q.get("desc"), "americans": {k: x["american"] for k, x in q["ml"].items()},
                   "start": q["start"].isoformat() if q.get("start") else None,
                   "as_of": q["as_of"].isoformat() if q.get("as_of") else None,
                   "weight": weight(b), "devig": v["dm"]}
    return rows
