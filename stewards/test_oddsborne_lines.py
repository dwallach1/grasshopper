"""ODDSBORNE multi-book line sources (lines.py) + GRASSHOPPER 10-18 rulings (opt-in sources, single_book policy, passlog): parsers on mocked responses, per-book date guard, single-book
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


ENV_KEYS = ("ODDS_API_KEY", "ODDS_ENABLE_PINNACLE", "ODDS_ENABLE_ESPN")


class EnvPatch:
    """Set exactly these source env vars (others in ENV_KEYS cleared) for the block."""
    def __init__(self, **kw):
        self.kw = kw

    def __enter__(self):
        self.old = {k: os.environ.pop(k, None) for k in ENV_KEYS}
        os.environ.update(self.kw)
        return self

    def __exit__(self, *a):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
            if self.old.get(k) is not None:
                os.environ[k] = self.old[k]


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

    def test_implied_p_rounded_like_old_bovada_parser(self):
        """aft.am_to_p rounds to 4dp; matching it keeps Bovada-only fairs bit-identical to the old scorer."""
        ml = L.parse_bovada(bovada_coupon(a="-128", h="+107"), "mlb", NOW)[0]["ml"]
        self.assertEqual(ml["Tampa Bay Rays"]["p"], round(128 / 228, 4))
        self.assertEqual(ml["Cleveland Guardians"]["p"], round(100 / 207, 4))

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

        with tempfile.TemporaryDirectory() as d, EnvPatch(ODDS_ENABLE_PINNACLE="1", ODDS_ENABLE_ESPN="1"):
            blockers = []
            q = L.fetch_all(Path(d), "t", "2026-10-18", blockers, get=get, sleep=lambda s: None, sports=("mlb",),
                            log=lambda *a, **k: None)
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
        with tempfile.TemporaryDirectory() as d, EnvPatch(ODDS_ENABLE_PINNACLE="1"):
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


_pe_spec = importlib.util.spec_from_file_location("pm_enter_t", HERE / "oddsborne" / "pm_enter.py")
PE = importlib.util.module_from_spec(_pe_spec)
_pe_spec.loader.exec_module(PE)


def _recording_get(responses):
    calls = []

    def get(url, headers=None):
        calls.append(url)
        for k, v in responses.items():
            if k in url:
                return v
        return b'{"events": []}' if "scoreboard" in url else b"[]"
    return get, calls


class SourceFlagTests(unittest.TestCase):
    """GRASSHOPPER 10-18: Pinnacle/ESPN opt-in; The Odds API on with a key; default = Bovada only."""

    def run_fetch(self, **env):
        mu, st = pinnacle()
        ev = [{"home_team": "Cleveland Guardians", "away_team": "Tampa Bay Rays",
               "commence_time": "2026-10-18T21:00:00Z", "bookmakers": [
                   {"key": "fanduel", "markets": [{"key": "h2h", "last_update": datetime.now(timezone.utc).isoformat(),
                                                   "outcomes": [{"name": "Cleveland Guardians", "price": 108},
                                                                {"name": "Tampa Bay Rays", "price": -126}]}]}]}]
        get, calls = _recording_get({"bovada.lv": json.dumps(bovada_coupon()).encode(),
                                     "/matchups": json.dumps(mu).encode(),
                                     "/markets/straight": json.dumps(st).encode(),
                                     "scoreboard?dates=20261018": json.dumps(espn()).encode(),
                                     "the-odds-api.com": json.dumps(ev).encode()})
        with tempfile.TemporaryDirectory() as d, EnvPatch(**env):
            q = L.fetch_all(Path(d), "t", "2026-10-18", [], get=get, sleep=lambda s: None, sports=("mlb",),
                            log=lambda *a, **k: None)
        return q, calls

    def test_default_is_bovada_only(self):
        q, calls = self.run_fetch()
        self.assertTrue(calls and all("bovada.lv" in u for u in calls), calls)
        self.assertEqual({x["book"] for x in q}, {"bovada"})
        self.assertEqual(L.enabled_sources({}), {"bovada": True, "oddsapi": False, "pinnacle": False, "espn": False})

    def test_default_fair_equals_old_bovada_fair(self):
        q, _ = self.run_fetch()
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=datetime.now(timezone.utc))
        combo = L.combine(g, ok)
        dm = MF.devig_methods(q[0]["ml"])["Cleveland Guardians"]
        for side in ("yes", "no"):
            self.assertEqual(L.side_fair(combo, "Cleveland Guardians", side)["used"],
                             MF.conservative_fair(side, dm["power"], dm["shin"], dm["prop"])["used"])

    def test_key_turns_on_odds_api(self):
        q, calls = self.run_fetch(ODDS_API_KEY="k123")
        self.assertTrue(any("the-odds-api.com" in u and "apiKey=k123" in u for u in calls))
        self.assertFalse(any("pinnacle" in u or "espn" in u for u in calls))
        self.assertEqual({x["book"] for x in q}, {"bovada", "oddsapi:fanduel"})

    def test_blank_key_stays_off(self):
        _, calls = self.run_fetch(ODDS_API_KEY="  ")
        self.assertFalse(any("the-odds-api.com" in u for u in calls))

    def test_flags_enable_pinnacle_and_espn_separately(self):
        q, calls = self.run_fetch(ODDS_ENABLE_PINNACLE="1")
        self.assertEqual({x["book"] for x in q}, {"bovada", "pinnacle"})
        self.assertFalse(any("espn" in u for u in calls))
        q, calls = self.run_fetch(ODDS_ENABLE_ESPN="1")
        self.assertEqual({x["book"] for x in q}, {"bovada", "draftkings"})
        self.assertFalse(any("pinnacle" in u for u in calls))
        q, _ = self.run_fetch(ODDS_ENABLE_PINNACLE="0", ODDS_ENABLE_ESPN="true")  # only "1" enables
        self.assertEqual({x["book"] for x in q}, {"bovada"})


class SingleBookPolicyTests(unittest.TestCase):
    """GRASSHOPPER 10-18: one book -> 2c gate bar and half guidance size (floored; 0 -> pass)."""

    def test_single_book_1_5c_is_a_pass(self):
        pol = L.entry_policy(["pinnacle"], 0.015, 0.01)
        self.assertEqual(pol["book_tag"], "single_book")
        self.assertEqual(pol["gate_bar"], 0.02)
        self.assertFalse(pol["clears"])

    def test_single_book_2_1c_enters_at_half_size(self):
        pol = L.entry_policy(["draftkings"], 0.021, 0.01)
        self.assertTrue(pol["clears"])
        self.assertEqual(pol["size_mult"], 0.5)
        full = PE.compute_quantity(5.0, 100.0, 0.30)  # guidance $5 @ 0.30 -> 16
        half = PE.scale_quantity(full, pol["size_mult"], 0.30)
        self.assertEqual(full["quantity"], 16)
        self.assertEqual(half["quantity"], 8)
        self.assertEqual(half["quantity_full_guidance"], 16)
        PE.check_quantity(half)  # does not refuse

    def test_half_size_rounds_down(self):
        full = PE.compute_quantity(5.0, 100.0, 0.29)  # 17 contracts
        self.assertEqual(PE.scale_quantity(full, 0.5, 0.29)["quantity"], 8)

    def test_half_size_zero_is_a_pass(self):
        full = PE.compute_quantity(0.5, 100.0, 0.40)  # 1 contract
        half = PE.scale_quantity(full, 0.5, 0.40)
        self.assertEqual(half["quantity"], 0)
        with self.assertRaises(PE.Refusal) as cm:
            PE.check_quantity(half)
        self.assertEqual(cm.exception.gate, "sizing")
        self.assertIn("size_mult", cm.exception.reason)

    def test_multi_book_normal_bar_full_size(self):
        pol = L.entry_policy(["bovada", "pinnacle"], 0.011, 0.01)
        self.assertEqual((pol["book_tag"], pol["gate_bar"], pol["size_mult"], pol["clears"]), ("multi_book", 0.01, 1.0, True))
        full = PE.compute_quantity(5.0, 100.0, 0.30)
        self.assertIs(PE.scale_quantity(full, pol["size_mult"], 0.30), full)

    def test_same_book_twice_is_still_single(self):
        self.assertEqual(L.entry_policy(["pinnacle", "oddsapi:pinnacle"], 0.03, 0.01)["book_tag"], "single_book")

    def test_zero_books_never_clear(self):
        self.assertFalse(L.entry_policy([], 0.5, 0.01)["clears"])

    def test_size_mult_bounds(self):
        full = PE.compute_quantity(5.0, 100.0, 0.30)
        for bad in (0, 1.5, -1):
            with self.assertRaises(PE.Refusal):
                PE.scale_quantity(full, bad, 0.30)

    def test_thresholds_are_env_configurable(self):
        src = (HERE / "oddsborne" / "lines.py").read_text()
        self.assertIn('os.environ.get("SINGLE_BOOK_MIN_EDGE_C") or 2.0', src)
        self.assertIn('os.environ.get("SINGLE_BOOK_SIZE_MULT") or 0.5', src)
        self.assertTrue(L.entry_policy(["pinnacle"], 0.015, 0.01, single_min_edge_c=1.0, single_size_mult=1.0)["clears"])

    def test_sessions_apply_policy_and_tag(self):
        for fn in ("session_daily.py", "session_pm.py"):
            src = (HERE / "oddsborne" / fn).read_text()
            self.assertIn('LINES.entry_policy(combo["books"], em, MIN_EDGE)', src)
            self.assertIn('elif pol["clears"]:', src)
            self.assertNotIn("elif em is not None and em >= MIN_EDGE:\n                            decision = \"CANDIDATE\"", src)
            self.assertIn('"--size-mult", f"{size_mult:g}", "--tag", tag', src)
            self.assertIn("[{tag}; gate bar", src)  # fair-source text carries the tag
            self.assertIn('"book_tag": pol["book_tag"]', src)
            self.assertIn("single_book_size_zero", src)

    def test_pm_enter_cli_and_gate_results(self):
        src = (HERE / "oddsborne" / "pm_enter.py").read_text()
        self.assertIn('"--size-mult"', src)
        self.assertIn('"--tag"', src)
        self.assertIn('"tags": list(tags or []), "size_mult": size_mult}', src)  # gate_results metadata


class BovadaOnlyRulingTests(unittest.TestCase):
    """GRASSHOPPER 10-18 ruling (a), permanent: Bovada alone keeps today's rules (1c bar, full size), tag bovada_only;
    the single_book limits apply only to a NEW single book."""

    def test_bovada_only_1_2c_enters_full_size_untagged_single(self):
        pol = L.entry_policy(["bovada"], 0.012, 0.01)
        self.assertEqual(pol["book_tag"], "bovada_only")
        self.assertNotEqual(pol["book_tag"], "single_book")
        self.assertEqual((pol["gate_bar"], pol["size_mult"], pol["clears"]), (0.01, 1.0, True))
        full = PE.compute_quantity(5.0, 100.0, 0.30)
        self.assertIs(PE.scale_quantity(full, pol["size_mult"], 0.30), full)  # guidance quantity untouched (16)
        self.assertEqual(full["quantity"], 16)

    def test_bovada_only_below_1c_still_a_pass(self):
        self.assertFalse(L.entry_policy(["bovada"], 0.009, 0.01)["clears"])

    def test_oddsapi_bovada_alone_is_bovada_only(self):
        pol = L.entry_policy(["oddsapi:bovada"], 0.012, 0.01)
        self.assertEqual((pol["book_tag"], pol["gate_bar"], pol["size_mult"]), ("bovada_only", 0.01, 1.0))
        self.assertEqual(L.entry_policy(["bovada", "oddsapi:bovada"], 0.012, 0.01)["book_tag"], "bovada_only")

    def test_pinnacle_only_1_5c_pass_2_1c_half_size(self):
        p15 = L.entry_policy(["pinnacle"], 0.015, 0.01)
        self.assertEqual((p15["book_tag"], p15["gate_bar"], p15["clears"]), ("single_book", 0.02, False))
        p21 = L.entry_policy(["pinnacle"], 0.021, 0.01)
        self.assertEqual((p21["book_tag"], p21["clears"], p21["size_mult"]), ("single_book", True, 0.5))
        self.assertEqual(PE.scale_quantity(PE.compute_quantity(5.0, 100.0, 0.30), p21["size_mult"], 0.30)["quantity"], 8)

    def test_other_new_single_books_are_single_book(self):
        for b in ("draftkings", "oddsapi:fanduel", "oddsapi:pinnacle", "oddsapi:draftkings"):
            self.assertEqual(L.entry_policy([b], 0.03, 0.01)["book_tag"], "single_book", b)

    def test_bovada_plus_new_book_is_multi(self):
        pol = L.entry_policy(["bovada", "pinnacle"], 0.012, 0.01)
        self.assertEqual((pol["book_tag"], pol["gate_bar"], pol["size_mult"], pol["clears"]), ("multi_book", 0.01, 1.0, True))

    def test_default_config_comps_match_main(self):
        """Default sources -> Bovada quotes only -> every side bovada_only with main's 1c bar and full size, and the
        same fair as main's Bovada scorer: decisions identical to main."""
        q = L.parse_bovada(bovada_coupon(), "mlb", NOW)
        g = game_of(q)
        ok, _ = L.eligible_quotes(g, TODAY_START, now=NOW)
        combo = L.combine(g, ok)
        dm = MF.devig_methods(q[0]["ml"])["Tampa Bay Rays"]
        for side in ("yes", "no"):
            f = L.side_fair(combo, "Tampa Bay Rays", side)["used"]
            self.assertEqual(f, MF.conservative_fair(side, dm["power"], dm["shin"], dm["prop"])["used"])
            for em in (0.0099, 0.01, 0.012, 0.019, 0.025):
                pol = L.entry_policy(combo["books"], em, 0.01)
                self.assertEqual(pol["clears"], em >= 0.01)  # main: em >= MIN_EDGE
                self.assertEqual((pol["book_tag"], pol["size_mult"]), ("bovada_only", 1.0))

    def test_sessions_and_passlog_share_policy(self):
        for fn in ("session_daily.py", "session_pm.py"):
            src = (HERE / "oddsborne" / fn).read_text()
            self.assertIn('LINES.entry_policy(combo["books"], em, MIN_EDGE)', src)
            self.assertIn('size_mult = float(pick.get("size_mult")', src)
        lsrc = (HERE / "oddsborne" / "lines.py").read_text()
        self.assertIn("pol = entry_policy(combo[\"books\"], em, min_edge)", lsrc)  # side_rows (passlog)
        psrc = (HERE / "oddsborne" / "session_passlog.py").read_text()
        self.assertIn('r.get("book_tag") == "single_book"', psrc)

    def test_passlog_bovada_only_rows(self):
        ffm = L.fair_for_market(L.group_games(L.parse_bovada(bovada_coupon(), "mlb", NOW)),
                                "Cleveland Guardians", "Tampa Bay Rays", TODAY_START, now=NOW)
        rows = L.side_rows("m", ffm, 0.40, 0.42, 0.02, None, MF.post_fee_maker_raw,
                           lambda f, p: MF.post_fee_maker_gate(f, p, 0.006), MF.post_fee_taker, 0.01, 0.006)
        for r in rows:
            self.assertEqual((r["book_tag"], r["gate_bar"], r["size_mult"]), ("bovada_only", 0.01, 1.0))
            self.assertEqual(r["cand"], r["pf_maker"] >= 0.01 and r["spr"] <= 0.04)


class PasslogMultiBookTests(unittest.TestCase):
    def games(self, **kw):
        q = L.parse_bovada(bovada_coupon(), "mlb", NOW) if kw.get("bovada", True) else []
        if kw.get("pinnacle", True):
            q += L.parse_pinnacle(*pinnacle(), "mlb", NOW)
        return L.group_games(q)

    def fees(self):
        return (MF.post_fee_maker_raw, lambda f, p: MF.post_fee_maker_gate(f, p, 0.006), MF.post_fee_taker)

    def test_multi_book_rows_carry_books(self):
        ffm = L.fair_for_market(self.games(), "Cleveland Guardians", "Tampa Bay Rays", TODAY_START, now=NOW)
        self.assertEqual(ffm["combo"]["books"], ["bovada", "pinnacle"])
        rows = L.side_rows("aec-mlb-tb-cle-2026-10-17", ffm, 0.40, 0.42, 0.02, "2026-10-18T21:08:00Z", *self.fees(), 0.01, 0.006)
        self.assertEqual([r["side"] for r in rows], ["yes", "no"])
        for r in rows:
            self.assertEqual(r["books"], ["bovada", "pinnacle"])
            self.assertEqual(r["book_tag"], "multi_book")
            self.assertEqual(set(r["fair_by_book"]), {"bovada", "pinnacle"})
            meta = L.decision_meta(r)
            self.assertEqual(meta["book_tag"], "multi_book")
            self.assertEqual(meta["books"], ["bovada", "pinnacle"])
        self.assertEqual(rows[0]["team"], "Cleveland Guardians")
        self.assertEqual(rows[1]["team"], "Tampa Bay Rays")

    def test_pinnacle_only_side_is_a_normal_pass_not_no_bovada(self):
        ffm = L.fair_for_market(self.games(bovada=False), "Cleveland Guardians", "Tampa Bay Rays", TODAY_START, now=NOW)
        rows = L.side_rows("m", ffm, 0.40, 0.42, 0.02, None, *self.fees(), 0.01, 0.006)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["books"], ["pinnacle"])
        self.assertEqual(rows[0]["book_tag"], "single_book")
        self.assertIsNone(rows[0]["bovada"])

    def test_zero_books_no_rows(self):
        ffm = L.fair_for_market(self.games(), "Cleveland Guardians", "Tampa Bay Rays", TOMORROW_GST, now=NOW)
        self.assertIsNone(ffm["combo"])
        self.assertEqual({r["reason"] for r in ffm["rejected"]}, {"date_mismatch"})
        self.assertEqual(L.side_rows("m", ffm, 0.4, 0.42, 0.02, None, *self.fees(), 0.01, 0.006), [])

    def test_passlog_wiring(self):
        src = (HERE / "oddsborne" / "session_passlog.py").read_text()
        self.assertIn("LINES.fair_for_market(games, lt, st, gst)", src)
        self.assertIn("LINES.side_rows(", src)
        self.assertIn("meta=LINES.decision_meta(r)", src)
        self.assertNotIn("no date-matched bovada", src)
        self.assertNotIn("parse_bovada_ts", src)
        self.assertIn('return "single_book_size_zero"', src)
        self.assertIn('return "single_book_gate"', src)


if __name__ == "__main__":
    unittest.main()
