"""ODDSBORNE discover.py near-window paging pages the whole window (regression for Sun 2026-10-18).

That morning discovery returned only 4 of 13 Sunday NFL games. The gateway ignores date-only
endDateMin/endDateMax (it returns the stale never-closed backlog instead), and the near window was
capped at offsets 0..300, so the games (around offset 1150 of ~3700 in-window events) were never reached.
The mocked gateway below reproduces both: date-only bounds get the backlog, RFC 3339 bounds get the
window, and the games sit far past the old 350-event cap.
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("discover_paging", HERE / "oddsborne" / "discover.py")
DISC = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(DISC)

NOW = datetime(2026, 10, 18, 16, 2, 38, tzinfo=timezone.utc)
MISSED = ["bal-cle", "car-phi", "chi-atl", "no-nyg", "nyj-ne", "pit-tb", "ten-ind", "ari-lar", "buf-lv"]
FOUND = ["hou-jax", "lac-kc", "dal-gb"]


def _ev(slug, end, tags=()):
    return {"slug": slug, "title": slug, "endDate": end, "active": True, "closed": False,
            "tags": [{"slug": t} for t in tags], "markets": [{"slug": f"aec-{slug}"}]}


GAMES = [_ev(f"nfl-{m}-2026-10-18", "2026-10-19T03:59:00Z", ("nfl", "sports")) for m in MISSED + FOUND]
BACKLOG = [_ev(f"stale-{i}", "2025-11-02T23:59:00Z") for i in range(2500)]
WINDOW = ([_ev(f"near-{i}", "2026-10-25T03:59:00Z") for i in range(1150)] + GAMES
          + [_ev(f"near-b-{i}", "2026-11-01T03:59:00Z") for i in range(2549)])


class _NS:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class PagedGateway:
    """Mock of the read-only /v1/events gateway: limit/offset paging, date-only bounds ignored."""
    def __init__(self):
        self.calls = []
        self.search = _NS(query=lambda p: self.calls.append(("search", p)) or {"events": []})
        self.events = _NS(list=self.lst, retrieve_by_slug=lambda s: self.calls.append(("get", s)) or None)

    def lst(self, p):
        self.calls.append(("list", dict(p)))
        lo, hi = p.get("endDateMin"), p.get("endDateMax")
        if lo and "T" not in lo:  # what the live gateway does with YYYY-MM-DD bounds
            rows = BACKLOG
        else:
            rows = [e for e in WINDOW if (not lo or e["endDate"] >= lo) and (not hi or e["endDate"] <= hi)]
        if p.get("tagSlug"):
            rows = [e for e in rows if p["tagSlug"] in {t["slug"] for t in e["tags"]}]
        off, lim = int(p.get("offset") or 0), int(p.get("limit") or 50)
        return {"events": rows[off:off + lim]}


class NearWindowPagingTests(unittest.TestCase):
    def run_sweep(self, gw):
        return DISC.Sweep(gw, now=NOW, sleep=lambda s: None, log=lambda *a, **k: None).run("2026-10-18")

    def test_all_sunday_games_discovered(self):
        gw = PagedGateway()
        out = self.run_sweep(gw)
        for m in MISSED + FOUND:
            self.assertIn(f"nfl-{m}-2026-10-18", out["events"], m)
            self.assertIn(f"nfl-{m}-2026-10-18", out["near_slugs"], m)
        self.assertEqual(out["n_sports"], 12)
        self.assertEqual(out["blockers"], [])
        self.assertFalse(any(s.startswith("stale-") for s in out["events"]))

    def test_window_bounds_are_rfc3339_and_paged_to_the_end(self):
        gw = PagedGateway()
        out = self.run_sweep(gw)
        lists = [p for k, p in gw.calls if k == "list"]
        for p in lists:
            for k in ("endDateMin", "endDateMax"):
                if k in p:
                    self.assertRegex(p[k], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        near = [p["offset"] for p in lists if "offset" in p and not p.get("tagSlug")
                and p.get("endDateMax") == DISC.iso_z(NOW + DISC.timedelta(days=21))]
        self.assertEqual(near[-1], 3700)  # 3711 events -> stops on the short page, well past the old 300 cap
        self.assertEqual(sum(1 for s in out["events"] if s.startswith("near")), 3699)

    def test_sports_tag_fallback_alone_finds_games(self):
        gw = PagedGateway()
        sw = DISC.Sweep(gw, now=NOW, sleep=lambda s: None, log=lambda *a, **k: None)
        sw.page({"active": True, "closed": False, "tagSlug": "nfl", "endDateMin": "2026-10-16T00:00:00Z",
                 "endDateMax": DISC.iso_z(NOW + DISC.timedelta(days=21))}, "sports[nfl]")
        self.assertEqual(sorted(sw.seen), sorted(e["slug"] for e in GAMES))
        self.assertEqual(len(gw.calls), 1)  # a single short page ends paging

    def test_page_stops_when_offset_ignored_and_records_cap(self):
        gw = PagedGateway()
        gw.events.list = lambda p: {"events": WINDOW[:50]}  # server ignoring offset must not loop forever
        sw = DISC.Sweep(gw, now=NOW, sleep=lambda s: None, log=lambda *a, **k: None)
        self.assertEqual(sw.page({}, "x"), 100)
        n = [0]

        def endless(p):
            n[0] += 1
            return {"events": [_ev(f"e-{p['offset'] + i}", "2026-10-20T00:00:00Z") for i in range(50)]}
        gw.events.list = endless
        sw.page({}, "y")
        self.assertEqual(n[0], DISC.MAX_PAGES)
        self.assertTrue(any("MAX_PAGES" in b for b in sw.blockers))


if __name__ == "__main__":
    unittest.main()
