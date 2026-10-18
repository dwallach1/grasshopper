"""ODDSBORNE multi-book line sources (lines.py): parsers on mocked responses, per-book date guard, single-book
fallback, zero-book, staleness, disagreement and weighting. No network: fetch_all gets a fake http getter."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "oddsborne"))
_spec = importlib.util.spec_from_file_location("lines", HERE / "oddsborne" / "lines.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)
MF = L.MF

NOW = datetime(2026, 10, 18, 16, 30, tzinfo=timezone.utc)
TODAY_START = datetime(2026, 10, 18, 21, 0, tzinfo=timezone.utc)      # ALCS today: TB @ CLE
TOMORROW_GST = datetime(2026, 10, 20, 0, 8, tzinfo=timezone.utc)      # venue aec-mlb-cle-tb-2026-10-19


def bovada_coupon(away="Tampa Bay Rays", home="Cleveland Guardians", a="-128", h="+107", start=TODAY_START, live=False):
    return [{"events": [{"description": f"{away} @ {home}", "startTime": int(start.timestamp() * 1000), "live": live,
                         "displayGroups": [{"markets": [
                             {"description": "Moneyline", "period": {"main": True}, "outcomes": [
                                 {"description": away, "price": {"american": a}},
                                 {"description": home, "price": {"american": h}}]},
                             {"description": "Moneyline", "period": {"main": False}, "outcomes": [
                                 {"description": f"{away} - 1H", "price": {"american": "-135"}},
                                 {"description": f"{home} - 1H", "price": {"american": "+105"}}]}]}]}]}]


def pinnacle(away="Tampa Bay Rays", home="Cleveland Guardians", a=-121, h=112, start=TODAY_START, live=False):
    mu = [{"id": 1, "type": "matchup", "units": "Regular", "startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "isLive": live, "status": "pending", "participants": [{"alignment": "home", "name": home},
                                                                 {"alignment": "away", "name": away}]},
          {"id": 2, "type": "special", "units": "Strikeouts", "participants": []}]
    st = [{"matchupId": 1, "type": "moneyline", "period": 0, "isAlternate": False, "status": "open",
           "prices": [{"designation": "home", "price": h}, {"designation": "away", "price": a}]},
          {"matchupId": 1, "type": "moneyline", "period": 1, "prices": [{"designation": "home", "price": 150},
                                                                         {"designation": "away", "price": -170}]}]
    return mu, st


def espn(away="Tampa Bay Rays", home="Cleveland Guardians", a="-132", h="+110", start=TODAY_START, state="pre"):
    return {"events": [{"date": start.strftime("%Y-%m-%dT%H:%MZ"), "status": {"type": {"state": state}},
                        "competitions": [{"competitors": [{"homeAway": "home", "team": {"displayName": home}},
                                                          {"homeAway": "away", "team": {"displayName": away}}],
                                          "odds": [{"provider": {"name": "DraftKings"},
                                                    "moneyline": {"home": {"close": {"odds": h}, "open": {"odds": "+140"}},
                                                                  "away": {"close": {"odds": a}}}}]}]}]}


def game_of(quotes):
    gs = L.group_games(quotes)
    assert len(gs) == 1, gs
    return gs[0]


class ParserTests(unittest.TestCase):
    def test_bovada_main_period_only(self):
        q = L.parse_bovada(bovada_coupon(), "mlb", NOW)
        self.assertEqual(len(q), 1)
        self.assertEqual(q[0]["ml"]["Tampa Bay Rays"]["american"], "-128")
        self.assertEqual(q[0]["start"], TODAY_START)

    def test_pinnacle_full_game_ml(self):
        q = L.parse_pinnacle(*pinnacle(), "mlb", NOW)
        self.assertEqual(len(q), 1)
        self.assertEqual(q[0]["book"], "pinnacle")
        self.assertEqual(q[0]["ml"]["Cleveland Guardians"]["american"], "+112")
        self.assertEqual(q[0]["ml"]["Tampa Bay Rays"]["american"], "-121")

    def test_pinnacle_skips_alternate_and_closed(self):
        mu, st = pinnacle()
        st[0]["isAlternate"] = True
        self.assertEqual(L.parse_pinnacle(mu, st, "mlb", NOW), [])

    def test_espn_draftkings_current_not_open(self):
        q = L.parse_espn(espn(), "mlb", NOW)
        self.assertEqual(q[0]["book"], "draftkings")
        self.assertEqual(q[0]["ml"]["Cleveland Guardians"]["american"], "+110")

    def test_espn_no_odds_no_quote(self):
        sb = espn()
        sb["events"][0]["competitions"][0]["odds"] = []
        self.assertEqual(L.parse_espn(sb, "mlb", NOW), [])

    def test_odds_api_books_and_last_update(self):
        ev = [{"home_team": "Cleveland Guardians", "away_team": "Tampa Bay Rays",
               "commence_time": "2026-10-18T21:00:00Z", "bookmakers": [
                   {"key": "pinnacle", "last_update": "2026-10-18T16:20:00Z", "markets": [{"key": "h2h", "outcomes": [
                       {"name": "Cleveland Guardians", "price": 112}, {"name": "Tampa Bay Rays", "price": -121}]}]}]}]
        q = L.parse_odds_api(ev, "mlb", NOW)
        self.assertEqual(q[0]["book"], "oddsapi:pinnacle")
        self.assertEqual(L.weight(q[0]["book"]), 2.0)
        self.assertEqual(q[0]["as_of"], datetime(2026, 10, 18, 16, 20, tzinfo=timezone.utc))

    def test_bad_prices_never_become_quotes(self):
        self.assertEqual(L._ml([("A", "OFF"), ("B", "-110")]), {})
        self.assertEqual(L._ml([("A", "+50"), ("B", "-110")]), {})
        self.assertEqual(L._ml([("A", "EVEN"), ("B", "-120")])["A"]["american"], "+100")


class FetchAllTests(unittest.TestCase):
    def test_fetch_all_mocked_sources_and_failure(self):
        mu, st = pinnacle()
        responses = {
            "bovada.lv": json.dumps(bovada_coupon()).encode(),
            "/matchups": json.dumps(mu).encode(), "/markets/straight": json.dumps(st).encode(),
            "scoreboard?dates=20261018": json.dumps(espn()).encode(),
        }

        def get(url, headers=None):
            for k, v in responses.items():
                if k in url:
                    return v
            if "scoreboard" in url:
                return b'{"events": []}'
            raise OSError("boom")

        with tempfile.TemporaryDirectory() as d:
            old = os.environ.pop("ODDS_API_KEY", None)
            try:
                blockers = []
                q = L.fetch_all(Path(d), "t", "2026-10-18", blockers, get=get, sleep=lambda s: None, sports=("mlb",),
                                log=lambda *a, **k: None)
            finally:
                if old is not None:
                    os.environ["ODDS_API_KEY"] = old
            self.assertEqual(sorted(x["book"] for x in q), ["bovada", "draftkings", "pinnacle"])
            self.assertEqual(blockers, [])
            g = game_of(q)
            ok, rej = L.eligible_quotes(g, TODAY_START, now=datetime.now(timezone.utc))
            self.assertEqual(len(ok), 3)

    def test_pinnacle_down_keeps_other_books(self):
        def get(url, headers=None):
            if "pinnacle" in url:
                raise OSError("403")
            if "bovada" in url:
                return json.dumps(bovada_coupon()).encode()
            return b'{"events": []}'
        with tempfile.TemporaryDirectory() as d:
            blockers = []
            q = L.fetch_all(Path(d), "t", "2026-10-18", blockers, get=get, sleep=lambda s: None, sports=("mlb",),
                            log=lambda *a, **k: None)
        self.assertEqual([x["book"] for x in q], ["bovada"])
        self.assertTrue(any("pinnacle" in b for b in blockers))


class CombineTests(unittest.TestCase):
    def quotes(self, **kw):
        out = []
        if kw.get("bovada", True):
            out += L.parse_bovada(bovada_coupon(), "mlb", NOW)
        if kw.get("pinnacle", True):
            out += L.parse_pinnacle(*pinnacle(**kw.get("pin", {})), "mlb", NOW)
        if kw.get("espn", True):
            out += L.parse_espn(espn(**kw.get("dk", {})), "mlb", NOW)
        return out

    def test_single_book_fallback_matches_old_bovada_number(self):
        q = self.quotes(pinnacle=False, espn=False)
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        combo = L.combine(g, ok)
        self.assertEqual(combo["books"], ["bovada"])
        dm = MF.devig_methods(q[0]["ml"])["Tampa Bay Rays"]
        for side in ("yes", "no"):
            old = MF.conservative_fair(side, dm["power"], dm["shin"], dm["prop"])
            new = L.side_fair(combo, "Tampa Bay Rays", side)
            self.assertEqual(new["used"], old["used"])
            self.assertEqual(new["method"], old["method"])
            self.assertFalse(new["disagreement"])

    def test_pinnacle_only_prices_a_game_bovada_lacks(self):
        q = self.quotes(bovada=False, espn=False)
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        f = L.side_fair(L.combine(g, ok), "Cleveland Guardians", "yes")
        self.assertEqual(f["books"], ["pinnacle"])
        self.assertTrue(0.4 < f["used"] < 0.5)

    def test_zero_books_no_fair(self):
        self.assertEqual(L.group_games([]), [])
        g = game_of(self.quotes(pinnacle=False, espn=False))
        self.assertIsNone(L.combine(g, []))
        self.assertIsNone(L.side_fair(None, "Tampa Bay Rays", "yes"))

    def test_weighted_mean_pinnacle_double(self):
        q = self.quotes()
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        combo = L.combine(g, ok)
        self.assertEqual(combo["books"], ["bovada", "draftkings", "pinnacle"])
        self.assertEqual(combo["weights"], {"bovada": 1.0, "draftkings": 1.0, "pinnacle": 2.0})
        t = "Tampa Bay Rays"
        pb = {b: v["dm"][t]["power"] for b, v in combo["per_book"].items()}
        want = (pb["bovada"] + pb["draftkings"] + 2 * pb["pinnacle"]) / 4
        self.assertAlmostEqual(combo["combined"][t]["power"], want, places=5)
        self.assertFalse(combo["disagreement"])
        f = L.side_fair(combo, t, "yes")
        self.assertEqual(set(f["per_book_used"]), {"bovada", "draftkings", "pinnacle"})

    def test_disagreement_uses_most_conservative_book_each_side(self):
        q = self.quotes(pin={"a": -180, "h": 160})  # Pinnacle has TB ~62% vs Bovada/DK ~54%
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        combo = L.combine(g, ok)
        self.assertTrue(combo["disagreement"])
        self.assertGreater(combo["disagree_pp"], L.DISAGREE_PP)
        yes = L.side_fair(combo, "Tampa Bay Rays", "yes")
        no = L.side_fair(combo, "Tampa Bay Rays", "no")
        self.assertEqual(yes["used"], min(yes["per_book_used"].values()))
        self.assertEqual(no["used"], min(no["per_book_used"].values()))
        self.assertTrue(yes["method"].startswith("most_conservative_book:"))
        self.assertNotEqual(yes["method"], "most_conservative_book:pinnacle")  # the low-TB books
        self.assertEqual(no["method"], "most_conservative_book:pinnacle")
        self.assertLessEqual(yes["used"], yes["weighted_used"])
        self.assertLessEqual(no["used"], no["weighted_used"])

    def test_small_difference_is_not_disagreement(self):
        g = game_of(self.quotes())
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        self.assertLessEqual(L.combine(g, ok)["disagree_pp"], L.DISAGREE_PP)


class DateGuardTests(unittest.TestCase):
    def test_today_tb_at_cle_rejected_for_cle_tb_1019(self):
        """10-18 incident: Bovada's TB@CLE today must not price the CLE-TB 10-19 venue market."""
        q = (L.parse_bovada(bovada_coupon(), "mlb", NOW) + L.parse_pinnacle(*pinnacle(), "mlb", NOW)
             + L.parse_espn(espn(), "mlb", NOW))
        g = game_of(q)
        ok, rej = L.eligible_quotes(g, TOMORROW_GST, now=NOW)
        self.assertEqual(ok, [])
        self.assertEqual({r["reason"] for r in rej}, {"date_mismatch"})
        self.assertEqual({r["book"] for r in rej}, {"bovada", "pinnacle", "draftkings"})

    def test_only_the_book_with_tomorrows_line_counts(self):
        tom = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)
        q = (L.parse_bovada(bovada_coupon(), "mlb", NOW)
             + L.parse_espn(espn(away="Cleveland Guardians", home="Tampa Bay Rays", a="+105", h="-125", start=tom), "mlb", NOW))
        g = game_of(q)  # same two teams -> one group with two different starts
        ok, rej = L.eligible_quotes(g, TOMORROW_GST, now=NOW)
        self.assertEqual([x["book"] for x in ok], ["draftkings"])
        self.assertEqual([(r["book"], r["reason"]) for r in rej], [("bovada", "date_mismatch")])
        f = L.side_fair(L.combine(g, ok), "Cleveland Guardians", "yes")
        self.assertEqual(f["books"], ["draftkings"])

    def test_missing_start_rejected(self):
        q = L.parse_bovada(bovada_coupon(), "mlb", NOW)
        q[0]["start"] = None
        ok, rej = L.eligible_quotes(game_of(q), TODAY_START, now=NOW)
        self.assertEqual(ok, [])
        self.assertEqual(rej[0]["reason"], "date_mismatch")

    def test_stale_quote_dropped_and_flagged(self):
        q = (L.parse_bovada(bovada_coupon(), "mlb", NOW - timedelta(minutes=90))
             + L.parse_pinnacle(*pinnacle(), "mlb", NOW))
        ok, rej = L.eligible_quotes(game_of(q), TODAY_START, now=NOW, max_age_min=30)
        self.assertEqual([x["book"] for x in ok], ["pinnacle"])
        self.assertEqual(rej[0]["reason"], "stale")
        self.assertEqual(rej[0]["age_min"], 90.0)

    def test_all_stale_means_no_fair(self):
        q = L.parse_bovada(bovada_coupon(), "mlb", NOW - timedelta(hours=3))
        ok, _ = L.eligible_quotes(game_of(q), TODAY_START, now=NOW)
        self.assertEqual(ok, [])

    def test_live_quote_dropped(self):
        q = L.parse_pinnacle(*pinnacle(live=True), "mlb", NOW) + L.parse_bovada(bovada_coupon(), "mlb", NOW)
        ok, rej = L.eligible_quotes(game_of(q), TODAY_START, now=NOW)
        self.assertEqual([x["book"] for x in ok], ["bovada"])
        self.assertEqual(rej[0]["reason"], "live")

    def test_same_book_twice_deduped(self):
        ev = [{"home_team": "Cleveland Guardians", "away_team": "Tampa Bay Rays", "commence_time": "2026-10-18T21:00:00Z",
               "bookmakers": [{"key": "pinnacle", "last_update": "2026-10-18T16:25:00Z", "markets": [{"key": "h2h", "outcomes": [
                   {"name": "Cleveland Guardians", "price": 112}, {"name": "Tampa Bay Rays", "price": -121}]}]}]}]
        q = L.parse_pinnacle(*pinnacle(), "mlb", NOW) + L.parse_odds_api(ev, "mlb", NOW)
        ok, rej = L.eligible_quotes(game_of(q), TODAY_START, now=NOW)
        self.assertEqual([x["book"] for x in ok], ["pinnacle"])
        self.assertEqual(rej[0]["reason"], "duplicate")


class SessionWiringTests(unittest.TestCase):
    """Static: both sessions route every book through the per-book date guard before combining."""

    def test_sessions_use_guard_then_combine(self):
        for fn in ("session_daily.py", "session_pm.py"):
            src = (HERE / "oddsborne" / fn).read_text()
            self.assertIn("import lines as LINES", src)
            self.assertIn("LINES.fetch_all(", src)
            g, c = src.index("LINES.eligible_quotes(g, gst)"), src.index("LINES.combine(g, elig)")
            self.assertLess(g, c, fn)
            self.assertIn('"books": combo["books"]', src)
            self.assertIn("if not elig:", src)
            self.assertNotIn("aft.devig(g[\"ml\"])", src)  # no single-book fair path left in the scorer

    def test_lines_synced_to_box(self):
        self.assertIn("oddsborne/lines.py:$box/oddsborne/deepdive_raw/lines.py", (HERE / "sync_box.sh").read_text())


if __name__ == "__main__":
    unittest.main()
